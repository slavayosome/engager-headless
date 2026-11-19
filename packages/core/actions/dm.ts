import { and, eq, gte, inArray, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  actions,
  channels,
  dmThreads,
  conversationEvents,
  conversations,
  messages,
  type ActionCandidate,
  type ActionRow,
  type ActionTarget,
  type DmThreadRow,
  type ConversationEventRow,
  type ConversationRow,
  type OfferBinding,
} from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { readAccountDefault } from "../strategy/activate";
import { NETWORK_CATALOGS } from "../strategy/catalog";
import type { CampaignAgentStrategy } from "../strategy/contract";
import { inheritedStrategies, inheritedGroup } from "../strategy/inherit";
import type {
  ActionOperation,
  ActionReceipt,
  ActionSurface,
  Preflight,
} from "../execution/actionGate";
import { knownMemberProfiles, knownMembers, recordThreadRead, samePerson, unrecordedInbound } from "../conversations/dm";
import type { DmPolicy } from "../conversations/eligibility";
import { recordDmConfirmed, recordInviteNoteCarried } from "../conversations/record";
import {
  ConversationHistorySchema,
  DmReceiptSchema,
  OpenDmReceiptSchema,
} from "../linkedin/browser-use/protocol";
import { isConnectorBackoff, isConnectorSignIn } from "../linkedin/connectorError";
import {
  dmWordsHash,
  type DmThreadRead,
  type KnownMember,
  type OpenDmResult,
  type SendDmResult,
} from "../linkedin/driver";
import { approvedOffer, unsupportedOfferClaim } from "../products/offers";
import { pauseChannelForConnectorBackoff } from "../ratelimit/killswitch";
import { reserveResearchRead } from "../ratelimit/ledger";
import { conversationInvite, noteOf, noteSpokenIn } from "./inviteNote";
import { reserveAction, type ReserveOutcome } from "./ledger";
import { takeOverConversation } from "./takeover";

/**
 * DM AND FOLLOW-UP — the Ambassador's DM and Follow-up, its Message after they accept
 * step's sends, on the action ledger (Phase 53; spec §07 `send_dm`, §10
 * R05–R07, §11 R08 `DMConfirmed`, §13, §17 R13 "Read and send DMs"; INV-27,
 * INV-28, INV-31, INV-10, INV-1).
 *
 * A DM goes only into the person's one conversation a read has bound to their
 * conversation (`conversations/dm.ts`), always waiting for the owner's yes (the
 * step's mode is `review`). What it is for is the server's, never the model's
 * ({@link decideDm}):
 *
 *   reply    answers an inbound event of theirs — their DM, or the public
 *            reply whose own words showed interest — and only once interest
 *            stands: later sales DMs require it (R06)
 *   opener   the one contextual DM after their verified, comment-linked
 *            invitation was accepted, where the campaign turned it on — an
 *            opener is always the first, so after an invitation of ours its
 *            note already was (`actions/keys.ts`)
 *   cta      the offer, only after enough relevant exchanges, from an
 *            approved CTA asset (R06, R14)
 *   invite_note  the note of the invitation they accepted, as the
 *            conversation's first message where LinkedIn did not carry it.
 *            No step proposes it: the acceptance's read of the conversation
 *            reserves it at the DM step's mode (`actions/inviteNote.ts`), and
 *            the send's own preflight sends nothing if its words are there by
 *            then
 *
 * Accepting an invitation is never a reason to send one: an acceptance with
 * no interest and `wait_for_interest` reserves nothing (R05).
 *
 * Its sequence is the count of DMs to the person confirmed on the conversation,
 * plus one. The per-person cap counts every DM Engager sent the person in the
 * rolling 720 hours — openers, answers, offers, follow-ups, on any conversation —
 * and refuses only unattended work at it (INV-1): a DM whose words the owner
 * wrote is counted and only spaced. A cap the owner never set is no licence:
 * null never means unlimited (spec §13).
 *
 * Nothing of ours follows our own unanswered message but a follow-up
 * ({@link decideFollowup}): a DM of kind `followup`, never carrying an offer.
 * WHEN to nudge is the step's to decide — it waits, wakes at a time it chose
 * or the person named, reads the conversation afresh and decides again
 * (`agentStep/wait.ts`). The server only bounds it: not before the campaign's
 * `followup.delay_hours` after our unanswered message unless their own quoted
 * words named the time it woke at, and at most one unanswered in a row.
 *
 * The browser half ({@link directMessageOperation}) rides the sidecar's
 * `send_dm` on the write journal:
 *
 *   preflight  the conversation read in this session, metered as a thread
 *              read and recorded on the conversation: exactly the account and the
 *              person, nothing new from them, nothing of the owner's — a
 *              draft in the composer or a message they sent hands them the
 *              conversation — and still at the message the DM was written
 *              after
 *   perform    prepare reads it afresh and holds it to all of that again,
 *              writing nothing; commit makes the one POST LinkedIn's own
 *              messaging client makes and answers with the message
 *              LinkedIn says it created — never the POST alone (INV-31)
 *   reconcile  a read against the attempt's journal entry: ours there is the
 *              receipt; an attempt that never reached Send, or a history
 *              still ending at the tail read long enough after the press, is
 *              evidence it never went; anything else, the words still in
 *              the composer included, stays unsettled (INV-10)
 *
 * The owner's first message to a connection Engager keeps no conversation
 * with goes the same way into none ({@link dmOpenTargetFor}, US-LIO-20): the
 * sidecar's `open_dm` reads the member's profile — a connection — and the
 * account's conversations — none with them — in the send's own session, opens
 * the compose view their Message trigger leads to, sends to them alone, and
 * confirms only on LinkedIn's answer and a 1:1 with them that shows our words.
 * That conversation is bound to the conversation as a read binds one, in the
 * transaction that settles the message; nothing sent is proven only by a list
 * whole since the press, a quarter hour on. It is DM's capability: its first
 * confirmed send verifies DM like any other.
 *
 * Settled `confirmed`, the conversation takes `dm_confirmed`
 * ({@link settleDirectMessage}).
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The per-person cap's window: a rolling 720 hours, not a calendar month
 *  (spec §14). */
export const DM_CAP_WINDOW_MS = 720 * HOUR;
/** How long after the press the conversation's history, still ending at the
 *  message the DM answered, is evidence the DM never went: a read in the
 *  seconds after Send may not show it yet. A read showing it settles at any
 *  time; a page read that does not show it is never evidence. */
export const DM_RESOLVE_SETTLE_MS = 15 * MINUTE;
/** A preflight read that cannot tell is tried again this much later. */
const PREFLIGHT_RETRY_MS = HOUR;

