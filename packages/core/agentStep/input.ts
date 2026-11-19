import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  authorProfiles,
  channels,
  discoveredPosts,
  dmThreads,
  incomingComments,
  leads,
  conversationEvents,
  conversationSources,
  messages,
  productFacts,
  roomMembers,
  type Campaign,
  type IncomingComment,
  type ConversationEventRow,
  type ConversationRow,
  type ProductFact,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import type { LikeConversation } from "../actions/likeTarget";
import { untrusted } from "../ai/prompts";
import type { ContextTypeId, TargetType } from "../strategy/catalog";
import type { CampaignAgentStrategy, StrategyStep } from "../strategy/contract";
import { delimited } from "../conversations/delimit";
import { memoryForStep, type StepMemory } from "../memory/records";
import { getProfile } from "../profile";
import { resolveCampaignVoice } from "../voice";
import { factFreshness } from "./freshness";
import { audienceProfile } from "../audience/model";
import { roomInviteExchange } from "../rooms/inviteExchange";
import { loadStrategy } from "./select";
import { campaignProductId } from "../products/queries";
import { conversationCorrelation } from "./wait";
import { authorIdentity } from "../people/key";

/**
 * A STEP'S INPUT, built from the contexts its strategy names and nothing
 * else (spec §04 "do not automatically attach every campaign or person
 * record"; §18 R16, minimized and delimited). Every span another person wrote
 * or a page said reaches the model through a fence (`untrusted`, and 44's
 * `delimited` for a conversation's events), so nothing in it reads as an
 * instruction (INV-30).
 *
 * The conversation is the one conversation the server froze for this step: the
 * post, our comment, and the person's replies under it as the thread reads
 * recorded them on the conversation (43's rows, 44's events). Nothing reaches it
 * from a notification, an inbox digest or another person's thread — the
 * builder has no such source. Credentials, emails and every other conversation
 * stay out by construction: no column of theirs is selected.
 */

export type StepInput = {
  /** The rendered contexts, as the model reads them. */
  text: string;
  /** SHA-256 of `text` — what the result must echo. */
  version: string;
  /** `event:<id>@<content hash>` — the words the step answers. */
  evidenceVersion: string;
  /** Each context the step was handed, with the item ids it carries. */
  context: Partial<Record<ContextTypeId, string[]>>;
  /** What this conversation can aim at, by kind. */
  targets: Partial<Record<TargetType, string[]>>;
  /** Refs the result may cite. */
  evidence: Set<string>;
  /** Contexts the step needs and the conversation could not supply. */
  missing: ContextTypeId[];
  /** The reply under our comment the step answers, as it stands. */
  incoming: IncomingComment | null;
  /** What a dispatched `read_thread` and `read_profile` return. */
  thread: string | null;
  profile: string;
  /** Their conversation with the account, as a DM is drafted from; null
   *  where no read has bound one. */
  conversation: string | null;
  /** What the account remembers that the step was handed, by id and
   *  version, and their digest — what its drafts and sends rest on. */
  memory: Pick<StepMemory, "refs" | "version">;
};

const FIT = { strong: "Strong fit", fits: "Fits", weak: "Weak fit" } as const;

/** Scout's research of the person a conversation is with: their fit, who
 *  they are and why, as stored. Their own text is fenced; a person nobody has
 *  researched says so. */
async function renderResearch(tx: Tx, profileId: string): Promise<string> {
  const [lead] = await tx.select().from(leads).where(eq(leads.profileId, authorIdentity(profileId)));
  if (!lead || lead.researchedAt === null) return "RESEARCH\nNot researched: nobody has read their profile.";
  const [author] = await tx
    .select({ read: authorProfiles.profileRead })
    .from(authorProfiles)
    .where(eq(authorProfiles.profileId, lead.profileId));
  const role = author?.read?.currentRole;
  const theirs = [
    lead.headline?.trim() ? `Headline: ${lead.headline.trim()}` : null,
    role?.title?.trim() || role?.company?.trim() ? `Current role: ${[role.title, role.company].map((part) => part?.trim()).filter(Boolean).join(" at ")}` : null,
    ...(lead.qualification?.reasons ?? []).map((reason) => `Why: ${reason.text}`),
  ].filter((line): line is string => line !== null);
  return [
    `RESEARCH (Scout's read of this person, ${DATE(lead.researchedAt)})`,
    `Fit: ${lead.fit === null ? "not rated" : FIT[lead.fit]}`,
    `Role: ${lead.role ?? "not judged"}`,
    ...(theirs.length === 0 ? [] : [untrusted("WHO THEY ARE", theirs.join("\n"))]),
  ].join("\n");
}

