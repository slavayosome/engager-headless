import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  dmThreads,
  incomingInvitations,
  conversationEvents,
  conversations,
  outcomeEvents,
  type ConversionOutcome,
  type ConversationClosedReason,
  type ConversationEventType,
  type ConversationRelationship,
  type LeadStage,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { scheduledWakes } from "../agentStep/wakes";
import { findPerson, type Person } from "./directory";
import type { Send, SendKind, SendPhase, SendState } from "./sendState";
import { readSends } from "./sends";
import { readPersonThreads, type PersonThread } from "./threads";
import { waitingPeople, type Wait } from "./waits";

/**
 * THE PATH FROM A POST TO MESSAGES — one person's whole relationship with the
 * account at a glance, the strip across their pane: Scout's match, our
 * comment, their reply and ours, the invite, the connection, their messages
 * and the outcome. A step is `done` once its own evidence happened, `now`
 * while something about it waits on the owner — exactly the steps that carry
 * waits — `pending` while a send of ours for it is approved and on its way
 * but LinkedIn has not confirmed it (`people/sendState.ts`: queued, held,
 * sending, or being checked), and `todo` otherwise. A pending step turns
 * `done` on the confirmation and returns to `todo` if the send is cancelled.
 *
 * Each step reads its own evidence and nothing else: the match is the post's
 * `agentRankedAt` and our comment its `postedAt` (`people/threads.ts`); their
 * reply its `receivedAt`; the invite the log's `invitation_confirmed`, theirs
 * to the account its `incoming_invitation_observed` or the invitations page's
 * own row; the connection an `invitation_accepted` or a read showing them
 * connected; their messages the first `dm_confirmed` or
 * `inbound_message_observed`; the outcome the conversation's own, or the opt-out
 * that closed it. Someone with no conversation has a strip from their rows.
 *
 * A step that happened only for some people — the match, a like waiting, our
 * reply — shows only where it did; the invite only while it could still be
 * the way the two connect. Reads only, inside the caller's `withOrg`.
 *
 * A person Find leads found has the strip of their own (`leadStripSteps`):
 * Signal, Lead and Contacted before the four steps they share with the rest.
 */

export type StripStepId =
  | "signal"
  | "lead"
  | "contacted"
  | "spotted"
  | "matched"
  | "commented"
  | "room_reply"
  | "liked"
  | "replied"
  | "you_replied"
  | "invite"
  | "invited_you"
  | "connected"
  | "messages"
  | "outcome";

export type StripState = "done" | "now" | "todo" | "pending";

/** What a step says beside, or instead of, its time. */
export type StripNote =
  /** A draft of ours waits for a yes. */
  | "draft_waits"
  /** Ours did not post. */
  | "not_posted"
  /** Nobody can vouch for ours. */
  | "unclear"
  /** Theirs waits on the owner's answer. */
  | "answer"
  /** Theirs was held before anything read it. */
  | "held"
  /** Our invite waits for a yes. */
  | "waits_on_you"
  /** Our invite went, and they have not answered it. */
  | "pending"
  /** Connected before the account touched them. */
  | "before_engager"
  /** Connected, and nothing written yet. */
  | "none_yet"
  /** A conversation the owner holds. */
  | "yours"
  /** A message of ours nobody can vouch for. */
  | "checking"
  /** Engager reads it again on its own. */
  | "waiting_on_them"
  /** Closed. */
  | "closed"
  | ConversionOutcome
  /** They asked not to be contacted. */
  | "not_interested"
  /** How the first send that reached someone Find leads found went: our
   *  comment on their post, our reply under their comment, our invite. */
  | "by_comment"
  | "by_reply"
  | "by_invite";

export type StripStep = {
  id: StripStepId;
  state: StripState;
  /** When its evidence happened; null while it has not, or where no moment
   *  is known. */
  at: number | null;
  note: StripNote | null;
  /** Where the send stands, on a pending step alone. */
  send?: SendState;
};

/** One entry of the conversation's log the strip reads. */
export type StripLogEntry = {
  type: ConversationEventType;
  at: number;
  /** What a relationship read showed. */
  relationship?: ConversationRelationship;
};