export type DmKind = "dm" | "followup";

/** Why no DM may be reserved, by the server's rules — never the model's. A
 *  step is told which, and may plan around it (`agentStep/wake.ts`). */
export const DM_REFUSALS = [
  "no_thread",
  "owner_held",
  "dm_pending",
  "dm_unsettled",
  "person_cap",
  "person_cap_unset",
  "trigger_not_eligible",
  "acceptance_not_interest",
  "interest_missing",
  "incoming_opener_off",
  "link_unverified",
  "opener_spent",
  "no_trigger",
  "dm_unanswered",
  "cta_unconfigured",
  "cta_asset_mismatch",
  "cta_unapproved",
  "cta_claim_unsupported",
  "cta_offered_already",
  "cta_too_early",
  "followup_off",
  "followup_no_dm",
  "followup_answered",
  "followup_spent",
  "followup_too_soon",
  "followup_offer",
] as const;
export type DmRefusal = (typeof DM_REFUSALS)[number];

export function isDmRefusal(reason: string): reason is DmRefusal {
  return (DM_REFUSALS as readonly string[]).includes(reason);
}

/** What the step answers, as the DM rules read it. */
export type DmTrigger =
  | {
      type: "inbound_message_observed" | "reply_observed" | "reply_edited";
      eventId: number;
      eligible: boolean;
    }
  | {
      type: "invitation_accepted";
      eventId: number;
      eligible: boolean;
      direction: "outgoing" | "incoming";
      /** Their invitation was verifiably tied to an exchange under one of our
       *  comments. Meaningless for ours. */
      linkVerified: boolean;
    }
  | { type: "other"; eventId: number };

export type DmFacts = {
  trigger: DmTrigger;
  /** The event whose quoted words show their interest, if any. */
  interestEventId: number | null;
  policy: DmPolicy;
  /** DMs and follow-ups confirmed to the person on this conversation. */
  confirmedOnConversation: number;
  /** Our newest confirmed DM or follow-up has no word of theirs after it. */
  latestUnanswered: boolean;
  /** The CTA asset the proposal asks to offer; null for no offer. */
  ctaAssetId: string | null;
  /** The offer the words were drafted to make; null for words that make
   *  none. */
  draftOffer: string | null;
  cta: NonNullable<CampaignAgentStrategy["cta"]> | null;
  /** Whether an offer may be made from the asset: approved, as its words
   *  stand, and not retired (`products/offers.ts`). */
  ctaApproved: boolean;
  /** An offer was already made on the conversation. */
  ctaOffered: boolean;
  /** {@link relevantExchanges} of the conversation. */
  exchanges: number;
};

export type DmDecision =
  | { ok: true; purpose: "opener" | "reply" | "cta"; sequence: number; answers: number | null }
  | { ok: false; reason: DmRefusal };

/** What a DM the step proposes is for, or why it may not be sent — R05/R06
 *  as typed predicates over what the server holds. A DM answers words of
 *  theirs: after our own unanswered message, whatever woke the step, the only
 *  next message is a follow-up, under its bounds. Pure. */
export function decideDm(facts: DmFacts): DmDecision {
  const sequence = facts.confirmedOnConversation + 1;
  if (facts.latestUnanswered) return { ok: false, reason: "dm_unanswered" };
  // Words written to make an offer go only as that offer, and an offer only
  // in words written to make it.
  if (facts.draftOffer !== facts.ctaAssetId) return { ok: false, reason: "cta_asset_mismatch" };
  if (facts.ctaAssetId !== null) {
    if (facts.cta === null) return { ok: false, reason: "cta_unconfigured" };
    if (facts.ctaAssetId !== facts.cta.cta_asset_id) return { ok: false, reason: "cta_asset_mismatch" };
    if (!facts.ctaApproved) return { ok: false, reason: "cta_unapproved" };
    if (facts.interestEventId === null) return { ok: false, reason: "interest_missing" };
    if (facts.ctaOffered) return { ok: false, reason: "cta_offered_already" };
    if (facts.exchanges < facts.cta.after_relevant_exchanges) return { ok: false, reason: "cta_too_early" };
    return { ok: true, purpose: "cta", sequence, answers: null };
  }
  const { trigger } = facts;
  switch (trigger.type) {
    case "inbound_message_observed":
    case "reply_observed":
    case "reply_edited":
      if (!trigger.eligible) return { ok: false, reason: "trigger_not_eligible" };
      // Relevance is not interest: a DM answers someone who asked.
      if (facts.interestEventId === null) return { ok: false, reason: "interest_missing" };
      return { ok: true, purpose: "reply", sequence, answers: trigger.eventId };
    case "invitation_accepted": {
      if (facts.interestEventId !== null) {
        return { ok: true, purpose: "reply", sequence, answers: facts.interestEventId };
      }
      const opener =
        trigger.direction === "incoming"
          ? facts.policy.incoming_linked_opener
          : facts.policy.outgoing_acceptance === "contextual_opener";
      if (!trigger.eligible || !opener) {
        return {
          ok: false,
          reason: trigger.direction === "incoming" ? "incoming_opener_off" : "acceptance_not_interest",
        };
      }
      if (trigger.direction === "incoming" && !trigger.linkVerified) return { ok: false, reason: "link_unverified" };
      if (facts.confirmedOnConversation > 0) return { ok: false, reason: "opener_spent" };
      return { ok: true, purpose: "opener", sequence: 1, answers: null };
    }
    case "other":
      return { ok: false, reason: "no_trigger" };
  }
}

export type FollowupFacts = {
  policy: NonNullable<CampaignAgentStrategy["followup"]> | null;
  /** Their interest stands on the conversation, in their own quoted words. */
  interest: boolean;
  confirmedOnConversation: number;
  /** Our newest confirmed DM or follow-up on the conversation: its kind, when it
   *  went, and whether a word of theirs came after it. */
  latest: { kind: DmKind; sentAt: number; answered: boolean } | null;
  /** The step woke at a time the person's own quoted words named. */
  namedTime: boolean;
  ctaAssetId: string | null;
  now: number;
};

/**
 * Whether the step may follow up now. The step decided that it should and
 * when; these are the bounds it decides inside (R07): the campaign allows a
 * follow-up and their interest stands; it follows our own message, which
 * they have not answered — an answer is answered with a DM; at most
 * `max_count` (one) unanswered in a row; and not before `delay_hours` after
 * that message, unless the step woke at a time their own words named. Never
 * an offer. Pure.
 */
