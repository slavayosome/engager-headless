import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  actionApprovals,
  actions,
  campaigns,
  channels,
  conversations,
  messages,
  rateLimitLedger,
  type ActionApprovalRow,
  type ActionAttempt,
  type ActionKind,
  type ActionRow,
  type Campaign,
  type Channel,
  type ConversationOpsStatus,
} from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import {
  approvalInvalidation,
  authorityIn,
  currentDependencies,
  strategyFor,
  invalidateApproval,
  liveApproval,
  lockAction,
  lockMessageOf,
  type InvalidationReason,
} from "../actions/approval";
import { enqueueActionDispatch } from "../actions/drain";
import { directMessageOperation, settleDirectMessage } from "../actions/dm";
import { ActionLedgerError } from "../actions/errors";
import { inviteOperation, settleInvitation } from "../actions/invite";
import { LIKE_SPENDS, likeTargetOperation, settleSendLike } from "../actions/likeTarget";
import { closeCommentJournal, commentOperation, markCommentPosting, settleComment } from "../actions/comment";
import { closeReplyJournal, markReplyPosting, repliesResponsively, replyOperation, settleReply } from "../actions/reply";
import { isMessageSend, type MessageSendKind } from "../actions/keys";
import { returnMessage } from "../actions/messageSend";
import { closeRoomReplyJournal, markRoomReplyPosting, roomReplyOperation, settleRoomReply } from "../actions/roomReply";
import { settleWithdrawal, withdrawInviteOperation } from "../actions/withdrawInvite";
import {
  lockPauses,
  ownerIsTheReview,
  pauseReasonCode,
  pausesTouching,
  pauseVerdict,
  scopesOf,
} from "../actions/pause";
import { countryRefusal } from "../audience/sendCountries";
import type { ConnectorBinding } from "../connector/binding";
import type { CapabilityKind } from "../connector/capabilities";
import type { CapabilitySurface } from "../connector/resolve";
import { nextWindowStart, withinWindows } from "../strategy/resolve";
import { acceptInviteOperation, settleAcceptance } from "../invitations/accept";
import { openedByUnreadRelationship } from "../conversations/eligibility";
import { nextUnreadRead, openReviewReasons } from "../conversations/review";
import { settleLiveCheck } from "../liveChecks/flow";
import { endLiveCheckWrites, firstSendWaits } from "../liveChecks/records";
import { trackSendSettled } from "../telemetry/emit";
import type { SEND_KINDS } from "@engager/observability/events";
import { canEngage, countSince } from "../ratelimit/ledger";
import { EVIDENCE, ownerAnswerOf, resolveOutcome, settleAnswered } from "../operations/outcomes";
import { askOwner, lookDue, READ_BEFORE_ASKING, RECONCILE_EXHAUSTED } from "./reconcileReads";
import {
  ExecutionAuthorityError,
  readExecutionAuthority,
  settleDispatch,
  type AuthorityToken,
} from "./authority";
import {
  assertAccountWritePolicy,
  dispatchAccountWrite,
  DispatchNotStartedError,
  DispatchPolicyError,
} from "./dispatch";

/**
 * THE ACTION GATE — the one path from an approved action to a click, and back
 * from the click to a settled row (spec §12 R09 "execution contract", §16;
 * INV-27, INV-29, INV-10, INV-13, INV-18).
 *
 * Immediately before the irreversible click it re-reads everything that may
 * have moved since the action was proposed and approved:
 *
 *   conversation     closed or the owner's own (takeover) → cancelled; held → held
 *   send        a like that rides a comment or reply of ours waits until that
 *               message is posted — held while it is not, cancelled when it
 *               never will be
 *   pauses      an open pause on any scope the action touches, or one written
 *               after the generation it was reserved under → cancelled
 *   countries   the person outside the campaign's Audience countries, or
 *               placed nowhere where it leaves those out → blocked; placed
 *               nowhere where it makes that the owner's call, an Automatic
 *               reservation waits for their yes (`audience/sendCountries.ts`)
 *   approval    one live approval whose words, target, facts, evidence,
 *               memory and authority still match (`actions/approval.ts`) —
 *               else the approval is invalidated and the action waits for a
 *               fresh yes; an Automatic reservation needs its binding to
 *               resolve Automatic still, and the account to have confirmed a
 *               first send of its kind (INV-31)
 *   ceilings    for unattended work, the account default's window → held,
 *               and its rolling-24h budget for the kind: spent, an
 *               owner's yes waits for room (held) and an Automatic
 *               reservation is dropped (`blocked`, `ceiling_reached`)
 *   canEngage   kill switch, entitlement, write authority, campaign status,
 *               exclusion, execution authority, spacing → held, or cancelled
 *               when permanent
 *   target      the owning phase's read of the action target's current state
 *               (`ActionOperation.preflight`) — gone → blocked; already done
 *               → confirmed with no click; not knowable now → held
 *
 * then takes the account's operation holder (`dispatchAccountWrite`) and the
 * org's pause lock (`lockPauses`), checks everything but the action target AGAIN
 * under both — the account's budget through `assertAccountWritePolicy`, as
 * every send does — and, in that same committed transaction, writes the row
 * `dispatching` with its fence, uses
 * the approval and mints the `rate_limit_ledger` receipt (INV-13: the channel
 * layer writes the budget row; the connector only answers). Only then the
 * click. The answer settles
 * the row: `confirmed`, `definitely_not_sent` and `blocked` release the
 * holder; `uncertain` keeps it, so no later write on the account goes out
 * until a reconciliation read or the owner's own eyes settle it — never a
 * blind retry (INV-10). A Stop that lands after `dispatching` was written
 * leaves the row where the click left it.
 *
 * `reconcileActions` runs before anything new: a `dispatching` row nobody is
 * clicking is one a crash interrupted, and becomes `uncertain`; each
 * `uncertain` row is put to its operation's read, never to its write.
 *
 * `ACTION_OPERATIONS` holds the kinds with a browser operation — Like
 * (Phase 48, `actions/likeTarget.ts`), Invite (Phase 50, `actions/invite.ts`),
 * Accept invite (Phase 51, `invitations/accept.ts`), DM and Follow-up
 * (Phase 53, `actions/dm.ts`), and the owner's Withdraw invite
 * (`actions/withdrawInvite.ts`); a kind without one holds at
 * `operation_unavailable` and nothing of it can be clicked.
 */

/** What the adapter answers for a click, or for a read of what a click did. A
 *  filled composer and a click are never a receipt (INV-31). */
export type ActionReceipt = {
  status: "confirmed" | "definitely_not_sent" | "uncertain" | "blocked";
  /** `confirmed` because the action target already stood that way: nothing was
   *  clicked, so the account spent nothing — the budget receipt the gate
   *  minted before the attempt settles as `noop` and counts as nothing. */
  noop?: true;
  evidence: Record<string, unknown>;
};