const DATE = (at: number | null) =>
  at === null ? "never" : new Date(at).toISOString().slice(0, 10);

/** An instant as the owner reads it — weekday, date and time in their zone,
 *  with the offset — so a step can name a time ("wake me Tuesday at nine")
 *  against the moments the messages were written. */
export function ownerTime(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).format(new Date(at));
}

export async function buildStepInput(
  tx: Tx,
  input: {
    step: StrategyStep;
    campaign: Campaign;
    /** The campaign's memory bindings: the scopes its steps may read. */
    memoryBindings: CampaignAgentStrategy["memory_bindings"];
    conversation: ConversationRow;
    event: ConversationEventRow;
    now: number;
  },
): Promise<StepInput> {
  const { step, campaign, conversation, event, now } = input;
  const sections: string[] = [];
  const context: StepInput["context"] = {};
  const missing: ContextTypeId[] = [];
  const evidence = new Set<string>();

  const ref = event.sourceRef;
  const [incoming] = ref.incomingCommentId
    ? await tx
        .select()
        .from(incomingComments)
        .where(eq(incomingComments.id, ref.incomingCommentId))
    : [];
  const zone = await ownerZone(tx, conversation.channelId);
  const at = (instant: number) => ownerTime(instant, zone);
  sections.push(`TIME\nNow: ${at(now)} (the owner's time zone: ${zone})`);
  const thread = await renderThread(tx, conversation, event, incoming ?? null, at);
  let roomThread = ref.room ? await renderRoomThread(tx, campaign, event) : null;
  if (!roomThread && step.catalog_step === "meet_the_room" && !ref.room) {
    const strategy = await loadStrategy(tx, campaign);
    const exchange = strategy ? await roomInviteExchange(tx, { campaignId: campaign.id, conversationId: conversation.id,
      eventId: event.id, strategy }) : null;
    if (exchange) roomThread = { text: exchange.text, profile: "" };
  }
  const dmHistory = await renderConversation(tx, conversation, at);

  for (const contextRef of step.context_refs) {
    switch (contextRef) {
      case "room_thread": {
        if (!roomThread) {
          missing.push(contextRef);
          break;
        }
        sections.push(`ROOM THREAD\n${roomThread.text}`);
        context.room_thread = [String(event.id)];
        evidence.add(`event:${event.id}`);
        break;
      }
      case "verified_thread": {
        if (!thread) {
          missing.push(contextRef);
          break;
        }
        sections.push(`VERIFIED THREAD\n${thread.text}`);
        context.verified_thread = thread.eventIds.map(String);
        for (const id of thread.eventIds) evidence.add(`event:${id}`);
        break;
      }
      case "campaign_voice": {
        const voice = await resolveCampaignVoice(tx, campaign, await getProfile(tx), "comment");
        const lines = [
          voice.persona?.trim() ? `Persona: ${voice.persona.trim()}` : null,
          voice.houseStyle?.trim() ? `House style: ${voice.houseStyle.trim()}` : null,
        ].filter((line): line is string => line !== null);
        sections.push(
          `CAMPAIGN VOICE (the owner's; the drafter applies it)\n${lines.join("\n") || "The account's default voice."}`,
        );
        context.campaign_voice = [];
        break;
      }
      case "product_facts": {
        const facts = await campaignFacts(tx, campaign.id);
        sections.push(
          facts.length === 0
            ? "PRODUCT FACTS\nNone attached to this campaign: claim nothing about a product."
            : untrusted("PRODUCT FACTS (cite by id; a STALE fact may not be claimed)", factLines(facts, now)),
        );
        context.product_facts = facts.map((fact) => String(fact.id));
        for (const fact of facts) evidence.add(`fact:${fact.id}`);
        break;
      }
      case "dm_thread": {
        if (!dmHistory) {
          missing.push(contextRef);
          break;
        }
        sections.push(`DIRECT MESSAGES (their conversation with this account, oldest first)\n${dmHistory.text}`);
        context.dm_thread = dmHistory.eventIds.map(String);
        for (const id of dmHistory.eventIds) evidence.add(`event:${id}`);
        break;
      }
      case "relationship_state":
        sections.push(
          [
            "RELATIONSHIP (server reads only; nothing here is a model's guess)",
            `Connection: ${conversation.relationship} (checked ${DATE(conversation.relationshipCheckedAt)})`,
            `Stage: ${conversation.derivedStage}`,
            `Interest shown in their own words: ${conversation.interestEvidenceEventId === null ? "no" : `yes (event:${conversation.interestEvidenceEventId})`}`,
          ].join("\n"),
        );
        if (conversation.interestEvidenceEventId !== null) {
          evidence.add(`event:${conversation.interestEvidenceEventId}`);
        }
        context.relationship_state = [];
        break;
      case "campaign_brief": {
        const brief = campaign.compiledBrief?.brief?.trim();
        sections.push(`CAMPAIGN BRIEF\n${brief || "None compiled."}`);
        context.campaign_brief = [];
        break;
      }
      case "research_snapshot":
        // Scout's read of the person, where it made one: who they are and
        // how well they fit, which the thread alone does not say.
        sections.push(await renderResearch(tx, conversation.authorProfileId));
        context.research_snapshot = [];
        break;
      case "audience_spec":
        // The audience is what Scout searches by; a conversation step is
        // handed the thread instead.
        sections.push(`${contextRef.toUpperCase()}\nNot available to a conversation step.`);
        context[contextRef] = [];
        break;
    }
  }

  // In the text, so the input's version moves with what is remembered.
  const memory = await memoryForStep(tx, {
    bindings: input.memoryBindings,
    conversation,
    campaignId: campaign.id,
    stepId: step.step_id,
  });
  sections.push(memory.text ?? "MEMORY\nThis campaign keeps no memory for its steps.");
  const text = sections.join("\n\n");

  const targets: StepInput["targets"] = {
    person: [conversation.authorProfileId],
    dm_thread: [conversationCorrelation(conversation.id)],
  };
  if (thread) {
    if (ref.commentUrn) targets.their_reply = [ref.commentUrn];
    if (ref.postUrn) targets.post = [ref.postUrn];
    if (thread.ourCommentUrn) targets.replied_comment = [thread.ourCommentUrn];
  }
  if (roomThread && ref.room) targets.room_comment = [ref.room.target.parentCommentUrn];

  const [profile] = await tx
    .select({ headline: authorProfiles.headline })
    .from(authorProfiles)
    .where(eq(authorProfiles.profileId, conversation.authorProfileId));
  return {
    text,
    version: createHash("sha256").update(text, "utf8").digest("hex"),
    evidenceVersion: `event:${event.id}@${event.sourceRef.room?.evidenceHash ?? event.contentHash ?? "none"}`,
    context,
    targets,
    evidence,
    missing,
    incoming: incoming ?? null,
    thread: roomThread?.text ?? thread?.text ?? null,
    conversation: dmHistory?.text ?? null,
    memory: { refs: memory.refs, version: memory.version },
    profile: roomThread?.profile || untrusted(
      "THEIR PROFILE",
      [incoming?.authorName ?? null, profile?.headline ?? null]
        .filter((part): part is string => Boolean(part?.trim()))
        .join(" — ") || "Nothing read about them.",
    ),
  };
}