export function decideFollowup(
  facts: FollowupFacts,
): { ok: true; sequence: number } | { ok: false; reason: DmRefusal } {
  const { policy, latest } = facts;
  if (facts.ctaAssetId !== null) return { ok: false, reason: "followup_offer" };
  if (policy === null || policy.max_count === 0) return { ok: false, reason: "followup_off" };
  if (!facts.interest) return { ok: false, reason: "interest_missing" };
  if (latest === null) return { ok: false, reason: "followup_no_dm" };
  if (latest.answered) return { ok: false, reason: "followup_answered" };
  // `max_count` is 0 or 1: one follow-up already unanswered is the limit.
  if (latest.kind === "followup") return { ok: false, reason: "followup_spent" };
  if (!facts.namedTime && facts.now < latest.sentAt + policy.delay_hours * HOUR) {
    return { ok: false, reason: "followup_too_soon" };
  }
  return { ok: true, sequence: facts.confirmedOnConversation + 1 };
}

/**
 * The relevant exchanges on a conversation — R06's "a relevant prospect message
 * plus an Engager response that answers it": each of their relevant messages
 * that one of ours answered. Acceptances and greetings are no message of
 * theirs here; a message of theirs nobody answered is not yet an exchange.
 * Pure.
 */
export function relevantExchanges(
  theirs: ReadonlyArray<{ eventId: number; relevant: boolean }>,
  answered: ReadonlySet<number>,
): number {
  return theirs.filter((message) => message.relevant && answered.has(message.eventId)).length;
}

/** The conversation a DM goes into, as an approval binds it: the thread and
 *  its own address; beside them the person and the message it was written
 *  after, which the sidecar holds the page to. */
export function dmTargetFor(
  thread: Pick<DmThreadRow, "providerThreadId" | "lastMessageId">,
  personId: string,
): ActionTarget {
  return {
    kind: "dm_thread",
    id: thread.providerThreadId,
    urn: `https://www.linkedin.com/messaging/thread/${encodeURIComponent(thread.providerThreadId)}/`,
    authorProfileId: personId,
    ...(thread.lastMessageId === null ? {} : { lastMessageId: thread.lastMessageId }),
  };
}

/** The first message to a connection, as an approval binds it: no
 *  conversation yet — only the person, whose profile and conversations the
 *  send reads in its own session. */
export function dmOpenTargetFor(personId: string): ActionTarget {
  return { kind: "dm_open", id: personId, urn: null, authorProfileId: personId };
}

/** How the per-person cap stands for one person on one account. */
export type PersonCap =
  | { status: "open"; count: number; cap: number }
  | { status: "reached"; count: number; cap: number }
  | { status: "unset"; count: number };

/** Every DM Engager sent the person on this account in the rolling 720
 *  hours, against the account default's cap. */
export async function personCap(
  tx: Tx,
  input: { channelId: number; personId: string; now: number },
): Promise<PersonCap> {
  const [counted] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(actions)
    .where(
      and(
        eq(actions.channelId, input.channelId),
        eq(actions.authorProfileId, input.personId),
        inArray(actions.kind, ["dm", "followup"]),
        eq(actions.status, "confirmed"),
        gte(actions.settledAt, input.now - DM_CAP_WINDOW_MS),
      ),
    );
  const count = counted?.n ?? 0;
  const [channel] = await tx
    .select({ network: channels.network })
    .from(channels)
    .where(eq(channels.id, input.channelId));
  const account = channel
    ? await readAccountDefault(tx, input.channelId, { network: NETWORK_CATALOGS[channel.network] })
    : null;
  const cap = account?.document?.budgets?.max_outbound_dms_per_person_per_30d ?? null;
  if (cap === null) return { status: "unset", count };
  return { status: count >= cap ? "reached" : "open", count, cap };
}

/** The DM rows on a conversation, by where they stand. */
export async function conversationDms(tx: Tx, conversationId: number) {
  const rows = await tx
    .select({
      id: actions.id,
      kind: actions.kind,
      purpose: actions.purpose,
      status: actions.status,
      submittedAt: actions.submittedAt,
      settledAt: actions.settledAt,
      externalReceipt: actions.externalReceipt,
      candidate: actions.candidate,
    })
    .from(actions)
    .where(and(eq(actions.conversationId, conversationId), inArray(actions.kind, ["dm", "followup"])));
  const confirmed = rows
    .filter((row) => row.status === "confirmed")
    .sort((a, b) => (a.settledAt ?? 0) - (b.settledAt ?? 0) || a.id - b.id);
  return {
    confirmed,
    pending: rows.some((row) => row.status === "reserved" || row.status === "awaiting_review" || row.status === "approved"),
    unsettled: rows.some((row) => row.status === "dispatching" || row.status === "uncertain"),
  };
}

type SentDm = Pick<ActionRow, "externalReceipt" | "submittedAt" | "settledAt">;

/** When a confirmed DM went: the time the conversation printed for it, else
 *  the press — never the settlement, which a reconciliation look can make
 *  hours later. */
export function dmSentAt(row: SentDm): number {
  const read = DmReceiptSchema.safeParse(row.externalReceipt?.message);
  return (read.success ? read.data.sentAt : null) ?? row.submittedAt ?? row.settledAt ?? 0;
}

/**
 * Whether the person wrote after a DM of ours went: words of theirs — a
 * message in the conversation, or a reply under our comment — that happened
 * at or after its send time, or that a read first saw after the press. Either
 * is enough — a follow-up over an answer is the failure, one skipped is not.
 * Times, not the settlement: a DM confirmed by a later look may have been
 * answered before it settled.
 */
export async function answeredSince(
  tx: Tx,
  conversationId: number,
  dm: { sentAt: number; pressedAt: number | null },
): Promise<boolean> {
  const [answer] = await tx
    .select({ id: conversationEvents.id })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, conversationId),
        inArray(conversationEvents.type, ["inbound_message_observed", "reply_observed", "reply_edited"]),
        or(
          gte(conversationEvents.occurredAt, dm.sentAt),
          dm.pressedAt === null ? undefined : gte(conversationEvents.observedAt, dm.pressedAt),
        ),
      ),
    )
    .limit(1);
  return answer !== undefined;
}