/** What the action target's read before the click came to: go ahead; an answer that
 *  needs no click; or nothing knowable right now — the row waits, approved. */
export type Preflight =
  | { proceed: true }
  | { proceed: false; receipt: ActionReceipt }
  | { proceed: false; hold: string; retryAt?: number };

/** The browser half of one kind, supplied by the phase that lands it. */
export type ActionOperation = {
  /** The action target's current state, read immediately before the click. A
   *  settled answer here means no click: `blocked` (gone, changed),
   *  `confirmed` (already done), `definitely_not_sent`. */
  preflight(row: ActionRow): Promise<Preflight>;
  /** The click and the re-read that confirms it. A throw is `uncertain`. */
  perform(row: ActionRow): Promise<ActionReceipt>;
  /** Read only: what became of an attempt whose outcome nobody knows; null
   *  when the read cannot tell. */
  reconcile(row: ActionRow): Promise<ActionReceipt | null>;
};

/** What the gate reaches the account through: the members of the kinds an
 *  operation performs — a like on a post or a comment, and the read of the
 *  thread a reply sits in — and, where an acceptance, an invitation or a DM
 *  waits, the invitations list, the acceptance, the send, the member's
 *  profile read, and the conversation read and its message; nothing else. */
export type ActionSurface = CapabilitySurface<(typeof ACTION_CAPABILITIES)[number]> &
  Partial<
    CapabilitySurface<
      | (typeof ACCEPT_CAPABILITIES)[number]
      | (typeof INVITE_CAPABILITIES)[number]
      | (typeof DM_CAPABILITIES)[number]
      | (typeof ROOM_REPLY_CAPABILITIES)[number]
      | (typeof REPLY_CAPABILITIES)[number]
      | (typeof COMMENT_CAPABILITIES)[number]
    >
  >;

/** The capabilities `ActionSurface` is granted from. */
export const ACTION_CAPABILITIES = ["like", "like_comment", "incoming"] as const satisfies readonly CapabilityKind[];

/** What Accept invite reaches the account through besides — granted only to a
 *  drain with an acceptance on the account (`actionCapabilitiesFor`), so an
 *  account whose connector reads no invitations still drains its likes. */
export const ACCEPT_CAPABILITIES = [
  "invitations_read",
  "invitations",
  "relationship",
] as const satisfies readonly CapabilityKind[];

/** What Invite reaches the account through besides — the member's profile,
 *  read again in the send's own session, and the send — granted the same way,
 *  only to a drain with an invitation, or the withdrawal of one, on the
 *  account. */
export const INVITE_CAPABILITIES = [
  "relationship",
  "invitations",
] as const satisfies readonly CapabilityKind[];

/** What a DM and a follow-up reach the account through besides — the
 *  conversation, read again in the send's own session, and the message —
 *  granted the same way, only to a drain with one on the account. */
export const DM_CAPABILITIES = ["dm_read", "dm"] as const satisfies readonly CapabilityKind[];

/** What a room reply reaches the account through: the write, with the read of
 *  what an uncertain one did — granted only to a drain with one on the account. */
export const ROOM_REPLY_CAPABILITIES = ["room_reply"] as const satisfies readonly CapabilityKind[];

/** And a public reply's, the same way. */
export const REPLY_CAPABILITIES = ["reply"] as const satisfies readonly CapabilityKind[];

/** And a comment's. */
export const COMMENT_CAPABILITIES = ["comment"] as const satisfies readonly CapabilityKind[];

type ActionCapability =
  | (typeof ACTION_CAPABILITIES)[number]
  | (typeof ACCEPT_CAPABILITIES)[number]
  | (typeof INVITE_CAPABILITIES)[number]
  | (typeof DM_CAPABILITIES)[number]
  | (typeof ROOM_REPLY_CAPABILITIES)[number]
  | (typeof REPLY_CAPABILITIES)[number]
  | (typeof COMMENT_CAPABILITIES)[number];

/** The capabilities a drain of this account needs: the likes' always, an
 *  acceptance's, an invitation's, a DM's, a comment's or a reply's when one is
 *  queued or unsettled on it. */
export async function actionCapabilitiesFor(
  tx: Tx,
  channelId: number,
): Promise<readonly [ActionCapability, ...ActionCapability[]]> {
  const waiting = await tx
    .selectDistinct({ kind: actions.kind })
    .from(actions)
    .where(
      and(
        eq(actions.channelId, channelId),
        inArray(actions.kind, ["accept_invite", "invite", "withdraw_invite", "dm", "followup", "room_reply", "reply", "comment"]),
        inArray(actions.status, ["approved", "reserved", "dispatching", "uncertain"]),
      ),
    );
  const kinds = new Set(waiting.map((row) => row.kind));
  const besides = new Set<ActionCapability>([
    ...(kinds.has("accept_invite") ? ACCEPT_CAPABILITIES : []),
    ...(kinds.has("invite") || kinds.has("withdraw_invite") ? INVITE_CAPABILITIES : []),
    ...(kinds.has("dm") || kinds.has("followup") ? DM_CAPABILITIES : []),
    ...(kinds.has("room_reply") ? ROOM_REPLY_CAPABILITIES : []),
    ...(kinds.has("reply") ? REPLY_CAPABILITIES : []),
    ...(kinds.has("comment") ? COMMENT_CAPABILITIES : []),
  ]);
  return [...ACTION_CAPABILITIES, ...besides];
}

/** What an operation is made with besides its driver. */
export type OperationContext = {
  organizationId: string;
  now: () => number;
  /** The connector the drain's grant came through, whose declaration says
   *  whether a write can be asked about afterwards (`isExactlyOnceWrite`). */
  connector?: ConnectorBinding | null;
  /** Makes a read once for the whole drain: `read` runs the first time `key`
   *  is asked, and every later ask in that drain gets the same answer. Absent
   *  on an action dispatched on its own, which reads for itself. */
  once?: <T>(key: string, read: () => Promise<T>) => Promise<T>;
};

export type ActionOperations = Partial<
  Record<ActionKind, (driver: ActionSurface, context: OperationContext) => ActionOperation>
>;

/** What one drain has read so far, by the key the operations asked it under. */
type DrainReads = Map<string, Promise<unknown>>;

function onceIn(reads: DrainReads): NonNullable<OperationContext["once"]> {
  return <T>(key: string, read: () => Promise<T>): Promise<T> => {
    const asked = reads.get(key) as Promise<T> | undefined;
    if (asked) return asked;
    const made = read();
    reads.set(key, made);
    return made;
  };
}

