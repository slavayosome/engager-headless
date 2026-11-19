import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  actions,
  authorProfiles,
  campaigns,
  discoveredPosts,
  dmThreads,
  engagedProfiles,
  conversationEvents,
  conversationSources,
  conversations,
  messages,
  outcomeEvents,
  stepRuns,
  type ActionKind,
  type ActionStatus,
  type ConversationEventRow,
  type ConversationEventType,
  type ConversationRow,
  type StepRunStatus,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { conversationPersonName, scheduledWakes, type WakeView } from "../agentStep/wakes";
import { MESSAGE_INTENTS, type MessageIntent } from "./classify";

/**
 * ONE PERSON'S CONVERSATION WITH THE ACCOUNT, as the owner reads it on its own
 * page: who they are, where the conversation stands, every wake still to come, and
 * the thread — their replies and messages, ours, every action proposed or
 * taken toward them, and each decision a step drew from it with the step's
 * own summary and the words of theirs a wake rests on. Reads only.
 *
 * The person's words are verbatim and untrusted: a surface renders them as
 * text, and nothing here fences them, because nothing here hands them to a
 * model.
 */

/** The most of a conversation's log the page reads: the newest. */
export const CONVERSATION_EVENTS = 200;

export type ConversationPerson = {
  profileId: string;
  /** By the name their latest reply carried, else the list's, else their
   *  conversation's. */
  name: string | null;
  headline: string | null;
  /** Their profile page, as the account's own records have it. */
  profileUrl: string | null;
  /** On the account's do-not-engage list. */
  excluded: boolean;
};

type Entry<K extends string, T> = { key: string; at: number; kind: K } & T;

export type ConversationEntry =
  | Entry<"our_comment", { messageId: number; text: string; postAuthor: string | null }>
  | Entry<
      "their_reply",
      { eventId: number; text: string | null; edited: boolean; removed: boolean }
    >
  | Entry<"their_message", { eventId: number; text: string | null; intent: MessageIntent | null }>
  | Entry<
      "our_reply",
      {
        messageId: number;
        text: string;
        status: (typeof messages.$inferSelect)["status"];
        publishOrigin: (typeof messages.$inferSelect)["publishOrigin"];
      }
    >
  /** A message of ours the conversation holds without a ledger row behind it. */
  | Entry<"our_message", { eventId: number; text: string | null }>
  | Entry<
      "action",
      {
        actionId: number;
        action: ActionKind;
        targetKind: string;
        status: ActionStatus;
        /** The note or the message it carries; null for a like or an
         *  acceptance. */
        text: string | null;
        origin: "owner" | "worker";
      }
    >
  | Entry<
      "decision",
      {
        stepRunId: number;
        stepId: string;
        status: StepRunStatus;
        /** The step's own one-line summary; null when it gave none, or when a
         *  forgotten memory took it out. */
        rationale: string | null;
        /** The person's words a wake it set rests on, verbatim. */
        quote: string | null;
        wakeAt: number | null;
        redacted: boolean;
      }
    >
  | Entry<"event", { eventId: number; type: ConversationEventType }>;

export type ConversationView = {
  conversation: ConversationRow;
  person: ConversationPerson;
  /** The campaign that started it, then every other its replies came in
   *  under. */
  campaigns: Array<{ id: number; name: string }>;
  /** The words of theirs that show explicit interest, where some do. */
  interest: { eventId: number; at: number; quote: string | null } | null;
  ctaOfferedAt: number | null;
  outcomeAt: number | null;
  /** Soonest first; their next message wakes it sooner. */
  wakes: WakeView[];
  /** Oldest first. */
  timeline: ConversationEntry[];
};

/** Events the timeline names as a fact of their own. Their words and ours are
 *  entries of their own kinds; a send's receipt is its ledger row's; the rest
 *  is a decision's bookkeeping, not something that happened between them. */
const FACTS: ReadonlySet<ConversationEventType> = new Set([
  "relationship_observed",
  "invitation_accepted",
  "incoming_invitation_observed",
  "delivery_unknown",
  "booking_verified",
  "activation_verified",
  "payment_verified",
  "opt_out",
  "manual_exclude",
  "warning",
  "person_reopened",
]);