/** The trigger an event is, as the DM rules read it. */
async function triggerOf(tx: Tx, event: ConversationEventRow): Promise<DmTrigger> {
  const eligible = (event.decision as { decision?: unknown } | null)?.decision === "eligible";
  switch (event.type) {
    case "inbound_message_observed":
    case "reply_observed":
    case "reply_edited":
      return { type: event.type, eventId: event.id, eligible };
    case "invitation_accepted": {
      // Theirs, accepted by us, names their invitation; ours does not.
      const incoming = event.sourceRef.invitationId !== undefined;
      const invitationEventId = event.sourceRef.eventId;
      const [invitation] =
        incoming && invitationEventId !== undefined
          ? await tx
              .select({ decision: conversationEvents.decision })
              .from(conversationEvents)
              .where(eq(conversationEvents.id, invitationEventId))
          : [];
      return {
        type: "invitation_accepted",
        eventId: event.id,
        eligible,
        direction: incoming ? "incoming" : "outgoing",
        // The invitation's own event is eligible only where its link to an
        // exchange under our comment was verified (`conversations/eligibility.ts`).
        linkVerified: (invitation?.decision as { decision?: unknown } | null)?.decision === "eligible",
      };
    }
    default:
      return { type: "other", eventId: event.id };
  }
}

/** Their relevant messages on the conversation, and which of them an answer of
 *  ours — a confirmed DM, or a public reply posted — met. */
async function exchangesOn(tx: Tx, conversationId: number, confirmedReplies: number[]): Promise<number> {
  const later = alias(conversationEvents, "later");
  const theirs = await tx
    .select({
      id: conversationEvents.id,
      type: conversationEvents.type,
      decision: conversationEvents.decision,
      incomingCommentId: sql<number | null>`(${conversationEvents.sourceRef}->>'incomingCommentId')::bigint`,
    })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, conversationId),
        inArray(conversationEvents.type, ["inbound_message_observed", "reply_observed", "reply_edited"]),
        notExists(tx.select({ id: later.id }).from(later).where(eq(later.supersedesEventId, conversationEvents.id))),
      ),
    );
  const comments = theirs.flatMap((event) => (event.incomingCommentId === null ? [] : [event.incomingCommentId]));
  const posted =
    comments.length === 0
      ? []
      : await tx
          .select({ incomingCommentId: messages.incomingCommentId })
          .from(messages)
          .where(
            and(
              inArray(messages.incomingCommentId, comments),
              eq(messages.kind, "reply"),
              eq(messages.status, "posted"),
            ),
          );
  const answeredComments = new Set(posted.map((row) => row.incomingCommentId));
  const answered = new Set(confirmedReplies);
  for (const event of theirs) {
    if (event.incomingCommentId !== null && answeredComments.has(event.incomingCommentId)) answered.add(event.id);
  }
  return relevantExchanges(
    theirs.map((event) => {
      const decision = event.decision as { decision?: unknown; intent?: unknown } | null;
      return {
        eventId: event.id,
        // A DM of theirs is relevant where it asks something or shows
        // interest; a reply where the eligibility table judged it a thing to
        // answer. A greeting is neither.
        relevant:
          event.type === "inbound_message_observed"
            ? decision?.intent === "interest" || decision?.intent === "question"
            : decision?.decision === "eligible",
      };
    }),
    answered,
  );
}

/** Why no DM may be queued on this conversation now, whatever it would say: no
 *  conversation bound, or — for any words but the owner's — only the owner's
 *  own, held for them from the inbox list (`conversations/dm.ts`); another DM
 *  still waiting or unsettled; the person's cap — which binds unattended work
 *  only, so a DM the owner wrote (`owner: true`) is counted, never stopped
 *  (INV-1). The thread it goes into when nothing here forbids it. */
export async function standingRefusal(
  tx: Tx,
  conversation: Pick<ConversationRow, "id" | "channelId" | "authorProfileId" | "canonicalDmThreadId">,
  dms: Awaited<ReturnType<typeof conversationDms>>,
  now: number,
  { owner = false }: { owner?: boolean } = {},
): Promise<{ reason: DmRefusal } | { thread: DmThreadRow }> {
  const [thread] =
    conversation.canonicalDmThreadId === null
      ? []
      : await tx
          .select()
          .from(dmThreads)
          .where(and(eq(dmThreads.id, conversation.canonicalDmThreadId), eq(dmThreads.conversationId, conversation.id)));
  if (!thread || thread.binding !== "bound" || thread.lastMessageId === null) return { reason: "no_thread" };
  if (thread.ownerHeldAt !== null && !owner) return { reason: "owner_held" };
  // One DM at a time: a second while the first waits for a yes, or while
  // nobody knows whether it went, could only say the same thing twice.
  if (dms.unsettled) return { reason: "dm_unsettled" };
  if (dms.pending) return { reason: "dm_pending" };
  if (owner) return { thread };
  const cap = await personCap(tx, { channelId: conversation.channelId, personId: conversation.authorProfileId, now });
  if (cap.status !== "open") return { reason: cap.status === "reached" ? "person_cap" : "person_cap_unset" };
  return { thread };
}

export type DirectMessageInput = {
  writing?: ActionCandidate["writing"];
  conversation: ConversationRow;
  campaignId: number;
  stepRunId: number | null;
  actionBindingId: string;
  kind: DmKind;
  /** The event the step answers. */
  trigger: ConversationEventRow;
  text: string;
  /** The facts the words rest on, at their content hashes. */
  facts: Array<{ id: number; contentHash: string }>;
  ctaAssetId: string | null;
  /** The offer the words were drafted to make, at the words approved then;
   *  null for words that make none. */
  draftOffer: OfferBinding | null;
  /** The step woke at a time the person's own quoted words named — the one
   *  thing that lets a follow-up go before `followup.delay_hours`. */
  namedTime: boolean;
  strategyVersion: number;
  /** The digest of the memory the step that wrote it read; null for none. */
  memoryVersion: string | null;
  /** What the binding resolved to: Ask me for the owner's yes, or Automatic,
   *  which only owner-set ceilings and the account's confirmed first DM ever
   *  let a DM reach (INV-28, INV-31). Stated by every caller, never
   *  defaulted. */
  mode: "review" | "auto";
  generationSeen: number;
  now: number;
};

/** Our newest confirmed DM or follow-up on the conversation, when it went, and
 *  whether a word of theirs came after it; null before the first. */
export async function latestOurs(
  tx: Tx,
  conversationId: number,
  confirmed: ReadonlyArray<SentDm & Pick<ActionRow, "kind">>,
): Promise<{ kind: DmKind; sentAt: number; answered: boolean } | null> {
  const latest = confirmed.at(-1);
  if (!latest) return null;
  const sentAt = dmSentAt(latest);
  return {
    kind: latest.kind === "followup" ? "followup" : "dm",
    sentAt,
    answered: await answeredSince(tx, conversationId, { sentAt, pressedAt: latest.submittedAt }),
  };
}

/**
 * Reserve one DM or follow-up for the conversation's person — the candidate, never
 * the send — at the mode its binding resolved to. The server decides what it
 * is for and whether it may be sent at all ({@link decideDm},
 * {@link decideFollowup}); the ledger's one door (`reserveAction`) then
 * re-reads the conversation, the pauses and the person's exclusion and inserts
 * under the person key.
 */