/** Every kind's browser operation, by the phase that lands it. */
export const ACTION_OPERATIONS: ActionOperations = {
  like_target: likeTargetOperation,
  accept_invite: acceptInviteOperation,
  // Phase 50: the Ambassador's Invite. Until the account confirms its first
  // send, each one goes out only on the owner's yes (`admit`).
  invite: inviteOperation,
  // Phase 53: the Ambassador's DM and Follow-up — one operation, for a
  // follow-up is a DM. Held to DM's first send the same way.
  dm: directMessageOperation,
  followup: directMessageOperation,
  // The owner's Withdraw invite: never a step's, always the owner's press.
  withdraw_invite: withdrawInviteOperation,
  // A reply under a room member's comment (`actions/roomReply.ts`).
  room_reply: roomReplyOperation,
  // A public reply to someone who answered the owner (`actions/reply.ts`).
  reply: replyOperation,
  // A comment on a post (`actions/comment.ts`).
  comment: commentOperation,
};

/** The sidecar journal each message send keeps its attempt in, closed on the
 *  owner's answer. */
const MESSAGE_JOURNALS = {
  comment: closeCommentJournal,
  reply: closeReplyJournal,
  room_reply: closeRoomReplyJournal,
} as const satisfies Record<MessageSendKind, typeof closeCommentJournal>;

/** What a settled action of a kind does beyond its own row — the conversation fact
 *  its receipt proves — in the transaction that settles it, whoever settled
 *  it: the gate, a reconciliation read, the owner. */
export type ActionSettlement = (
  tx: Tx,
  row: ActionRow,
  receipt: ActionReceipt,
  now: number,
) => Promise<void>;

export const ACTION_SETTLEMENTS: Partial<Record<ActionKind, ActionSettlement>> = {
  like_target: settleSendLike,
  accept_invite: settleAcceptance,
  invite: settleInvitation,
  dm: settleDirectMessage,
  followup: settleDirectMessage,
  withdraw_invite: settleWithdrawal,
  room_reply: settleRoomReply,
  reply: settleReply,
  comment: settleComment,
};

export type GateOptions = {
  organizationId: string;
  driver: ActionSurface;
  operations?: ActionOperations;
  now?: () => number;
  connector?: ConnectorBinding | null;
  /** Re-checked in the transaction that writes `dispatching`, beside
   *  everything else — a job's hosted-spend fence. */
  authorizeStartInTx?: (tx: Tx) => Promise<void>;
};

export type GateOutcome =
  | {
      /** `blocked` here is the gate's own answer, before any read or click:
       *  an Automatic reservation past the account's ceiling. */
      status: "cancelled" | "held" | "awaiting_review" | "not_queued" | "blocked";
      reason: string;
      retryAt?: number;
      /** A hold on this action alone — its conversation is held, its action target
       *  cannot be read right now — which the rest of the account's queue
       *  goes on past. Absent, a hold is the account's. */
      scope?: "action";
    }
  | { status: ActionReceipt["status"]; receipt: ActionReceipt; clicked: boolean };

type Refusal =
  | { kind: "cancel"; reason: string }
  /** Settled `blocked` with nothing read or clicked: an Automatic reservation
   *  the account's ceiling has no room for, so it never waits to go out later
   *  in a burst (spec §16 R12); or a person the Audience's countries leave
   *  out, `outside_countries:<code>` or `country_unknown`. */
  | { kind: "block"; reason: string }
  | { kind: "hold"; reason: string; retryAt?: number; scope?: "action" }
  | { kind: "review"; reason: string }
  /** `shown` is the reason the row keeps, where a better one than the
   *  invalidation's says why: the mode the action was switched to. */
  | { kind: "invalidate"; approval: ActionApprovalRow; reason: InvalidationReason; shown?: string }
  /** Something else already moved the row out of the queue — a Stop, a
   *  skip — and its own reason stands. */
  | { kind: "not_queued"; reason: string };

type Admitted = {
  kind: "admit";
  row: ActionRow;
  approval: ActionApprovalRow | null;
  /** Null only for the owner's own act that rides no campaign. */
  campaign: Campaign | null;
  channel: Channel;
};

class GateRefusal extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.reason);
    this.name = "GateRefusal";
  }
}

const DAY = 24 * 60 * 60_000;

/** What a receipt in `rate_limit_ledger` says of the action it meters. Only
 *  `confirmed` is spent (`completedLedgerActionPredicate`); `noop` is an
 *  attempt that found its action target already that way and clicked nothing. */
export type ActionLedgerReceiptMeta = {
  kind: "action_execution_receipt";
  actionExecutionId: number;
  operationId: string;
  state: "dispatching" | ActionReceipt["status"] | "noop";
  settledAt?: number;
};

/** The kinds whose read before the click is the person's own profile, which
 *  places them: an invitation's (`actions/invite.ts`). Withdrawing one reaches
 *  nobody new, and is never held to the Audience's countries. */
const PLACED_BY_PREFLIGHT: ReadonlySet<ActionKind> = new Set(["invite"]);
const REACHES_NOBODY: ReadonlySet<ActionKind> = new Set(["withdraw_invite"]);

/** The hold on unattended work in a conversation that waits on the owner
 *  only because a read of the person could not tell whether the two are
 *  connected: what it waits on is that read, never a person's look. */
export const RELATIONSHIP_UNREAD_HOLD = "conversation_relationship_unread";

/**
 * What holds a row in a conversation that is not runnable, and when it may go
 * to the preflight's read of the person again. A review opened by a read that
 * could not tell and by nothing else holds it on that read
 * (`RELATIONSHIP_UNREAD_HOLD`), and an invitation so held reads again once the
 * pace allows (`nextUnreadRead`): the read is what lifts it, and the gate
 * holding the invitation first would never make one. Any other hold is the
 * conversation's state, which a person or a Resume lifts, and reads nothing.
 */
async function conversationHold(
  tx: Tx,
  row: ActionRow,
  opsStatus: ConversationOpsStatus,
  now: number,
): Promise<{ reason: string; readsAt: number | null }> {
  const held = { reason: `conversation_${opsStatus}`, readsAt: null };
  if (row.conversationId === null || opsStatus !== "awaiting_review") return held;
  const reasons = await openReviewReasons(tx, { id: row.conversationId, opsStatus });
  if (!openedByUnreadRelationship(reasons)) return held;
  return {
    reason: RELATIONSHIP_UNREAD_HOLD,
    readsAt: row.kind === "invite" ? await nextUnreadRead(tx, row.conversationId, now) : null,
  };
}

/**
 * Everything the gate re-reads, short of the action target and the account budget —
 * the same function before the holder and under it. Before the holder, a
 * country the preflight's read is about to place is left to the pass under
 * it (`placeReadComing`).
 */