/** Everything a strip is cut from. */
export type StripEvidence = {
  threads: readonly Pick<PersonThread, "events" | "room">[];
  /** Where the account stands with them, as the last read showed. */
  relationship: ConversationRelationship;
  /** Their conversation's log, oldest first; empty without one. */
  log: readonly StripLogEntry[];
  outcome: { kind: ConversionOutcome; at: number | null } | null;
  closed: { reason: ConversationClosedReason; at: number | null } | null;
  /** When they invited the account, as the invitations page read it. */
  invitedYouAt: number | null;
  /** Their conversation is one the owner holds. */
  ownerHeld: boolean;
  /** Engager reads their conversation again on its own. */
  wake: boolean;
  waits: readonly (Pick<Wait, "kind" | "source" | "about"> & Partial<Pick<Wait, "at">>)[];
  /** Our sends to them on their way out and not confirmed. */
  sends: readonly Send[];
};

/** The step each kind of send is on: an acceptance on the connection it
 *  would make. */
const SEND_STEP: Record<SendKind, StripStepId> = {
  comment: "commented",
  reply: "you_replied",
  room_reply: "room_reply",
  invite: "invite",
  accept_invite: "connected",
  dm: "messages",
};

/** Which of two sends on one step the strip shows: the one furthest along. */
const FURTHEST: readonly SendPhase[] = ["sending", "checking", "held", "queued"];

/** The log entries a strip reads. */
const LOGGED: readonly ConversationEventType[] = [
  "invitation_confirmed",
  "incoming_invitation_observed",
  "invitation_accepted",
  "relationship_observed",
  "dm_confirmed",
  "inbound_message_observed",
  "opt_out",
];

/** The step a wait is about, and what it says there. */
function waitStep(wait: Pick<Wait, "kind" | "source" | "about">): { id: StripStepId; note: StripNote | null } {
  switch (wait.kind) {
    case "comment_draft":
      return { id: "commented", note: "draft_waits" };
    case "room_reply_draft":
      return { id: "room_reply", note: "draft_waits" };
    case "reply_draft":
    case "own_reply":
      return { id: "replied", note: "answer" };
    case "held_reply":
      return { id: "replied", note: "held" };
    case "like_to_approve":
      return { id: "liked", note: "draft_waits" };
    case "invite_to_approve":
      return { id: "invite", note: "waits_on_you" };
    case "accept_invite":
      return { id: "invited_you", note: null };
    case "dm_draft":
      return { id: "messages", note: "answer" };
    case "owner_held_dm":
      return { id: "messages", note: "yours" };
    case "failed":
      return { id: wait.about === "room_reply" ? "room_reply" : wait.about === "reply" ? "replied" : "commented", note: "not_posted" };
    case "unclear":
      switch (wait.about) {
        case "room_reply":
          return { id: "room_reply", note: "unclear" };
        case "comment":
          return { id: "commented", note: "unclear" };
        case "reply":
          return { id: "replied", note: "unclear" };
        case "invite":
        case "withdraw_invite":
          return { id: "invite", note: "unclear" };
        case "accept_invite":
          return { id: "invited_you", note: "unclear" };
        case "dm":
        case "followup":
          return { id: "messages", note: "checking" };
        default:
          // A like on the ledger, or one that rode a send.
          return { id: "liked", note: "unclear" };
      }
  }
}

const first = (moments: ReadonlyArray<number | null | undefined>): number | null => {
  const known = moments.filter((at): at is number => typeof at === "number");
  return known.length === 0 ? null : Math.min(...known);
};

/** Notes that say a step happened though no moment is known for it. */
const DONE_NOTES: ReadonlySet<StripNote> = new Set(["before_engager", "yours", "closed", "not_interested"]);