async function renderRoomThread(tx: Tx, campaign: Campaign, event: ConversationEventRow) {
  const binding = event.sourceRef.room;
  if (!binding || binding.campaignId !== campaign.id || binding.channelId !== campaign.channelId ||
    binding.target.audienceRevision !== campaign.audienceRevision) return null;
  const [row] = await tx.select({ member: roomMembers, post: discoveredPosts }).from(roomMembers)
    .innerJoin(discoveredPosts, eq(discoveredPosts.id, roomMembers.discoveredPostId))
    .where(and(eq(roomMembers.id, binding.target.roomMemberId), eq(discoveredPosts.campaignId, campaign.id),
      eq(roomMembers.snapshotId, binding.target.snapshotId)));
  const comment = row?.member.comments.find((entry) => entry.commentUrn === binding.target.parentCommentUrn &&
    entry.memberUrn === binding.target.memberUrn);
  const pain = audienceProfile(campaign).pains.find((entry) => entry.id === binding.painId && entry.status === "active");
  if (!row || !comment || !pain) return null;
  const profile = untrusted("THEIR PROFILE", [row.member.name, row.member.headline].filter(Boolean).join(" — "));
  return { profile, text: [
    `Bound evidence: event:${event.id}; snapshot:${binding.target.snapshotId}; Audience revision ${binding.target.audienceRevision}`,
    untrusted("POST AUTHOR AND OPENING", `${row.post.authorName ?? "Unknown author"}\n${(row.post.contentText ?? "").slice(0, 2000)}`),
    profile,
    untrusted("THEIR SELECTED COMMENT", comment.text),
    untrusted("THE PAIN THEY VOICED", pain.text),
    untrusted("RESEARCH'S REASON", row.member.reason ?? ""),
  ].join("\n\n") };
}