async function admit(
  tx: Tx,
  row: ActionRow,
  now: number,
  placeReadComing = false,
): Promise<Admitted | Refusal> {
  if (row.status !== "approved" && row.status !== "reserved") {
    return { kind: "not_queued", reason: row.status };
  }
  if (row.conversationId !== null) {
    const [conversation] = await tx
      .select({ closedReason: conversations.closedReason, opsStatus: conversations.opsStatus })
      .from(conversations)
      .where(eq(conversations.id, row.conversationId));
    if (!conversation) return { kind: "cancel", reason: "conversation_gone" };
    if (conversation.closedReason !== null) return { kind: "cancel", reason: "conversation_closed" };
    if (conversation.opsStatus === "human_owned") return { kind: "cancel", reason: "human_owned" };
    if (conversation.opsStatus !== "runnable" && !ownerIsTheReview(row.origin, conversation.opsStatus)) {
      // An invitation held only for a read that could not tell reads again
      // itself once its pace allows — nothing else would ever lift that.
      const { reason, readsAt } = await conversationHold(tx, row, conversation.opsStatus, now);
      if (readsAt === null || readsAt > now) {
        return { kind: "hold", reason, scope: "action", ...(readsAt === null ? {} : { retryAt: readsAt }) };
      }
    }
  }
  if (row.messageId !== null && row.kind === "like_target") {
    const [send] = await tx.select({ status: messages.status }).from(messages).where(eq(messages.id, row.messageId));
    if (!send || send.status === "failed" || send.status === "rejected" || send.status === "suppressed_dryrun") {
      return { kind: "cancel", reason: "send_not_posted" };
    }
    // An uncertain send keeps its like waiting: whether it went out is the
    // owner's to say first.
    if (send.status !== "posted") return { kind: "hold", reason: "send_unconfirmed", scope: "action" };
  }
  const paused = pauseVerdict(
    await pausesTouching(tx, scopesOf(row), row.generationSeen),
    row.generationSeen,
  );
  if (paused) return { kind: "cancel", reason: pauseReasonCode(paused) };

  // An owner's press on someone no campaign touched belongs to none: it has
  // no campaign to be gone. Anything else with no campaign lost the one that
  // proposed it (a deleted campaign cancels its own queue first).
  const [campaign] =
    row.campaignId === null
      ? []
      : await tx.select().from(campaigns).where(eq(campaigns.id, row.campaignId));
  if (!campaign && !(row.campaignId === null && row.origin === "owner")) {
    return { kind: "cancel", reason: "campaign_gone" };
  }
  const [channel] = await tx.select().from(channels).where(eq(channels.id, row.channelId));
  if (!channel) return { kind: "cancel", reason: "account_gone" };

  // Ahead of the first send's ask: a person the countries leave out is never
  // one to ask the owner about. An approved row carries their yes, which is
  // their call on a person placed nowhere.
  const place = REACHES_NOBODY.has(row.kind)
    ? null
    : await countryRefusal(tx, {
        campaign: campaign ?? null,
        profileId: row.authorProfileId,
        memberUrn: row.target.memberUrn,
        ownerSaidYes: row.status === "approved",
        readComing: placeReadComing,
        now,
      });
  if (place?.kind === "refuse") {
    return { kind: "block", reason: place.code === "outside_countries" ? `${place.code}:${place.country}` : place.code };
  }
  if (place) return { kind: "review", reason: place.code };
  // Until the account confirms a first send of its kind, a write goes out
  // only on the owner's yes: an Automatic reservation waits for one (INV-31).
  const strategy = await strategyFor(tx, row);
  const current = await currentDependencies(tx, row, await authorityIn(tx, row));
  if (row.status === "reserved" && row.actionBindingId !== null && current.authority === "off") return { kind: "review", reason: "mode_off" };
  if (row.status === "reserved" && (await firstSendWaits(tx, row))) {
    return { kind: "review", reason: "review_required" };
  }
  let approval: ActionApprovalRow | null = null;
  if (row.status === "reserved") {
    // An Automatic reservation is approved by its mode alone, so the mode has
    // to say so still; anything less sends it to the owner.
    if (current.authority !== "auto") return { kind: "review", reason: current.authority === "off" ? "mode_off" : "review_required" };
    // Nor is an offer the owner retired or reworded since made on its own.
    const offer = row.candidate.versions.offer;
    if (offer !== undefined && current.offer !== offer.contentHash) {
      return { kind: "cancel", reason: "cta_unapproved" };
    }
  } else {
    approval = await liveApproval(tx, row.id);
    if (!approval) return { kind: "review", reason: "approval_missing" };
    const invalid = approvalInvalidation(approval, current, now);
    if (invalid) return { kind: "invalidate", approval, reason: invalid, ...(invalid === "authority" && current.authority === "off" ? { shown: "mode_off" } : {}) };
  }

  // What binds unattended work and only unattended work (INV-1): the account
  // default's window — none set, or no default at all, holds nothing — and its
  // rolling-24h budget for the kind. A null budget
  // caps nothing here — it is what keeps Automatic unreachable upstream
  // (INV-28) — and an owner's own action is only spaced. The budget counts
  // every confirmed send of the kind on the account, the owner's included —
  // for a like, every like (`LIKE_SPENDS`), one that went out with a comment
  // as much as one of its own.
  if (row.origin === "worker") {
    const account = strategy?.accountDefault ?? null;
    if (!withinWindows(account?.schedule, now)) {
      // Held to the next window's opening, where the drain looks again.
      const opens = nextWindowStart(account?.schedule, now);
      return { kind: "hold", reason: "outside_window", ...(opens === null ? {} : { retryAt: opens }) };
    }
    const budgets: Partial<Record<ActionKind, number | null>> | undefined =
      account?.budgets?.action_budgets_per_rolling_24h;
    const budget = budgets?.[row.kind] ?? null;
    if (
      budget !== null &&
      (await countSince(
        tx,
        { channelId: row.channelId },
        row.kind === "like_target" ? [...LIKE_SPENDS] : [row.kind],
        now - DAY,
        {},
      )) >= budget
    ) {
      // A yes the owner gave waits for room; an Automatic reservation, which
      // nobody said yes to, is dropped rather than kept to burst later.
      return row.status === "reserved"
        ? { kind: "block", reason: "ceiling_reached" }
        : { kind: "hold", reason: "action_budget_24h" };
    }
  }
  return { kind: "admit", row, approval, campaign: campaign ?? null, channel };
}

/** Write what a refusal means for the row. */
async function applyRefusal(tx: Tx, row: ActionRow, refusal: Refusal, now: number) {
  await applyToRow(tx, row, refusal, now);
  // A reply's message follows its action out of the queue.
  if (
    isMessageSend(row.kind) &&
    (refusal.kind === "review" || refusal.kind === "invalidate" || refusal.kind === "cancel" || refusal.kind === "block")
  ) {
    await returnMessage(tx, row, { kind: refusal.kind, reason: refusal.kind === "invalidate" ? refusal.shown ?? `approval_invalidated:${refusal.reason}` : refusal.reason }, now);
  }
}