export async function reserveDirectMessage(tx: Tx, input: DirectMessageInput): Promise<ReserveOutcome> {
  const { conversation, now } = input;
  const dms = await conversationDms(tx, conversation.id);
  const standing = await standingRefusal(tx, conversation, dms, now);
  if ("reason" in standing) return { status: "refused", reason: standing.reason };
  const trigger = await triggerOf(tx, input.trigger);
  const strategies = (await inheritedStrategies(tx, [input.campaignId])).get(input.campaignId);
  const latest = await latestOurs(tx, conversation.id, dms.confirmed);

  let decided: { purpose: "opener" | "reply" | "cta" | "followup"; sequence: number; answers: number | null };
  const offer = input.ctaAssetId === null ? null : await approvedOffer(tx, input.ctaAssetId);
  if (input.kind === "followup") {
    const verdict = decideFollowup({
      policy: inheritedGroup(strategies, "followup"),
      interest: conversation.interestEvidenceEventId !== null,
      confirmedOnConversation: dms.confirmed.length,
      latest,
      namedTime: input.namedTime,
      ctaAssetId: input.ctaAssetId ?? input.draftOffer?.ref ?? null,
      now,
    });
    if (!verdict.ok) return { status: "refused", reason: verdict.reason };
    decided = { purpose: "followup", sequence: verdict.sequence, answers: null };
  } else {
    const confirmedReplies = dms.confirmed.flatMap((row) =>
      row.purpose === "reply" && row.candidate.sources[0] ? [row.candidate.sources[0].eventId] : [],
    );
    const verdict = decideDm({
      trigger,
      interestEventId: conversation.interestEvidenceEventId,
      policy: inheritedGroup(strategies, "dm") ?? { outgoing_acceptance: "wait_for_interest", incoming_linked_opener: false },
      confirmedOnConversation: dms.confirmed.length,
      latestUnanswered: latest !== null && !latest.answered,
      ctaAssetId: input.ctaAssetId,
      draftOffer: input.draftOffer?.ref ?? null,
      cta: inheritedGroup(strategies, "cta"),
      ctaApproved: offer !== null,
      ctaOffered: conversation.ctaEventId !== null || dms.confirmed.some((row) => row.purpose === "cta"),
      exchanges: await exchangesOn(tx, conversation.id, confirmedReplies),
    });
    if (!verdict.ok) return { status: "refused", reason: verdict.reason };
    // The words are read against the offer as it stands now: an edit the
    // owner approved since the draft is what they must agree with.
    if (offer !== null && unsupportedOfferClaim(input.text, offer) !== null) {
      return { status: "refused", reason: "cta_claim_unsupported" };
    }
    decided = verdict;
  }

  // What the DM answers is its evidence: the approval binds that event's
  // revision, so an edit of it sends the DM back for a fresh yes.
  const answered =
    decided.answers === null || decided.answers === input.trigger.id
      ? input.trigger
      : ((await tx.select().from(conversationEvents).where(eq(conversationEvents.id, decided.answers)))[0] ?? input.trigger);
  const candidate: ActionCandidate = {
    ...(input.writing ? { writing: input.writing } : {}),
    text: input.text,
    sources: [{ eventId: answered.id, contentHash: answered.contentHash }],
    versions: {
      strategy: input.strategyVersion,
      facts: input.facts,
      memory: input.memoryVersion,
      voice: null,
      ...(decided.purpose === "cta" && offer !== null
        ? { offer: { ref: offer.ref, contentHash: offer.contentHash } }
        : {}),
    },
  };
  return reserveAction(tx, {
    channelId: conversation.channelId,
    campaignId: input.campaignId,
    conversationId: conversation.id,
    authorProfileId: conversation.authorProfileId,
    stepRunId: input.stepRunId,
    actionBindingId: input.actionBindingId,
    kind: input.kind,
    purpose: decided.purpose,
    sequence: decided.sequence,
    inboundEventId: decided.purpose === "reply" ? decided.answers : null,
    target: dmTargetFor(standing.thread, conversation.authorProfileId),
    candidate,
    mode: input.mode,
    generationSeen: input.generationSeen,
    now,
  });
}

/** A receipt that names no click: the action target answered before one. */
function blockedBefore(reason: string, detail?: Record<string, unknown>): Preflight {
  return { proceed: false, receipt: { status: "blocked", evidence: { reason, ...detail } } };
}

/** The sidecar's answer as the ledger settles it. A confirmation carries the
 *  message LinkedIn's answer or a read of the conversation showed; every
 *  other outcome keeps what was seen, in words, for the Inbox to say why. */
export function directMessageReceipt(
  result: SendDmResult | Exclude<OpenDmResult, { status: "confirmed" }>,
): ActionReceipt {
  switch (result.status) {
    case "confirmed":
      return { status: "confirmed", evidence: { message: result.receipt } };
    case "blocked":
      return {
        status: "blocked",
        evidence: { reason: result.reason, ...(result.detail ? { detail: result.detail } : {}) },
      };
    case "not_sent":
      return {
        status: "definitely_not_sent",
        evidence: { reason: result.reason, notAttempted: true, ...(result.detail ? { detail: result.detail } : {}) },
      };
    case "uncertain":
      return { status: "uncertain", evidence: { error: result.reason } };
  }
}

/** The sidecar's answer to a first message as the ledger settles it: a
 *  confirmation carries the conversation it opened, which the settlement
 *  binds. */
export function openedDmReceipt(result: OpenDmResult): ActionReceipt {
  return result.status === "confirmed"
    ? { status: "confirmed", evidence: { message: result.receipt, conversation: result.conversation } }
    : directMessageReceipt(result);
}