export async function readConversation(tx: Tx, conversationId: number): Promise<ConversationView | null> {
  const [found] = await tx
    .select({ conversation: conversations, replyName: conversationPersonName })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  if (!found) return null;
  const { conversation } = found;

  const events = (
    await tx
      .select()
      .from(conversationEvents)
      .where(eq(conversationEvents.conversationId, conversation.id))
      .orderBy(desc(conversationEvents.occurredAt), desc(conversationEvents.id))
      .limit(CONVERSATION_EVENTS)
  ).reverse();
  const ledger = await tx
    .select()
    .from(actions)
    .where(eq(actions.conversationId, conversation.id))
    .orderBy(asc(actions.createdAt), asc(actions.id));
  const checkpoints = await tx
    .select()
    .from(stepRuns)
    .where(eq(stepRuns.conversationId, conversation.id))
    .orderBy(asc(stepRuns.startedAt), asc(stepRuns.id));
  const sources = await tx
    .select({
      incomingCommentId: conversationSources.incomingCommentId,
      campaignId: conversationSources.campaignId,
      deletedAt: conversationSources.deletedAt,
    })
    .from(conversationSources)
    .where(eq(conversationSources.conversationId, conversation.id))
    .orderBy(asc(conversationSources.id));

  const ourComments = await commentsAnswered(tx, events);
  const ourReplies =
    sources.length === 0
      ? []
      : await tx
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.kind, "reply"),
              inArray(
                messages.incomingCommentId,
                sources.map((source) => source.incomingCommentId),
              ),
            ),
          )
          .orderBy(asc(messages.createdAt), asc(messages.id));

  const removed = new Set(
    sources.flatMap((source) => (source.deletedAt === null ? [] : [source.incomingCommentId])),
  );
  const superseded = new Set(
    events.flatMap((event) => (event.supersedesEventId === null ? [] : [event.supersedesEventId])),
  );
  const ledgered = new Set(ledger.map((action) => action.id));
  const timeline: ConversationEntry[] = [
    ...ourComments.map(
      (comment): ConversationEntry => ({
        key: `message:${comment.id}`,
        at: comment.at,
        kind: "our_comment",
        messageId: comment.id,
        text: comment.text,
        postAuthor: comment.postAuthor,
      }),
    ),
    ...events.flatMap((event) => eventEntry(event, { superseded, ledgered, removed })),
    ...ourReplies.map(
      (message): ConversationEntry => ({
        key: `message:${message.id}`,
        at: message.postedAt ?? message.createdAt,
        kind: "our_reply",
        messageId: message.id,
        text: message.finalText ?? message.proposedText,
        status: message.status,
        publishOrigin: message.publishOrigin,
      }),
    ),
    ...ledger.map(
      (action): ConversationEntry => ({
        key: `action:${action.id}`,
        at: action.status === "confirmed" ? (action.settledAt ?? action.createdAt) : action.createdAt,
        kind: "action",
        actionId: action.id,
        action: action.kind,
        targetKind: action.target.kind,
        status: action.status,
        text: action.candidate.text,
        origin: action.origin,
      }),
    ),
    ...checkpoints.map(
      (checkpoint): ConversationEntry => ({
        key: `step:${checkpoint.id}`,
        at: checkpoint.finishedAt ?? checkpoint.startedAt,
        kind: "decision",
        stepRunId: checkpoint.id,
        stepId: checkpoint.stepId,
        status: checkpoint.status,
        rationale: checkpoint.rationaleSummary,
        quote: checkpoint.wait?.quote ?? null,
        wakeAt: checkpoint.wait?.onTimeout === "wake" ? checkpoint.wait.expiresAt : null,
        redacted: checkpoint.redactedAt !== null,
      }),
    ),
  ].sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));

  const campaignIds = [
    ...new Set([
      ...(conversation.owningCampaignId === null ? [] : [conversation.owningCampaignId]),
      ...sources.flatMap((source) => (source.campaignId === null ? [] : [source.campaignId])),
    ]),
  ];
  const named =
    campaignIds.length === 0
      ? []
      : await tx
          .select({ id: campaigns.id, name: campaigns.name })
          .from(campaigns)
          .where(inArray(campaigns.id, campaignIds));

  return {
    conversation,
    person: await person(tx, conversation, found.replyName),
    campaigns: campaignIds.flatMap((id) => named.filter((campaign) => campaign.id === id)),
    interest: await interestOf(tx, conversation),
    ctaOfferedAt: await outcomeAt(tx, conversation.ctaEventId),
    outcomeAt: await outcomeAt(tx, conversation.outcomeEventId),
    wakes: await scheduledWakes(tx, { conversationIds: [conversation.id] }),
    timeline,
  };
}

/** One event as the timeline names it, or nothing: an older revision of a
 *  reply gives way to the newer, and a send's receipt to its ledger row. */