async function applyToRow(tx: Tx, row: ActionRow, refusal: Refusal, now: number) {
  switch (refusal.kind) {
    case "not_queued":
      return;
    case "invalidate":
      await invalidateApproval(tx, refusal.approval, refusal.reason, now);
      if (refusal.shown) {
        await tx.update(actions).set({ statusReason: refusal.shown })
          .where(and(eq(actions.id, row.id), eq(actions.status, "awaiting_review")));
      }
      return;
    case "review":
      await tx
        .update(actions)
        .set({ status: "awaiting_review", statusReason: refusal.reason, updatedAt: now })
        .where(eq(actions.id, row.id));
      return;
    case "hold":
      await tx
        .update(actions)
        .set({ statusReason: `held:${refusal.reason}`, updatedAt: now })
        .where(eq(actions.id, row.id));
      return;
    case "block":
      await tx
        .update(actions)
        .set({ status: "blocked", statusReason: refusal.reason, settledAt: now, updatedAt: now })
        .where(eq(actions.id, row.id));
      await endLiveCheckWrites(tx, [row.id], "blocked", now);
      return;
    case "cancel": {
      await tx
        .update(actions)
        .set({ status: "cancelled", statusReason: refusal.reason, settledAt: now, updatedAt: now })
        .where(eq(actions.id, row.id));
      await endLiveCheckWrites(tx, [row.id], "cancelled", now);
      const approval = await liveApproval(tx, row.id);
      if (approval) {
        await tx
          .update(actionApprovals)
          .set({ invalidatedAt: now, invalidatedReason: refusal.reason })
          .where(eq(actionApprovals.id, approval.id));
      }
      return;
    }
  }
}

function outcomeOf(refusal: Refusal): GateOutcome {
  switch (refusal.kind) {
    case "not_queued":
      return { status: "not_queued", reason: refusal.reason };
    case "cancel":
      return { status: "cancelled", reason: refusal.reason };
    case "block":
      return { status: "blocked", reason: refusal.reason };
    case "hold":
      return {
        status: "held",
        reason: refusal.reason,
        ...(refusal.retryAt === undefined ? {} : { retryAt: refusal.retryAt }),
        ...(refusal.scope === undefined ? {} : { scope: refusal.scope }),
      };
    case "review":
      return { status: "awaiting_review", reason: refusal.reason };
    case "invalidate":
      return { status: "awaiting_review", reason: refusal.shown ?? `approval_invalidated:${refusal.reason}` };
  }
}

/** A `canEngage` refusal, as the gate answers it: permanent ones end the
 *  action, the rest hold it for their retry. */
function engageRefusal(reason: string, permanent: boolean, retryAt?: number): Refusal {
  return permanent
    ? { kind: "cancel", reason }
    : { kind: "hold", reason, ...(retryAt === undefined ? {} : { retryAt }) };
}

/** The row before the click: `dispatching` under its fence, the approval
 *  used, and the account's budget receipt minted — one transaction. */
async function markDispatching(
  tx: Tx,
  admitted: Admitted,
  operationId: string,
  token: AuthorityToken,
  now: number,
): Promise<ActionRow> {
  const { row } = admitted;
  const attempt: ActionAttempt = {
    attempt: row.attempts.length + 1,
    operationId,
    epoch: token.epoch,
    startedAt: now,
    settledAt: null,
    outcome: null,
    settledBy: null,
    evidence: null,
  };
  const [dispatching] = await tx
    .update(actions)
    .set({
      status: "dispatching",
      statusReason: null,
      fenceToken: operationId,
      submittedAt: now,
      attempts: [...row.attempts, attempt],
      // A new attempt's outcome is read afresh.
      reconcileAttempts: 0,
      lastReconcileAt: null,
      updatedAt: now,
    })
    .where(eq(actions.id, row.id))
    .returning();
  if (row.kind === "room_reply" && !(await markRoomReplyPosting(tx, row, now))) {
    throw new GateRefusal({ kind: "cancel", reason: "message_moved" });
  }
  const stopped = row.kind === "reply" ? await markReplyPosting(tx, row, now) : row.kind === "comment" ? await markCommentPosting(tx, row, now) : null;
  if (stopped) throw new GateRefusal(stopped);
  if (admitted.approval) {
    await tx
      .update(actionApprovals)
      .set({ usedAt: now })
      .where(eq(actionApprovals.id, admitted.approval.id));
  }
  await tx.insert(rateLimitLedger).values({
    action: row.kind,
    channelId: row.channelId,
    campaignId: row.campaignId,
    targetProfileId: row.authorProfileId,
    meta: {
      kind: "action_execution_receipt",
      actionExecutionId: row.id,
      operationId,
      state: "dispatching",
    } satisfies ActionLedgerReceiptMeta,
  });
  return dispatching!;
}

/** The catalog's word for an action: a like is of a post or of a comment. */
type SendKindName = (typeof SEND_KINDS)[number];

function sendKindOf(row: ActionRow): SendKindName {
  switch (row.kind) {
    case "like_target":
      return row.target.kind === "post" ? "like_post" : "like_reply";
    case "accept_invite":
      return "accept";
    case "withdraw_invite":
      return "withdraw";
    case "followup":
      return "dm";
    default:
      return row.kind;
  }
}

/**
 * Settle one attempt from its answer — the click's, a reconciliation read's
 * or the owner's. Only the attempt the row is fenced to can be settled, and
 * only while its outcome is open; a definite answer arriving after a
 * reconciler marked it `uncertain` still lands. The holder is released for
 * every answer but `uncertain`.
 */