/** The strip, from its evidence. Pure. */
export function stripSteps(evidence: StripEvidence): StripStep[] {
  const events = evidence.threads.flatMap((thread) => thread.events);
  const logged = (type: ConversationEventType) =>
    first(evidence.log.filter((entry) => entry.type === type).map((entry) => entry.at));
  const waiting = new Map<StripStepId, StripNote | null>();
  for (const wait of evidence.waits) {
    const { id, note } = waitStep(wait);
    // The first wait on a step says what it is; any note beats none.
    if (!waiting.has(id) || waiting.get(id) === null) waiting.set(id, note);
  }
  const sending = new Map<StripStepId, SendState>();
  for (const { kind, state } of evidence.sends) {
    const id = SEND_STEP[kind];
    const shown = sending.get(id);
    if (!shown || FURTHEST.indexOf(state.phase) < FURTHEST.indexOf(shown.phase)) sending.set(id, state);
  }
  const step = (id: StripStepId, at: number | null, note: StripNote | null = null): StripStep => {
    if (waiting.has(id)) return { id, state: "now", at, note: waiting.get(id) ?? note };
    const happened = at !== null || (note !== null && DONE_NOTES.has(note));
    // A send on its way lights a step that has not happened; it never undoes
    // one that has.
    const send = sending.get(id);
    if (!happened && send) return { id, state: "pending", at: null, note: null, send };
    return { id, state: happened ? "done" : "todo", at, note };
  };

  const matched = first(events.map((event) => (event.kind === "match" ? event.at : null)));
  const commented = first(
    events.map((event) => (event.kind === "our_comment" && event.status === "posted" ? event.at : null)),
  );
  const replied = first(events.map((event) => (event.kind === "their_reply" ? event.at : null)));
  const youReplied = first(
    events.map((event) => (event.kind === "our_reply" && !event.roomReply && event.status === "posted" ? event.at : null)),
  );
  const roomReply = first(events.map((event) => event.kind === "our_reply" && event.roomReply && event.status === "posted" ? event.at : null));
  const roomDraft = first(evidence.waits.filter((wait) => wait.kind === "room_reply_draft").map((wait) => wait.at));

  const invited = logged("invitation_confirmed");
  const invitedYou = first([logged("incoming_invitation_observed"), evidence.invitedYouAt]);
  const accepted = logged("invitation_accepted");
  const connected = evidence.relationship === "connected" || accepted !== null;
  const pending = evidence.relationship === "outgoing_pending" && invited !== null && accepted === null;
  // Connected with no acceptance on the log: since the read that first showed
  // it, where an earlier one showed them apart; else from before the account
  // touched them.
  const reads = evidence.log.filter((entry) => entry.type === "relationship_observed");
  const connectedRead = reads.find((entry) => entry.relationship === "connected");
  const apart: ReadonlySet<ConversationRelationship | undefined> = new Set([
    "not_connected",
    "outgoing_pending",
    "incoming_pending",
  ]);
  const connectedAt =
    accepted ??
    (connectedRead !== undefined && reads.some((entry) => entry.at < connectedRead.at && apart.has(entry.relationship))
      ? connectedRead.at
      : null);
  const closedAt =
    evidence.closed === null
      ? null
      : evidence.closed.reason === "opt_out"
        ? (logged("opt_out") ?? evidence.closed.at)
        : evidence.closed.at;
  const messaged = first([logged("dm_confirmed"), logged("inbound_message_observed")]);

  const steps: StripStep[] = [];
  const spotted = first(evidence.threads.map((thread) => thread.room?.readAt));
  if (spotted !== null) steps.push(step("spotted", spotted));
  else if (matched !== null) steps.push(step("matched", matched));
  if (spotted === null || commented !== null || waiting.has("commented") || sending.has("commented")) steps.push(step("commented", commented));
  if (spotted !== null || roomReply !== null || waiting.has("room_reply") || sending.has("room_reply")) {
    steps.push(step("room_reply", roomReply ?? roomDraft));
  }
  if (waiting.has("liked")) steps.push(step("liked", null));
  steps.push(step("replied", replied));
  if (youReplied !== null || sending.has("you_replied")) steps.push(step("you_replied", youReplied));
  // Their invitation stands in for ours; with neither, the invite is a step
  // only while it could still be how the two connect.
  if (invitedYou !== null || waiting.has("invited_you")) {
    steps.push(step("invited_you", invitedYou));
  } else if (invited !== null || waiting.has("invite") || sending.has("invite") || !connected) {
    steps.push(step("invite", invited, pending ? "pending" : null));
  }
  steps.push(
    connected
      ? step("connected", connectedAt, connectedAt === null ? "before_engager" : null)
      : step("connected", null, pending ? "pending" : null),
  );
  steps.push(
    evidence.closed !== null
      ? step("messages", closedAt, "closed")
      : step(
          "messages",
          messaged,
          evidence.ownerHeld
            ? "yours"
            : evidence.wake
              ? "waiting_on_them"
              : connected && messaged === null
                ? "none_yet"
                : null,
        ),
  );
  steps.push(
    evidence.outcome !== null
      ? step("outcome", evidence.outcome.at, evidence.outcome.kind)
      : evidence.closed?.reason === "opt_out"
        ? step("outcome", closedAt, "not_interested")
        : step("outcome", null),
  );
  return steps;
}