function eventEntry(
  event: ConversationEventRow,
  seen: {
    superseded: ReadonlySet<number>;
    ledgered: ReadonlySet<number>;
    removed: ReadonlySet<number>;
  },
): ConversationEntry[] {
  const base = { key: `event:${event.id}`, at: event.occurredAt, eventId: event.id };
  switch (event.type) {
    case "reply_observed":
    case "reply_edited":
      if (seen.superseded.has(event.id)) return [];
      return [
        {
          ...base,
          kind: "their_reply",
          text: event.content,
          edited: event.type === "reply_edited",
          removed:
            event.sourceRef.incomingCommentId !== undefined &&
            seen.removed.has(event.sourceRef.incomingCommentId),
        },
      ];
    case "inbound_message_observed":
      return [{ ...base, kind: "their_message", text: event.content, intent: intentOf(event) }];
    case "dm_confirmed":
    case "invitation_confirmed": {
      const action = event.sourceRef.actionExecutionId;
      if (action !== undefined && seen.ledgered.has(action)) return [];
      return event.type === "dm_confirmed"
        ? [{ ...base, kind: "our_message", text: event.content }]
        : [{ ...base, kind: "event", type: event.type }];
    }
    default:
      return FACTS.has(event.type) ? [{ ...base, kind: "event", type: event.type }] : [];
  }
}

/** How the classifier read a message of theirs, where it said. */
export function intentOf(event: Pick<ConversationEventRow, "decision">): MessageIntent | null {
  const intent = (event.decision as { intent?: unknown } | null)?.intent;
  return typeof intent === "string" && (MESSAGE_INTENTS as readonly string[]).includes(intent)
    ? (intent as MessageIntent)
    : null;
}

/** The comments of ours their replies answered, each once. */
async function commentsAnswered(
  tx: Tx,
  events: readonly ConversationEventRow[],
): Promise<Array<{ id: number; at: number; text: string; postAuthor: string | null }>> {
  const ids = [
    ...new Set(
      events.flatMap((event) =>
        (event.type === "reply_observed" || event.type === "reply_edited") &&
        event.sourceRef.messageId !== undefined
          ? [event.sourceRef.messageId]
          : [],
      ),
    ),
  ];
  if (ids.length === 0) return [];
  const rows = await tx
    .select({
      id: messages.id,
      finalText: messages.finalText,
      proposedText: messages.proposedText,
      postedAt: messages.postedAt,
      createdAt: messages.createdAt,
      postAuthor: discoveredPosts.authorName,
    })
    .from(messages)
    .leftJoin(discoveredPosts, eq(discoveredPosts.id, messages.discoveredPostId))
    .where(inArray(messages.id, ids));
  return rows.map((row) => ({
    id: row.id,
    at: row.postedAt ?? row.createdAt,
    text: row.finalText ?? row.proposedText,
    postAuthor: row.postAuthor,
  }));
}

async function person(tx: Tx, conversation: ConversationRow, replyName: string | null): Promise<ConversationPerson> {
  const [listed] = await tx
    .select()
    .from(engagedProfiles)
    .where(eq(engagedProfiles.profileId, conversation.authorProfileId));
  const [profile] = await tx
    .select({ headline: authorProfiles.headline, evidence: authorProfiles.identityEvidence })
    .from(authorProfiles)
    .where(eq(authorProfiles.profileId, conversation.authorProfileId));
  const [thread] =
    conversation.canonicalDmThreadId === null
      ? []
      : await tx
          .select({ participants: dmThreads.participants })
          .from(dmThreads)
          .where(eq(dmThreads.id, conversation.canonicalDmThreadId));
  const inThread = thread?.participants.find(
    (participant) => !participant.isSelf && participant.profileId === conversation.authorProfileId,
  );
  return {
    profileId: conversation.authorProfileId,
    name: replyName ?? listed?.name ?? inThread?.displayName ?? null,
    headline: profile?.headline ?? listed?.headline ?? null,
    profileUrl: listed?.url ?? profile?.evidence?.read.profile.url ?? inThread?.profileUrl ?? null,
    excluded: listed?.doNotEngage ?? false,
  };
}

/** The interest evidence: the event, and the words of it the classifier
 *  quoted for interest, where it quoted some. Read by its id — it may be
 *  older than the newest page of the log. */
async function interestOf(tx: Tx, conversation: ConversationRow): Promise<ConversationView["interest"]> {
  if (conversation.interestEvidenceEventId === null) return null;
  const [event] = await tx
    .select()
    .from(conversationEvents)
    .where(eq(conversationEvents.id, conversation.interestEvidenceEventId));
  if (!event) return null;
  const span = event.evidenceSpans.find((candidate) => candidate.label === "interest");
  return {
    eventId: event.id,
    at: event.occurredAt,
    quote: span && event.content !== null ? event.content.slice(span.start, span.end) : null,
  };
}

async function outcomeAt(tx: Tx, outcomeEventId: number | null): Promise<number | null> {
  if (outcomeEventId === null) return null;
  const [row] = await tx
    .select({ occurredAt: outcomeEvents.occurredAt })
    .from(outcomeEvents)
    .where(eq(outcomeEvents.id, outcomeEventId));
  return row?.occurredAt ?? null;
}