export async function settleAction(
  tx: Tx,
  input: {
    id: number;
    operationId: string;
    receipt: ActionReceipt;
    settledBy: NonNullable<ActionAttempt["settledBy"]>;
    /** Why an `uncertain` answer is one: the click's error, an interrupted
     *  dispatch. */
    reason?: string;
    now: number;
  },
): Promise<ActionRow | null> {
  await lockMessageOf(tx, input.id);
  const [row] = await tx
    .select()
    .from(actions)
    .where(
      and(
        eq(actions.id, input.id),
        eq(actions.fenceToken, input.operationId),
        inArray(actions.status, ["dispatching", "uncertain"]),
      ),
    )
    .for("update");
  if (!row) return null;
  const { receipt, now } = input;
  const settled = receipt.status !== "uncertain";
  // A no-op is only a confirmation: anything else that says it clicked
  // nothing is a contradiction, and settles as what it says.
  const noop = receipt.noop === true && receipt.status === "confirmed";
  const [after] = await tx
    .update(actions)
    .set({
      status: receipt.status,
      statusReason: receipt.status === "uncertain" ? (input.reason ?? "outcome_unknown") : null,
      externalReceipt: {
        ...receipt.evidence,
        status: receipt.status,
        ...(noop ? { noop: true } : {}),
        settledBy: input.settledBy,
      },
      attempts: row.attempts.map((attempt) =>
        attempt.operationId === input.operationId
          ? {
              ...attempt,
              settledAt: now,
              outcome: receipt.status,
              settledBy: input.settledBy,
              evidence: receipt.evidence,
            }
          : attempt,
      ),
      settledAt: settled ? now : null,
      updatedAt: now,
    })
    .where(eq(actions.id, row.id))
    .returning();
  // The budget row the gate minted before the attempt settles with it: spent
  // when the click confirmed, and nothing when the action target already stood that
  // way — an attempt that pressed nothing exposes nothing.
  await tx
    .update(rateLimitLedger)
    .set({
      ...(receipt.status === "confirmed" && !noop ? { ts: now } : {}),
      meta: sql`${rateLimitLedger.meta} || ${JSON.stringify({ state: noop ? "noop" : receipt.status, settledAt: now })}::jsonb`,
    })
    .where(
      and(
        sql`${rateLimitLedger.meta} ->> 'kind' = 'action_execution_receipt'`,
        sql`${rateLimitLedger.meta} ->> 'operationId' = ${input.operationId}`,
      ),
    );
  if (row.conversationId !== null) await moveConversation(tx, row.conversationId, receipt.status, now);
  await ACTION_SETTLEMENTS[after!.kind]?.(tx, after!, receipt, now);
  await settleLiveCheck(tx, after!, receipt, { by: input.settledBy, clicked: true, now });
  if (settled) await settleDispatch(tx, row.channelId, input.operationId);
  // Usage data. A confirmation that pressed nothing is not a send.
  if (!noop) {
    const attempt = row.attempts.find((candidate) => candidate.operationId === input.operationId);
    const evidenceReason = receipt.evidence.reason ?? receipt.evidence.code;
    trackSendSettled(
      {
        kind: sendKindOf(after!),
        outcome:
          receipt.status === "confirmed"
            ? "confirmed"
            : receipt.status === "uncertain"
              ? "uncertain"
              : receipt.status === "definitely_not_sent"
                ? "not_sent"
                : "failed",
        reason: input.reason ?? evidenceReason ?? receipt.status,
        origin: after!.origin === "owner" ? "owner" : "worker",
        startedAt: attempt?.startedAt ?? null,
        settledAt: now,
      },
      tx,
    );
  }
  return after!;
}

/**
 * An unsettled send holds its conversation (`uncertain` is sticky, INV-10):
 * nothing more is said to the person until it is known whether this landed.
 * A settled answer lifts that hold once nothing else on the conversation is open.
 * The owner's own hold is never touched.
 */
async function moveConversation(
  tx: Tx,
  conversationId: number,
  status: ActionReceipt["status"],
  now: number,
): Promise<void> {
  if (status === "uncertain") {
    await tx
      .update(conversations)
      .set({ opsStatus: "uncertain", opsStatusAt: now, updatedAt: now })
      .where(and(eq(conversations.id, conversationId), inArray(conversations.opsStatus, ["runnable", "awaiting_review", "paused"])));
    return;
  }
  const [open] = await tx
    .select({ id: actions.id })
    .from(actions)
    .where(
      and(
        eq(actions.conversationId, conversationId),
        inArray(actions.status, ["dispatching", "uncertain"]),
      ),
    )
    .limit(1);
  if (open) return;
  await tx
    .update(conversations)
    .set({ opsStatus: "runnable", opsStatusAt: now, updatedAt: now })
    .where(and(eq(conversations.id, conversationId), eq(conversations.opsStatus, "uncertain")));
}

/**
 * Take one approved (or Automatic-reserved) action through the gate. Returns
 * what became of it; writes every refusal on the row with its reason.
 */
export async function dispatchAction(
  opts: GateOptions,
  id: number,
  reads?: DrainReads,
): Promise<GateOutcome> {
  const now = opts.now ?? Date.now;
  const org = opts.organizationId;
  const operations = opts.operations ?? ACTION_OPERATIONS;

  const checked = await withOrg(org, async (tx) => {
    const row = await lockAction(tx, id);
    let decision = await admit(tx, row, now(), PLACED_BY_PREFLIGHT.has(row.kind));
    if (decision.kind === "admit") {
      const engage = await canEngage({
        action: row.kind,
        campaign: decision.campaign,
        channel: decision.channel,
        origin: row.origin,
        // An owner row is a press on the dashboard: only those ride a Pause.
        pressed: row.origin === "owner",
        profileId: row.authorProfileId,
        memberUrn: row.target.memberUrn,
        responsive: repliesResponsively(row),
        db: tx,
        now: now(),
      });
      if (!engage.ok) decision = engageRefusal(engage.reason, engage.permanent === true, engage.retryAt);
      else if (!operations[row.kind]) decision = { kind: "hold", reason: "operation_unavailable" };
    }
    if (decision.kind !== "admit") {
      await applyRefusal(tx, row, decision, now());
      return { kind: "done" as const, outcome: outcomeOf(decision) };
    }
    return { kind: "ready" as const, row };
  });
  if (checked.kind === "done") return checked.outcome;
  const operation = operations[checked.row.kind]!(opts.driver, {
    organizationId: org,
    now,
    connector: opts.connector,
    ...(reads ? { once: onceIn(reads) } : {}),
  });

  const preflight = await operation.preflight(checked.row);
  if (!preflight.proceed && "hold" in preflight) {
    // an action target that cannot be read now holds its own action: the next one on
    // the account may need no read at all.
    const refusal: Refusal = {
      kind: "hold",
      reason: preflight.hold,
      scope: "action",
      ...(preflight.retryAt === undefined ? {} : { retryAt: preflight.retryAt }),
    };
    const held = await withOrg(org, async (tx) => {
      const row = await lockAction(tx, id);
      // A Stop or a skip that landed during the read has its own reason.
      if (row.status !== "approved" && row.status !== "reserved") return false;
      await applyRefusal(tx, row, refusal, now());
      return true;
    });
    return held ? outcomeOf(refusal) : { status: "not_queued", reason: "moved_during_preflight" };
  }
  if (!preflight.proceed) {
    const { receipt } = preflight;
    const answered = await withOrg(org, (tx) =>
      settleWithoutClick(tx, checked.row.id, receipt, now()),
    );
    return answered
      ? { status: receipt.status, receipt, clicked: false }
      : { status: "not_queued", reason: "moved_during_preflight" };
  }

  const authority = await withOrg(org, (tx) => readExecutionAuthority(tx, checked.row.channelId));
  if (!authority.allowed) {
    const refusal: Refusal = { kind: "hold", reason: `authority:${authority.reason}` };
    await withOrg(org, async (tx) => applyRefusal(tx, await lockAction(tx, id), refusal, now()));
    return outcomeOf(refusal);
  }
  const operationId = `action:${id}:${checked.row.attempts.length + 1}`;
  let dispatched: ActionRow | null = null;
  let receipt: ActionReceipt;
  try {
    await dispatchAccountWrite({
      orgScope: (fn) => withOrg(org, fn),
      token: authority.token,
      operationId,
      origin: checked.row.origin,
      session: () => opts.driver.ensureSession(),
      authorize: async (tx) => {
        // The pause lock first, then the row: a Stop or a takeover either
        // committed before these reads, or waits for this transaction and
        // finds the row past the click.
        await lockPauses(tx);
        const decision = await admit(tx, await lockAction(tx, id), now());
        if (decision.kind !== "admit") throw new GateRefusal(decision);
        await assertAccountWritePolicy(tx, {
          channelId: decision.row.channelId,
          campaignId: decision.row.campaignId,
          action: decision.row.kind,
          origin: decision.row.origin,
          pressed: decision.row.origin === "owner",
          profileId: decision.row.authorProfileId,
          memberUrn: decision.row.target.memberUrn,
          responsive: repliesResponsively(decision.row),
        });
        await opts.authorizeStartInTx?.(tx);
        dispatched = await markDispatching(tx, decision, operationId, authority.token, now());
      },
      write: async () => {
        receipt = await operation.perform(dispatched!);
        return { ok: receipt.status === "confirmed" };
      },
    });
  } catch (error) {
    if (error instanceof DispatchNotStartedError) {
      // Nothing was clicked, and the transaction that would have written
      // `dispatching` rolled back: the row is where it was, and the refusal
      // says why.
      const refusal = notStarted(error);
      await withOrg(org, async (tx) => applyRefusal(tx, await lockAction(tx, id), refusal, now()));
      return outcomeOf(refusal);
    }
    receipt = {
      status: "uncertain",
      evidence: { error: error instanceof Error ? error.message : String(error) },
    };
  }
  const settled = receipt!;
  await withOrg(org, (tx) =>
    settleAction(tx, { id, operationId, receipt: settled, settledBy: "gate", now: now() }),
  );
  return { status: settled.status, receipt: settled, clicked: true };
}