/**
 * What a like's selector can name in this conversation (`likeTargetFor`): the
 * targets the input was built with, the reply carrying the person the conversation
 * is about and the words the step was handed. Nothing the model proposed.
 */
export function likeConversation(
  input: Pick<StepInput, "targets">,
  conversation: Pick<ConversationRow, "authorProfileId">,
  event: Pick<ConversationEventRow, "contentHash">,
): LikeConversation {
  const reply = input.targets.their_reply?.[0];
  return {
    postUrn: input.targets.post?.[0] ?? null,
    reply: reply
      ? { urn: reply, authorProfileId: conversation.authorProfileId, textHash: event.contentHash }
      : null,
    repliedTo: input.targets.replied_comment?.[0] ?? null,
  };
}

/** Product facts in the form every call cites them by: each one's id, facet,
 *  source, the day it was last checked and whether it is fresh or STALE, then
 *  the fact itself. A STALE fact may not be claimed. */
export function factLines(
  facts: ReadonlyArray<Pick<ProductFact, "id" | "facet" | "source" | "content" | "updatedAt">>,
  now: number,
): string {
  return facts
    .map((fact) => {
      const freshness = factFreshness(fact, now);
      return `[fact:${fact.id}] ${fact.facet} · ${fact.source} · checked ${DATE(freshness.checkedAt)} · ${freshness.stale ? "STALE" : "fresh"}\n${fact.content}`;
    })
    .join("\n\n");
}

/** The facts of the product a campaign's drafts use, ids ascending. */
export async function campaignFacts(
  tx: Tx,
  campaignId: number,
): Promise<ProductFact[]> {
  const productId = await campaignProductId(tx, campaignId);
  if (productId === null) return [];
  return tx
    .select()
    .from(productFacts)
    .where(eq(productFacts.productId, productId))
    .orderBy(asc(productFacts.id));
}

/** The owner's zone: the account's — the one its active hours are kept in. */
async function ownerZone(tx: Tx, channelId: number): Promise<string> {
  const [channel] = await tx
    .select({ activeHours: channels.activeHours })
    .from(channels)
    .where(eq(channels.id, channelId));
  return channel?.activeHours?.tz || "UTC";
}

/** The person's conversation with the account as a DM is drafted from, dated
 *  in the owner's zone — or null where none is bound for one to go into.
 *  What the owner's own agent writes their DM from (`chat/requestedDm.ts`). */
export async function conversationConversation(tx: Tx, conversation: ConversationRow): Promise<string | null> {
  const zone = await ownerZone(tx, conversation.channelId);
  return (await renderConversation(tx, conversation, (instant) => ownerTime(instant, zone)))?.text ?? null;
}

/** The most messages of a conversation a step is handed: the newest. */
export const CONVERSATION_MESSAGES = 30;

/**
 * The person's conversation with the account, from the rows its reads and
 * sends wrote: the exchange under our comment that led to it, where there was
 * one — their latest reply there — then the messages, theirs and ours,
 * oldest first, at most {@link CONVERSATION_MESSAGES}. Null when no read has
 * bound a DM thread to the conversation, or the one bound is the owner's own,
 * held for them from the inbox list (`conversations/dm.ts`): there is nothing to
 * answer in, and nothing to send into.
 */