/** The browser half of the owner's first message to a connection. */
function openDmOperation(
  driver: ActionSurface,
  context: { organizationId: string; now: () => number },
): ActionOperation {
  return {
    async preflight(row) {
      const personId = row.authorProfileId;
      if (
        row.conversationId === null ||
        personId === null ||
        row.target.authorProfileId !== personId ||
        !row.candidate.text
      ) {
        return blockedBefore("target_unresolved");
      }
      // A worker's words never open a conversation: only the owner's press.
      if (row.origin !== "owner") return blockedBefore("opener_owner_only");
      if (!driver.openDm) return blockedBefore("dm_unavailable");
      return withOrg(context.organizationId, async (tx) => {
        const [conversation] = await tx
          .select({ thread: conversations.canonicalDmThreadId })
          .from(conversations)
          .where(eq(conversations.id, row.conversationId!));
        // A conversation a read bound since: the words go there, by `send_dm`,
        // on a press of their own.
        if (!conversation) return blockedBefore("conversation_gone");
        if (conversation.thread !== null) return blockedBefore("thread_bound");
        const [channel] = await tx.select().from(channels).where(eq(channels.id, row.channelId));
        if (!channel) return blockedBefore("account_gone");
        // The send reads the member's profile in its own session.
        const metered = await reserveResearchRead({
          db: tx,
          channel,
          read: "profile_read",
          campaignId: row.campaignId,
          now: context.now(),
        });
        return metered.ok
          ? ({ proceed: true } satisfies Preflight)
          : ({
              proceed: false,
              hold: `preflight:${metered.reason}`,
              ...(metered.retryAt === undefined ? {} : { retryAt: metered.retryAt }),
            } satisfies Preflight);
      });
    },
    async perform(row) {
      if (!driver.openDm || row.authorProfileId === null || !row.candidate.text) {
        return { status: "definitely_not_sent", evidence: { reason: "not_admitted_in_session" } };
      }
      const result = await driver.openDm({
        operationId: row.fenceToken!,
        recipientProfileId: row.authorProfileId,
        text: row.candidate.text,
      });
      return openedDmReceipt(result);
    },
    async reconcile(row) {
      if (!driver.resolveOpenDm || row.fenceToken === null || row.authorProfileId === null || !row.candidate.text) {
        return null;
      }
      const resolution = await driver.resolveOpenDm({
        operationId: row.fenceToken,
        recipientProfileId: row.authorProfileId,
        text: row.candidate.text,
      });
      switch (resolution.status) {
        case "confirmed":
          return {
            status: "confirmed",
            evidence: { message: resolution.receipt, conversation: resolution.conversation, reconciled: true },
          };
        case "not_sent":
          // The journal never held the attempt as pressing: nothing was sent.
          return { status: "definitely_not_sent", evidence: { reconciled: true, neverPressed: true } };
        case "absent_proven": {
          // A list whole since the press with no conversation with them:
          // nothing went, once the read is long enough after the press for
          // ours to have shown.
          const attempt = row.attempts.find((candidate) => candidate.operationId === row.fenceToken);
          return attempt !== undefined && resolution.observedAt - attempt.startedAt >= DM_RESOLVE_SETTLE_MS
            ? { status: "definitely_not_sent", evidence: { reconciled: true, absentAt: resolution.observedAt } }
            : null;
        }
        case "uncertain":
          return null;
      }
    },
  };
}

/** How many of the conversation's newest messages a send's preflight reads
 *  from its history: one of LinkedIn's pages. */
const PREFLIGHT_HISTORY = 20;

/** Whether the read is the account and the person alone — the person by the
 *  member urn the thread knows them by where the read names one too, else by
 *  profile id. */
export function onlyThem(read: DmThreadRead, personId: string, members: readonly KnownMember[]): boolean {
  const others = read.participants.filter((participant) => !participant.isSelf);
  const memberUrn = members.find((member) => member.profileId === personId)?.memberUrn;
  return (
    !read.group &&
    read.participants.length === 2 &&
    others.length === 1 &&
    samePerson(others[0]!, { profileId: personId, ...(memberUrn === undefined ? {} : { memberUrn }) })
  );
}

/** The member urn the read names its one other person by, where the profile
 *  Engager knows that urn by — the mapping a conversation is bound to them by
 *  (`knownMemberProfiles`) — is the person's alone; else null. Known as no
 *  one, as two profiles, or as someone else, it vouches for no one. */
async function verifiedMemberUrn(
  tx: Tx,
  channelId: number,
  read: DmThreadRead,
  personId: string,
): Promise<string | null> {
  const others = read.participants.filter((participant) => !participant.isSelf);
  const urn = others.length === 1 ? others[0]!.memberUrn : undefined;
  if (urn === undefined) return null;
  return (await knownMemberProfiles(tx, channelId, [urn])).get(urn) === personId ? urn : null;
}

/** The browser half of a DM and a follow-up, for the dispatch gate — into
 *  the bound conversation, or, for the owner's first message, into none. */
export function directMessageOperation(
  driver: ActionSurface,
  context: { organizationId: string; now: () => number },
): ActionOperation {
  const opening = openDmOperation(driver, context);
  const into = threadDmOperation(driver, context);
  return {
    preflight: (row) => (row.target.kind === "dm_open" ? opening : into).preflight(row),
    perform: (row) => (row.target.kind === "dm_open" ? opening : into).perform(row),
    reconcile: (row) => (row.target.kind === "dm_open" ? opening : into).reconcile(row),
  };
}