/** What a refusal before the provider means for the row. */
function notStarted(error: DispatchNotStartedError): Refusal {
  const cause = error.cause;
  if (cause instanceof GateRefusal) return cause.refusal;
  if (cause instanceof DispatchPolicyError) {
    return engageRefusal(
      cause.reason,
      cause.reason === "do_not_engage" || cause.reason === "campaign_archived",
    );
  }
  if (cause instanceof ExecutionAuthorityError) return { kind: "hold", reason: `authority:${cause.reason}` };
  return { kind: "hold", reason: error.message };
}

/** The action target answered before any click: the approval is spent on that
 *  answer, and the row settles without a fence or a budget row — unless
 *  something else took it out of the queue meanwhile, whose answer stands.
 *  False when it had. */
async function settleWithoutClick(
  tx: Tx,
  id: number,
  receipt: ActionReceipt,
  now: number,
): Promise<boolean> {
  if (receipt.status === "uncertain") {
    throw new Error("a preflight read that cannot tell is not a settled answer");
  }
  const row = await lockAction(tx, id);
  if (row.status !== "approved" && row.status !== "reserved") return false;
  const approval = await liveApproval(tx, row.id);
  if (approval) {
    await tx.update(actionApprovals).set({ usedAt: now }).where(eq(actionApprovals.id, approval.id));
  }
  const [settled] = await tx
    .update(actions)
    .set({
      status: receipt.status,
      statusReason: "preflight",
      externalReceipt: {
        ...receipt.evidence,
        status: receipt.status,
        ...(receipt.noop === true && receipt.status === "confirmed" ? { noop: true } : {}),
        settledBy: "gate",
      },
      settledAt: now,
      updatedAt: now,
    })
    .where(eq(actions.id, row.id))
    .returning();
  await ACTION_SETTLEMENTS[settled!.kind]?.(tx, settled!, receipt, now);
  await settleLiveCheck(tx, settled!, receipt, { by: "gate", clicked: false, now });
  return true;
}

export type ReconcileSummary = {
  /** Rows a crash left `dispatching`, now `uncertain`. */
  interrupted: number[];
  /** Rows a reconciliation read settled. */
  settled: number[];
  /** Rows still unknown: the account holds until they are settled. */
  unsettled: number[];
  /** Of those, the rows whose owner has answered and whose journal has not yet
   *  taken it: the drain comes back to them soon, not on a look's schedule. */
  answering: number[];
};

/**
 * Before anything new on an account: every send whose outcome is open is put
 * to its operation's READ, and a read settles it only as SENT: a write seen on
 * LinkedIn is `went_out` by evidence, and an absence never says `not_sent`
 * (that is the owner's, through `resolveOutcome`). A row the owner has answered
 * is not read: its journal entry is closed on their answer and only then is the
 * fence let go. A `dispatching` row whose fence no longer holds the
 * account's live operation lease was interrupted — a crash, a restart — and is
 * `uncertain` from here; one whose fence still holds it is mid-click and left
 * alone. Nothing here clicks.
 *
 * A DM or follow-up is read only until its looks give up
 * (`reconcileReads.ts`): a read made when the next look is due, and that
 * cannot tell, is counted on the row — one made sooner by another drain is
 * not — and the look that gives up, or the first drain past the point the
 * looks would have, marks it `reconcile_exhausted`, read no more and the
 * owner's to settle. It keeps the account's holder all the while.
 */
export async function reconcileActions(
  opts: GateOptions,
  channelId: number,
): Promise<ReconcileSummary> {
  const now = opts.now ?? Date.now;
  const operations = opts.operations ?? ACTION_OPERATIONS;
  const summary: ReconcileSummary = { interrupted: [], settled: [], unsettled: [], answering: [] };
  const open = await withOrg(opts.organizationId, (tx) =>
    tx
      .select()
      .from(actions)
      .where(
        and(
          eq(actions.channelId, channelId),
          inArray(actions.status, ["dispatching", "uncertain"]),
        ),
      )
      .orderBy(asc(actions.id)),
  );
  for (const found of open) {
    let row = found;
    const answer = ownerAnswerOf(row);
    if (answer) {
      await closeJournal(opts, row, answer, now(), summary);
      continue;
    }
    if (row.status === "dispatching") {
      const inFlight = await withOrg(opts.organizationId, async (tx) => {
        const [live] = await tx
          .select({ id: channels.id })
          .from(channels)
          .where(
            and(
              eq(channels.id, row.channelId),
              eq(channels.executionHolder, row.fenceToken!),
              sql`${channels.executionLeaseUntil} > (extract(epoch from clock_timestamp()) * 1000)::bigint`,
            ),
          );
        return live !== undefined;
      });
      if (inFlight) {
        summary.unsettled.push(row.id);
        continue;
      }
      const marked = await withOrg(opts.organizationId, (tx) =>
        settleAction(tx, {
          id: row.id,
          operationId: row.fenceToken!,
          receipt: { status: "uncertain", evidence: { interrupted: true } },
          settledBy: "reconcile",
          reason: "interrupted",
          now: now(),
        }),
      );
      if (!marked) continue;
      row = marked;
      summary.interrupted.push(row.id);
    }
    const counted = READ_BEFORE_ASKING.includes(row.kind);
    // A journal that holds the write the other way from the owner's answer
    // left the row to them: no read settles it, only a fresh resolution.
    if (!counted && row.statusReason === RECONCILE_EXHAUSTED) {
      summary.unsettled.push(row.id);
      continue;
    }
    if (counted && askOwner(row, now())) {
      if (row.statusReason !== RECONCILE_EXHAUSTED) await noteLook(opts.organizationId, row, { look: false }, now());
      summary.unsettled.push(row.id);
      continue;
    }
    const make = operations[row.kind];
    let receipt: ActionReceipt | null = null;
    if (make) {
      try {
        receipt = await make(opts.driver, { organizationId: opts.organizationId, now, connector: opts.connector }).reconcile(row);
      } catch {
        receipt = null;
      }
    }
    if (receipt === null || receipt.status !== "confirmed") {
      if (counted && make) await noteLook(opts.organizationId, row, { look: lookDue(row, now()) }, now());
      summary.unsettled.push(row.id);
      continue;
    }
    const seen = receipt;
    const resolved = await withOrg(opts.organizationId, (tx) =>
      resolveOutcome(tx, {
        ref: { kind: "act", id: row.id },
        observed: "went_out",
        by: EVIDENCE,
        proof: { evidence: seen.evidence, ...(seen.noop ? { noop: true as const } : {}) },
      }),
    );
    if (!resolved.ok) {
      summary.unsettled.push(row.id);
      continue;
    }
    summary.settled.push(row.id);
  }
  return summary;
}