/** Everything a Find leads person's strip is cut from. */
export type LeadStripEvidence = {
  stage: LeadStage;
  /** When Scout first read words of theirs. */
  signalAt: number | null;
  /** When Scout read their profile. */
  researchedAt: number | null;
  /** When the first send that reached them settled. */
  contactedAt: number | null;
  /** Our sends to them on their way out and not confirmed. */
  sends: readonly Send[];
};

/**
 * The strip of a person Find leads found: Signal, Lead and Contacted, then the
 * steps they have not reached — Replied, Connected, Messages, Outcome — which
 * nobody on the Leads page has. Each of the three is `done` once its own
 * evidence happened, and where they stand is `now`: Signal for a Signal,
 * Contacted for Contacted and No answer. A Lead has Signal and Lead behind
 * them and nothing to wait on, so no step rings. A first send that is
 * approved and on its way lights Contacted as `pending` until LinkedIn
 * confirms it, as it does anywhere, and no step rings meanwhile: the person has
 * moved off the step they stood on and has not yet reached Contacted. A
 * Relationship has nowhere to stand here: the Inbox's strip is theirs. Pure.
 */
export function leadStripSteps(evidence: LeadStripEvidence): StripStep[] {
  const contacted = evidence.contactedAt !== null;
  const queued = !contacted && evidence.sends.length > 0;
  const standing: "signal" | "contacted" | null =
    evidence.stage === "relationship"
      ? null
      : contacted || queued || evidence.stage === "contacted" || evidence.stage === "no_answer"
        ? "contacted"
        : evidence.stage === "signal"
          ? "signal"
          : null;
  const send = queued
    ? evidence.sends.map((each) => each.state).sort((a, b) => FURTHEST.indexOf(a.phase) - FURTHEST.indexOf(b.phase))[0]
    : undefined;
  const step = (id: "signal" | "lead" | "contacted", at: number | null): StripStep => {
    if (id === "contacted" && send) return { id, state: "pending", at: null, note: null, send };
    if (id === standing) return { id, state: "now", at, note: null };
    return { id, state: at === null ? "todo" : "done", at, note: null };
  };
  return [
    step("signal", evidence.signalAt),
    step("lead", evidence.researchedAt),
    step("contacted", evidence.contactedAt),
    ...(["replied", "connected", "messages", "outcome"] as const).map(
      (id): StripStep => ({ id, state: "todo", at: null, note: null }),
    ),
  ];
}

/** What of a Find leads person the Inbox's strip reads, besides their
 *  conversation. */
export type FoundLeadEvidence = {
  signalAt: number | null;
  /** Null where Research never read them: a Signal written to directly. */
  researchedAt: number | null;
  /** The first send that reached them, and when it settled. */
  contacted: { kind: "comment" | "reply" | "invite"; at: number } | null;
};

const CONTACTED_BY: Record<"comment" | "reply" | "invite", StripNote> = {
  comment: "by_comment",
  reply: "by_reply",
  invite: "by_invite",
};

/** The steps today's strip reads past the first contact, which a Find leads
 *  person shares with everyone. */
const PAST_CONTACT: ReadonlySet<StripStepId> = new Set(["replied", "connected", "messages", "outcome"]);

/**
 * The Inbox's strip for a person Find leads found: Signal at their first
 * words, Lead where Research read them — a Signal written to directly goes
 * from Signal to Contacted — and Contacted at the first send that reached
 * them, saying which; then Replied, Connected, Messages and Outcome as their
 * own strip reads them (`stripSteps`), an invite after the first contact told
 * on Connected's line. Spotted, Matched, Commented, Room reply and Invite are
 * Find posts' path, not theirs. Pure.
 */