async function renderConversation(
  tx: Tx,
  conversation: ConversationRow,
  at: (instant: number) => string,
): Promise<{ text: string; eventIds: number[] } | null> {
  if (conversation.canonicalDmThreadId === null) return null;
  const [bound] = await tx
    .select({ heldAt: dmThreads.ownerHeldAt })
    .from(dmThreads)
    .where(eq(dmThreads.id, conversation.canonicalDmThreadId));
  if (bound?.heldAt != null) return null;
  const newer = alias(conversationEvents, "newer");
  const current = notExists(
    tx.select({ id: newer.id }).from(newer).where(eq(newer.supersedesEventId, conversationEvents.id)),
  );
  const [exchange] = await tx
    .select()
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, conversation.id),
        inArray(conversationEvents.type, ["reply_observed", "reply_edited"]),
        current,
      ),
    )
    .orderBy(desc(conversationEvents.occurredAt), desc(conversationEvents.id))
    .limit(1);
  const messages = (
    await tx
      .select()
      .from(conversationEvents)
      .where(
        and(
          eq(conversationEvents.conversationId, conversation.id),
          inArray(conversationEvents.type, ["inbound_message_observed", "dm_confirmed"]),
        ),
      )
      .orderBy(desc(conversationEvents.occurredAt), desc(conversationEvents.id))
      .limit(CONVERSATION_MESSAGES)
  ).reverse();
  const parts = [
    exchange
      ? `THE EXCHANGE THAT LED HERE [event:${exchange.id} · ${at(exchange.occurredAt)}]\n${delimited(exchange)}`
      : null,
    messages.length === 0
      ? "No message in the conversation yet."
      : messages
          .map((message) => `[event:${message.id} · ${at(message.occurredAt)}]\n${delimited(message)}`)
          .join("\n"),
  ].filter((part): part is string => part !== null);
  return {
    text: parts.join("\n"),
    eventIds: [...(exchange ? [exchange.id] : []), ...messages.map((message) => message.id)],
  };
}

/**
 * The thread the event belongs to, from the rows the thread reads wrote: the
 * post, our comment, and every reply of the person's recorded on this conversation
 * under that comment, oldest first, each at its latest revision. Null when the
 * thread is no longer verifiable — our comment is gone, or the reply was
 * deleted or its source tombstoned.
 */
async function renderThread(
  tx: Tx,
  conversation: ConversationRow,
  event: ConversationEventRow,
  incoming: IncomingComment | null,
  at: (instant: number) => string,
): Promise<{ text: string; eventIds: number[]; ourCommentUrn: string | null } | null> {
  const ref = event.sourceRef;
  if (!incoming || incoming.removedAt !== null || ref.messageId === undefined) return null;
  const [source] = await tx
    .select({ deletedAt: conversationSources.deletedAt })
    .from(conversationSources)
    .where(eq(conversationSources.incomingCommentId, incoming.id));
  if (!source || source.deletedAt !== null) return null;
  const [ours] = await tx
    .select({
      text: sql<string>`coalesce(${messages.finalText}, ${messages.proposedText})`,
      externalUrn: messages.externalUrn,
      postText: discoveredPosts.contentText,
      postAuthor: discoveredPosts.authorName,
    })
    .from(messages)
    .leftJoin(discoveredPosts, eq(discoveredPosts.id, sql<number>`coalesce(${messages.discoveredPostId}, ${incoming.discoveredPostId})`))
    .where(eq(messages.id, ref.messageId));
  if (!ours) return null;

  const newer = alias(conversationEvents, "newer");
  const replies = await tx
    .select()
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, conversation.id),
        inArray(conversationEvents.type, ["reply_observed", "reply_edited"]),
        sql`(${conversationEvents.sourceRef}->>'messageId')::bigint = ${ref.messageId}`,
        notExists(
          tx
            .select({ id: newer.id })
            .from(newer)
            .where(eq(newer.supersedesEventId, conversationEvents.id)),
        ),
      ),
    )
    .orderBy(asc(conversationEvents.occurredAt), asc(conversationEvents.id));
  const parts = [
    ours.postText
      ? untrusted("THE POST", `${ours.postAuthor ? `By ${ours.postAuthor}\n` : ""}${ours.postText}`)
      : null,
    untrusted("OUR COMMENT (the owner's account wrote this)", ours.text),
    ...replies.map((reply) => `[event:${reply.id} · ${at(reply.occurredAt)}]\n${delimited(reply)}`),
  ].filter((part): part is string => part !== null);
  return {
    text: parts.join("\n"),
    eventIds: replies.map((reply) => reply.id),
    ourCommentUrn: ref.parentUrn ?? ours.externalUrn ?? null,
  };
}