/** The browser half of a DM into the conversation a read bound. */
function threadDmOperation(
  driver: ActionSurface,
  context: { organizationId: string; now: () => number },
): ActionOperation {
  // The member urn each row's conversation was admitted naming the person
  // by, from its preflight to its Send: what the sidecar holds the page to.
  const admittedBy = new Map<number, string>();
  return {
    async preflight(row) {
      const target = row.target;
      const personId = row.authorProfileId;
      if (
        row.conversationId === null ||
        personId === null ||
        target.kind !== "dm_thread" ||
        target.authorProfileId !== personId ||
        target.lastMessageId === undefined ||
        !row.candidate.text
      ) {
        return blockedBefore("target_unresolved");
      }
      if (!driver.readDmThread || !driver.sendDm) return blockedBefore("dm_unavailable");
      /** One read of the conversation spent from the account's budget, or
       *  the hold that keeps it from being read now. */
      const meterRead = (tx: Tx, channel: typeof channels.$inferSelect): Promise<Preflight | null> =>
        reserveResearchRead({
          db: tx,
          channel,
          read: "thread_read",
          campaignId: row.campaignId,
          now: context.now(),
        }).then((metered) =>
          metered.ok
            ? null
            : ({
                proceed: false,
                hold: `preflight:${metered.reason}`,
                ...(metered.retryAt === undefined ? {} : { retryAt: metered.retryAt }),
              } satisfies Preflight),
        );
      const admitted = await withOrg(context.organizationId, async (tx) => {
        const [thread] = await tx
          .select({
            conversationId: dmThreads.conversationId,
            participants: dmThreads.participants,
            ownerHeldAt: dmThreads.ownerHeldAt,
          })
          .from(dmThreads)
          .where(and(eq(dmThreads.channelId, row.channelId), eq(dmThreads.providerThreadId, target.id)));
        if (thread?.conversationId !== row.conversationId) return { refused: blockedBefore("thread_unbound") };
        // The owner's own conversation, held for them: no worker's words go
        // into it — only the owner's, read first like any.
        const held = thread.ownerHeldAt !== null;
        if (held && row.origin !== "owner") return { refused: blockedBefore("owner_held") };
        // Unattended work stops at the person's cap; the owner's own words are
        // counted and only spaced (INV-1).
        if (row.origin === "worker") {
          const cap = await personCap(tx, { channelId: row.channelId, personId, now: context.now() });
          if (cap.status === "unset") return { refused: blockedBefore("person_cap_unset", { count: cap.count }) };
          if (cap.status === "reached") {
            return { refused: blockedBefore("person_cap", { count: cap.count, cap: cap.cap }) };
          }
        }
        const [channel] = await tx.select().from(channels).where(eq(channels.id, row.channelId));
        if (!channel) return { refused: blockedBefore("account_gone") };
        return { refused: await meterRead(tx, channel), members: knownMembers(thread.participants), held };
      });
      if (admitted.refused) return admitted.refused;
      const members = admitted.members ?? [];

      const unreadable = async (error: unknown): Promise<Preflight> => {
        if (isConnectorBackoff(error)) await pauseChannelForConnectorBackoff(context.organizationId, error);
        return { proceed: false, hold: "preflight:unreadable", retryAt: context.now() + PREFLIGHT_RETRY_MS };
      };
      // The conversation's newest messages, from its history where the
      // connector reads one without opening it: whatever the owner sent since
      // Engager last wrote there is in them. Its composer is the one Engager
      // last saw — the send's own prepare refuses words nobody sent where it
      // reads the page. Where the history cannot be read, its page is, as a
      // read of its own — as it is where the history names the person by a
      // member urn no read has yet shown whose profile it is.
      let read: DmThreadRead | null = null;
      if (driver.readConversationMessages) {
        try {
          const history = await driver.readConversationMessages(target.id, { limit: PREFLIGHT_HISTORY, members });
          const [known] = await withOrg(context.organizationId, (tx) =>
            tx
              .select({ draftHash: dmThreads.humanDraftHash })
              .from(dmThreads)
              .where(and(eq(dmThreads.channelId, row.channelId), eq(dmThreads.providerThreadId, target.id))),
          );
          read = {
            ...history,
            composer: known?.draftHash ? { hasDraft: true, draftHash: known.draftHash } : { hasDraft: false },
          };
        } catch (error) {
          if (isConnectorBackoff(error) || isConnectorSignIn(error)) return unreadable(error);
          console.warn(`[dm] history query id stale: ${(error as Error).message}; reading the conversation's page`);
          const refused = await withOrg(context.organizationId, async (tx) => {
            const [channel] = await tx.select().from(channels).where(eq(channels.id, row.channelId));
            return channel ? meterRead(tx, channel) : blockedBefore("account_gone");
          });
          if (refused) return refused;
        }
      }
      if (read === null) {
        try {
          read = await driver.readDmThread(target.id, {});
        } catch (error) {
          return unreadable(error);
        }
      }
      // A page that links the person by member id names them by their urn
      // alone: it is them where the profile Engager knows the urn by is
      // theirs, as the conversation was bound — and no one otherwise.
      const memberUrn = await withOrg(context.organizationId, (tx) =>
        verifiedMemberUrn(tx, row.channelId, read, personId),
      );
      const known = memberUrn === null ? members : [...members, { memberUrn, profileId: personId }];
      if (!onlyThem(read, personId, known)) return blockedBefore("participants_mismatch");
      if (memberUrn === null) admittedBy.delete(row.id);
      else admittedBy.set(row.id, memberUrn);
      // The invitation's note, there by the time its message goes: LinkedIn
      // carried it, so it is the first message already and a second copy never
      // goes (US-ICA-05). Only the note's own words are that copy: other words
      // on this row are the owner's, written in its place, and go through the
      // gates below like any message of theirs.
      if (row.purpose === "invite_note") {
        const carried = await withOrg(context.organizationId, async (tx) => {
          const invite = await conversationInvite(tx, row.conversationId!);
          const spoken = invite ? noteSpokenIn(read.messages, invite) : undefined;
          if (!invite || !spoken) return null;
          await recordInviteNoteCarried(tx, {
            conversationId: row.conversationId!,
            inviteActionId: invite.id,
            messageId: spoken.messageId,
            threadId: read.threadId,
            observedAt: read.observedAt,
            now: context.now(),
          });
          return noteOf(invite);
        });
        if (carried !== null && dmWordsHash(row.candidate.text) === dmWordsHash(carried)) {
          return {
            proceed: false,
            receipt: { status: "definitely_not_sent", evidence: { reason: "note_carried", notAttempted: true } },
          };
        }
      }
      // A conversation held for the owner is read for this send alone: its
      // messages are never recorded on the conversation, and it stays theirs. The
      // owner's words go only after the message they last saw there.
      if (admitted.held) {
        return read.messages.at(-1)?.messageId === target.lastMessageId
          ? { proceed: true }
          : blockedBefore("thread_moved");
      }
      return withOrg(context.organizationId, async (tx) => {
        // Something new from them is theirs to be answered afresh, by the next
        // wake that reads and classifies it — never by words written before it.
        if ((await unrecordedInbound(tx, row.channelId, read)).length > 0) return blockedBefore("thread_moved");
        const recorded = await recordThreadRead(tx, {
          channelId: row.channelId,
          read,
          inboxDigest: null,
          classified: new Map(),
          now: context.now(),
        });
        // The owner's draft, or a message of theirs no read had shown or sent
        // since Engager last wrote there: the conversation is theirs now, and
        // the takeover cancelled this send with its reason.
        if (recorded.takeover) return { proceed: false, hold: "human_owned" } satisfies Preflight;
        if (read.messages.at(-1)?.messageId !== target.lastMessageId) return blockedBefore("thread_moved");
        return { proceed: true } satisfies Preflight;
      });
    },
    async perform(row) {
      if (!driver.sendDm || row.authorProfileId === null || !row.candidate.text || row.target.lastMessageId === undefined) {
        return { status: "definitely_not_sent", evidence: { reason: "not_admitted_in_session" } };
      }
      const memberUrn = admittedBy.get(row.id);
      const result = await driver.sendDm({
        operationId: row.fenceToken!,
        threadId: row.target.id,
        recipientProfileId: row.authorProfileId,
        text: row.candidate.text,
        expected: { lastMessageId: row.target.lastMessageId, ...(memberUrn === undefined ? {} : { memberUrn }) },
      });
      return directMessageReceipt(result);
    },
    async reconcile(row) {
      if (!driver.resolveDm || row.fenceToken === null || row.authorProfileId === null || !row.candidate.text) {
        return null;
      }
      // Whose profile each member urn in the conversation is, as Engager's
      // reads tied them: its history then answers, and nothing is opened.
      const [thread] = await withOrg(context.organizationId, (tx) =>
        tx
          .select({ participants: dmThreads.participants })
          .from(dmThreads)
          .where(and(eq(dmThreads.channelId, row.channelId), eq(dmThreads.providerThreadId, row.target.id))),
      );
      const resolution = await driver.resolveDm({
        operationId: row.fenceToken,
        threadId: row.target.id,
        recipientProfileId: row.authorProfileId,
        text: row.candidate.text,
        members: knownMembers(thread?.participants),
      });
      switch (resolution.status) {
        case "confirmed":
          return { status: "confirmed", evidence: { message: resolution.receipt, reconciled: true } };
        case "not_sent":
          // The journal never held the attempt as pressing: nothing was sent.
          return { status: "definitely_not_sent", evidence: { reconciled: true, neverPressed: true } };
        case "absent_proven": {
          // The history ends at the message answered: nothing went, once the
          // read is long enough after the press for ours to have shown.
          const attempt = row.attempts.find((candidate) => candidate.operationId === row.fenceToken);
          return attempt !== undefined && resolution.observedAt - attempt.startedAt >= DM_RESOLVE_SETTLE_MS
            ? { status: "definitely_not_sent", evidence: { reconciled: true, absentAt: resolution.observedAt } }
            : null;
        }
        case "uncertain":
          return null;
      }
    },
  };
}