/**
 * The owner's answer on an uncertain send, handed to the sidecar's journal
 * entry for the attempt, which records it as said and reads nothing. Only when
 * the journal has taken it, or never held the attempt, is the action settled
 * and the account's fence let go. A journal that cannot be reached leaves the
 * row as it is, for the drain's next pass; one that settled the attempt the
 * other way is a contradiction neither answer wins: the row goes back to the
 * owner with the answer cleared.
 */
async function closeJournal(
  opts: GateOptions,
  row: ActionRow,
  answer: NonNullable<ReturnType<typeof ownerAnswerOf>>,
  now: number,
  summary: ReconcileSummary,
): Promise<void> {
  let journal: "recorded" | "not_journaled" | "contradicted" = "not_journaled";
  if (isMessageSend(row.kind) || opts.driver.settleMemberWrite) {
    try {
      journal = isMessageSend(row.kind)
        ? await MESSAGE_JOURNALS[row.kind](opts.driver, opts.organizationId, opts.connector, row, answer)
        : (await opts.driver.settleMemberWrite!(row.fenceToken!, answer.observed)).state;
    } catch {
      summary.unsettled.push(row.id);
      summary.answering.push(row.id);
      return;
    }
  }
  await withOrg(opts.organizationId, async (tx) => {
    if (journal === "contradicted") {
      const { ownerAnswer: _cleared, ...rest } = row.externalReceipt ?? {};
      await tx
        .update(actions)
        .set({ statusReason: RECONCILE_EXHAUSTED, externalReceipt: { ...rest, contradicted: answer }, updatedAt: now })
        .where(and(eq(actions.id, row.id), eq(actions.status, "uncertain")));
      // An answer the update took over left its message showing it: the journal
      // says otherwise, so the message goes back to the owner to say which it was.
      if (answer.folded) {
        await tx.update(messages).set({ status: "needs_review", scheduledAt: null, error: "LinkedIn shows this posted, which is not what you marked. Look again and say which it was." })
          .where(and(eq(messages.id, row.messageId!), inArray(messages.status, ["proposed", "approved"])));
      }
      return;
    }
    await settleAnswered(tx, row, answer, now);
  });
  (journal === "contradicted" ? summary.unsettled : summary.settled).push(row.id);
}

/**
 * What a read of an open DM that could not tell leaves on it: counted, where
 * it was one of the drain's looks, and the looks given up —
 * `reconcile_exhausted` — where that count or the time now says so. Only the
 * attempt still open is written: one a read or the owner settled meanwhile
 * is left as it is.
 */
async function noteLook(
  organizationId: string,
  row: ActionRow,
  { look }: { look: boolean },
  now: number,
): Promise<void> {
  const exhausted = askOwner(
    look ? { ...row, reconcileAttempts: row.reconcileAttempts + 1, lastReconcileAt: now } : row,
    now,
  );
  if (!look && !exhausted) return;
  await withOrg(organizationId, (tx) =>
    tx
      .update(actions)
      .set({
        ...(look ? { reconcileAttempts: sql`${actions.reconcileAttempts} + 1`, lastReconcileAt: now } : {}),
        ...(exhausted ? { statusReason: RECONCILE_EXHAUSTED, updatedAt: now } : {}),
      })
      .where(
        and(
          eq(actions.id, row.id),
          eq(actions.fenceToken, row.fenceToken!),
          eq(actions.status, "uncertain"),
        ),
      ),
  );
}

export type DrainSummary = {
  reconciled: ReconcileSummary;
  outcomes: Array<{ id: number } & GateOutcome>;
};

/** At most this many actions one drain takes through the gate. */
export const DRAIN_LIMIT = 10;

/**
 * One account's queue: reconcile first, and stop there while any send's
 * outcome is open; then the approved actions, the owner's own first and each
 * group oldest first, one at a time, stopping at the first the account holds
 * or whose click comes back uncertain. An action held on its own
 * (`scope: "action"`) is passed over: one reply that cannot be read back does
 * not keep a yes on another waiting.
 *
 * THE OWNER'S OWN GO FIRST because an unattended action can be held by what an
 * owner's act is not subject to — the sending window, the active hours, a
 * ceiling (INV-1) — and a hold ends the drain where it stands: behind such a
 * like, the owner's would wait for the window to open, however many drains ran.
 *
 * What every action of the drain needs read alike — the account's received
 * invitations, before each invitation — is read once for all of them
 * (`OperationContext.once`).
 */
export async function drainActions(opts: GateOptions, channelId: number): Promise<DrainSummary> {
  const reconciled = await reconcileActions(opts, channelId);
  const outcomes: DrainSummary["outcomes"] = [];
  if (reconciled.unsettled.length > 0) return { reconciled, outcomes };
  const queued = await withOrg(opts.organizationId, (tx) =>
    tx
      .select({ id: actions.id })
      .from(actions)
      .where(
        and(
          eq(actions.channelId, channelId),
          inArray(actions.status, ["approved", "reserved"]),
        ),
      )
      .orderBy(
        desc(sql`${actions.origin} = 'owner'`),
        asc(actions.updatedAt),
        asc(actions.id),
      )
      .limit(DRAIN_LIMIT),
  );
  const reads: DrainReads = new Map();
  for (const { id } of queued) {
    const outcome = await dispatchAction(opts, id, reads);
    outcomes.push({ id, ...outcome });
    if (outcome.status === "uncertain") break;
    if (outcome.status === "held" && outcome.scope !== "action") break;
  }
  return { reconciled, outcomes };
}