export function foundLeadStrip(today: readonly StripStep[], lead: FoundLeadEvidence): StripStep[] {
  const happened = (id: "signal" | "lead" | "contacted", at: number | null, note: StripNote | null = null): StripStep => ({
    id,
    state: at === null ? "todo" : "done",
    at,
    note,
  });
  return [
    happened("signal", lead.signalAt),
    ...(lead.researchedAt === null ? [] : [happened("lead", lead.researchedAt)]),
    happened("contacted", lead.contacted?.at ?? null, lead.contacted ? CONTACTED_BY[lead.contacted.kind] : null),
    ...today.filter((step) => PAST_CONTACT.has(step.id)),
  ];
}

/** What a strip is read with when the caller already holds it. */
export type StripKnown = {
  person?: Person;
  threads?: readonly PersonThread[];
  waits?: readonly Wait[];
  sends?: readonly Send[];
};

/**
 * A person's strip, read: their rows, their conversation where Engager keeps
 * one, what waits on the owner about them, and what of ours is on its way to
 * them. Null for a key nobody knows. A caller that already read the person,
 * their threads, their waits or their sends hands them in.
 */
export async function conversationStrip(tx: Tx, key: string, known: StripKnown = {}): Promise<StripStep[] | null> {
  const person = known.person ?? (await findPerson(tx, key));
  if (!person) return null;
  const threads = known.threads ?? (await readPersonThreads(tx, person.canonicalKey));
  const waits =
    known.waits ??
    (await waitingPeople(tx)).find((entry) => entry.person.canonicalKey === person.canonicalKey)?.waits ??
    [];
  const sends =
    known.sends ??
    (await readSends(tx, { conversationId: person.conversationId, messageIds: threads.flatMap((thread) => thread.messageIds) }));
  const [conversation] =
    person.conversationId === null ? [] : await tx.select().from(conversations).where(eq(conversations.id, person.conversationId));
  const log = conversation
    ? (
        await tx
          .select({ type: conversationEvents.type, at: conversationEvents.occurredAt, decision: conversationEvents.decision })
          .from(conversationEvents)
          .where(and(eq(conversationEvents.conversationId, conversation.id), inArray(conversationEvents.type, [...LOGGED])))
          .orderBy(asc(conversationEvents.occurredAt), asc(conversationEvents.id))
      ).map(
        (entry): StripLogEntry => ({
          type: entry.type,
          at: entry.at,
          ...(entry.type === "relationship_observed"
            ? { relationship: (entry.decision as { relationship?: ConversationRelationship } | null)?.relationship }
            : {}),
        }),
      )
    : [];
  const [outcome] =
    conversation?.outcomeEventId == null
      ? []
      : await tx
          .select({ at: outcomeEvents.occurredAt })
          .from(outcomeEvents)
          .where(eq(outcomeEvents.id, conversation.outcomeEventId));
  const [thread] =
    conversation?.canonicalDmThreadId == null
      ? []
      : await tx
          .select({ ownerHeldAt: dmThreads.ownerHeldAt })
          .from(dmThreads)
          .where(eq(dmThreads.id, conversation.canonicalDmThreadId));
  const [invitation] =
    person.profileId === null
      ? []
      : await tx
          .select({
            at: sql<number | null>`min(coalesce(${incomingInvitations.receivedAt}, ${incomingInvitations.firstObservedAt}))::float8`,
          })
          .from(incomingInvitations)
          .where(eq(incomingInvitations.senderProfileId, person.profileId));
  return stripSteps({
    threads,
    relationship: person.relationship,
    log,
    outcome: conversation?.outcome ? { kind: conversation.outcome, at: outcome?.at ?? null } : null,
    closed: conversation?.closedReason ? { reason: conversation.closedReason, at: conversation.closedAt } : null,
    invitedYouAt: invitation?.at ?? null,
    ownerHeld: thread?.ownerHeldAt != null,
    wake: conversation ? (await scheduledWakes(tx, { conversationIds: [conversation.id] })).length > 0 : false,
    waits,
    sends,
  });
}