/**
 * What a settled DM proves on its conversation, in the transaction that settles it
 * — whoever settled it: the gate's click, a reconciliation read, the owner's
 * word that it went out. A confirmed one is `dm_confirmed` on the log, and the
 * conversation's newest message moved to ours where the answer or read that
 * confirmed it showed nothing after it. One the send's own prepare refused for
 * words nobody sent in the composer of the page it read hands the
 * conversation to the owner, as any read showing their draft does — a history
 * shows no composer — unless it is held for them already. It arms nothing:
 * whether and when to follow up is the step's, which waits on the
 * conversation and decides when it wakes.
 */
export async function settleDirectMessage(
  tx: Tx,
  row: ActionRow,
  receipt: ActionReceipt,
  now: number,
): Promise<void> {
  if (row.conversationId === null || (row.kind !== "dm" && row.kind !== "followup")) return;
  if (row.target.kind === "dm_open") {
    await settleOpenedConversation(tx, row, receipt, now);
    return;
  }
  const [thread] = await tx
    .select()
    .from(dmThreads)
    .where(and(eq(dmThreads.channelId, row.channelId), eq(dmThreads.providerThreadId, row.target.id)));
  if (receipt.status === "blocked" && receipt.evidence.reason === "human_draft") {
    // A conversation held for the owner is theirs already.
    if (thread?.ownerHeldAt != null) return;
    const [conversation] = await tx.select().from(conversations).where(eq(conversations.id, row.conversationId));
    if (conversation && conversation.closedReason === null && conversation.opsStatus !== "human_owned") {
      await takeOverConversation(tx, { conversationId: conversation.id, by: "observed:dm_draft", now });
    }
    return;
  }
  if (receipt.status !== "confirmed") return;
  const parsed = DmReceiptSchema.safeParse(receipt.evidence.message);
  const message = parsed.success ? parsed.data : null;
  const recorded = await recordDmConfirmed(tx, {
    conversationId: row.conversationId,
    thread: { id: thread?.id ?? null, providerThreadId: row.target.id },
    text: row.candidate.text ?? "",
    message,
    sentAt: message?.sentAt ?? dmSentAt(row),
    decision: {
      actionExecutionId: row.id,
      kind: row.kind,
      purpose: row.purpose,
      sequence: row.sequence,
      ctaAssetId: row.candidate.versions.offer?.ref ?? null,
    },
    now,
  });
  if (!recorded?.recorded) return;
  if (
    message !== null &&
    thread !== undefined &&
    message.tailMessageId === message.messageId &&
    thread.lastMessageId === row.target.lastMessageId
  ) {
    // The answer or read that confirmed it showed ours as the newest: the
    // next DM is written after it, and the next read does not take it for the
    // owner's.
    await tx
      .update(dmThreads)
      .set({
        lastMessageId: message.messageId,
        lastHistoryMessageId: message.messageId,
        lastThreadReadAt: message.observedAt,
        updatedAt: now,
      })
      .where(eq(dmThreads.id, thread.id));
  }
}

/**
 * What a confirmed first message proves: the conversation it opened, bound to
 * the person's conversation as a read binds one (`recordThreadRead`) — but only a
 * 1:1 with exactly them, the conversation the receipt names — and
 * `dm_confirmed` on the log. Later messages then go into it by `send_dm`.
 * A confirmation whose conversation does not bind still records the message:
 * it went, and the next read of the inbox finds the conversation. So does the
 * owner's word that it went, which names no conversation at all: it is
 * recorded against the action and the person, and a later read binds the
 * thread.
 */
async function settleOpenedConversation(
  tx: Tx,
  row: ActionRow,
  receipt: ActionReceipt,
  now: number,
): Promise<void> {
  if (receipt.status !== "confirmed" || row.conversationId === null || row.authorProfileId === null) return;
  const parsedMessage = OpenDmReceiptSchema.safeParse(receipt.evidence.message);
  const message = parsedMessage.success ? parsedMessage.data : null;
  const parsedConversation = ConversationHistorySchema.safeParse(receipt.evidence.conversation);
  const conversation = parsedConversation.success ? parsedConversation.data : null;
  const others = conversation?.participants.filter((participant) => !participant.isSelf) ?? [];
  const theirs =
    conversation !== null &&
    message !== null &&
    conversation.threadId === message.threadId &&
    !conversation.group &&
    conversation.participants.length === 2 &&
    others.length === 1 &&
    others[0]!.profileId === row.authorProfileId;
  const bound = theirs
    ? await recordThreadRead(tx, {
        channelId: row.channelId,
        read: { ...conversation, composer: { hasDraft: false } },
        inboxDigest: null,
        classified: new Map(),
        now,
      })
    : null;
  const threadId = message?.threadId ?? conversation?.threadId ?? null;
  await recordDmConfirmed(tx, {
    conversationId: row.conversationId,
    thread: { id: bound?.thread.id ?? null, providerThreadId: threadId },
    text: row.candidate.text ?? "",
    message,
    sentAt: message?.sentAt ?? dmSentAt(row),
    decision: {
      actionExecutionId: row.id,
      kind: row.kind === "followup" ? "followup" : "dm",
      purpose: row.purpose,
      sequence: row.sequence,
      ctaAssetId: null,
    },
    now,
  });
}
