/**
 * Client-safe words for the action ledger's rows on Activity — the Like,
 * Invite, Accept invite, DM and Follow-up a worker proposed, which live on
 * `actions` beside the comments and replies on `messages`.
 * Type-only imports: a value import of the schema drags it into the browser
 * bundle.
 */

import type {
  ActionKind,
  ActionStatus,
  PauseReason,
  PauseScope,
} from "@engager/database/schema";
import type { PipelineTab } from "./tabs";

/** One ledger row as Activity lists it. */
export type ActionRowView = {
  id: number;
  kind: ActionKind;
  status: ActionStatus;
  statusReason: string | null;
  campaignId: number | null;
  campaignName: string | null;
  conversationId: number | null;
  /** Who the action is to (`core/people/key.ts`). */
  personKey: string | null;
  targetKind: string;
  targetUrn: string | null;
  /** The words of what the action is aimed at — their reply, the post, or
   *  our comment their reply answered — and who wrote them where it is not
   *  us: what keeps a bulk review from being a list of ids. */
  context: { authorName: string | null; excerpt: string | null } | null;
  /** The words that would go out — an invitation's note, a DM; null for a
   *  like or an acceptance. */
  text: string | null;
  /** Why a settled row stands as it does, from its receipt: what blocked it,
   *  where the read before the click or LinkedIn said so. */
  receiptReason: string | null;
  /** What the receipt saw, in words, where it kept any — LinkedIn's status
   *  and its own words, or what changed on the page before Send. */
  receiptDetail?: string | null;
  /** The wake it was proposed on, where the step's own wait woke it — the
   *  person's words the time rested on, and the step's summary — so a
   *  follow-up sooner than 72 hours says why it may be. */
  wake: { quote: string | null; rationale: string | null } | null;
  updatedAt: number;
  /** The worker run whose step proposed it, where a step did. */
  runId?: number | null;
  /** Whose words it carries (`actions.origin`), and whether it
   *  holds the owner's yes — what Activity's sub-label under it says. */
  origin: "owner" | "worker";
  approved: boolean;
};

/** An open Stop, as Activity offers its Resume. */
export type PauseView = {
  id: number;
  scope: PauseScope;
  scopeId: number;
  reason: PauseReason;
  /** The campaign's name, or the person's, where the scope has one. */
  scopeName: string | null;
  /** The person a conversation's pause is about; null for any other scope. */
  personKey: string | null;
  pausedAt: number;
};

/** Which of the pipeline's tabs each ledger state belongs on. A cancelled
 *  row is on none: nothing about it is still the owner's to do. */
export const ACTION_TAB_STATUSES: Record<PipelineTab, readonly ActionStatus[]> = {
  waitingForYes: ["awaiting_review"],
  scheduled: ["reserved", "approved", "dispatching"],
  posted: ["confirmed"],
  issues: ["uncertain", "blocked", "definitely_not_sent"],
};

/** The catalog's one owner-facing name for the action (Phase 37). */
export function ledgerActionLabel(kind: ActionKind, targetKind: string): string {
  switch (kind) {
    case "like_target":
      return targetKind === "post" ? "Like post" : targetKind === "room_comment" ? "Like comment" : "Like reply";
    case "invite":
      return "Invite";
    case "accept_invite":
      return "Accept invite";
    case "dm":
      return "DM";
    case "followup":
      return "Follow-up";
    case "withdraw_invite":
      return "Withdraw invite";
    case "room_reply":
      return "Reply in the room";
    case "reply":
      return "Reply";
    case "comment":
      return "Comment";
  }
}

// The words a comment's row uses for the same states (`lib/message-presentation`),
// so one tab never says a state two ways.
const STATUS_LABEL: Record<ActionStatus, string> = {
  reserved: "Queued",
  awaiting_review: "Waiting for a yes",
  approved: "Queued",
  dispatching: "Sending",
  confirmed: "Posted",
  definitely_not_sent: "Not sent",
  uncertain: "Outcome unclear",
  blocked: "Blocked",
  cancelled: "Cancelled",
};

const STATUS_TONE: Record<ActionStatus, "neutral" | "good" | "warning" | "problem"> = {
  reserved: "neutral",
  awaiting_review: "warning",
  approved: "neutral",
  dispatching: "neutral",
  confirmed: "good",
  definitely_not_sent: "problem",
  uncertain: "problem",
  blocked: "problem",
  cancelled: "neutral",
};

export function actionStatusLabel(status: ActionStatus): string {
  return STATUS_LABEL[status];
}

export function actionStatusTone(status: ActionStatus) {
  return STATUS_TONE[status];
}

/** Why a yes stopped holding, in the words the row shows — one per reason
 *  `actions/approval.ts` can give. */
const INVALIDATED_BECAUSE: Record<string, string> = {
  used: "it was already spent on a send",
  expired: "it expired before the send",
  text: "the words changed",
  target: "what it acts on changed",
  facts: "a fact it rested on changed",
  evidence: "the reply it answers was edited or removed",
  memory: "what it remembered changed",
  authority: "the campaign no longer allows this action",
  owner_unscheduled: "you took it out of the schedule",
};

/** Why an invitation was blocked, in the owner's words — one per reason the
 *  read before the click or the sidecar gives (`actions/invite.ts`). */
const INVITE_BLOCKED_BECAUSE: Record<string, string> = {
  note_limit: "the note is longer than LinkedIn's composer takes for this person",
  note_limit_unread: "LinkedIn's composer showed no note limit, so the note was not sent blind",
  note_unavailable: "the account has no personalized invitations left, and the note is required",
  note_required: "this campaign requires a note, and it had none",
  already_connected: "you're already connected",
  invitation_pending: "an invitation of yours is already pending",
  invitation_incoming: "they already invited you — that's Accept invite's",
  invite_exists: "this conversation already has an invitation",
  connect_without_composer: "their Connect would send without a note, so it was not pressed",
  recently_withdrawn: "you withdrew an invitation to them in the last three weeks, and LinkedIn takes no new one yet",
  invitation_gated: "LinkedIn asked how you know them",
  refused_after_send: "LinkedIn refused it after Send",
};

/** Why a Withdraw invite was blocked, in the owner's words — one per reason
 *  the read before the click gives (`actions/withdrawInvite.ts`). */
const WITHDRAW_BLOCKED_BECAUSE: Record<string, string> = {
  invitation_not_ours: "no invitation of yours to them is waiting for an answer",
  invitation_not_pending: "LinkedIn no longer shows your invitation pending",
  already_connected: "you're already connected",
  invitation_incoming: "they invited you — that's Accept invite's",
  invitations_unavailable: "the connected browser can't withdraw invitations",
  refused_after_withdraw: "LinkedIn refused it after Withdraw",
};

/** What an approved invitation waits on, in the owner's words — one per hold
 *  the read before the click gives (`actions/invite.ts`), keyed by the reason
 *  after `held:`. Each is tried again by the drain: within the hour, or where
 *  the read's budget says. */
const INVITE_HELD_BECAUSE: Record<string, string> = {
  "preflight:invitations_incomplete":
    "waiting to check your received invitations before sending; tries again within the hour",
  "preflight:invitations_unreadable":
    "the connected browser can't read your received invitations, so it waits to check them before sending; tries again within the hour",
  "preflight:unreadable": "waiting for LinkedIn to load for the check before sending; tries again within the hour",
  relationship_unknown: "checking whether you're connected; tries again within the hour",
  "preflight:outside_active_hours":
    "the check before sending reads LinkedIn, so it waits for the account's active hours; tries again when they open",
  "preflight:profile_read_daily_cap":
    "today's profile reads are spent and the check before sending needs one; tries again when they renew",
};

/** An approved invitation held on a read, in the owner's words — null for a
 *  hold with no words of its own. A read of LinkedIn that was held for some
 *  other reason is still said to be a read. */
export function inviteHeldNote(reason: string): string | null {
  const because =
    INVITE_HELD_BECAUSE[reason] ??
    (reason.startsWith("preflight:") ? "waiting on a read of LinkedIn before sending; tries again later" : null);
  return because === null ? null : `Approved — ${because}`;
}

/** Why a DM or a follow-up was blocked, in the owner's words — one per reason
 *  the read before the click or the sidecar gives (`actions/dm.ts`). */
const DM_BLOCKED_BECAUSE: Record<string, string> = {
  person_cap: "this person has had as many messages in 30 days as you allow",
  person_cap_unset: "the account sets no cap on messages per person",
  thread_moved: "they wrote again since, so it answered older words",
  human_draft: "someone was typing in the conversation",
  participants_mismatch: "the conversation is not just you and them",
  group_thread: "the conversation is a group's",
  thread_unbound: "the conversation is no longer theirs",
  messaging_restricted: "LinkedIn won't carry a message in this conversation",
  dm_unavailable: "the connected browser can't send messages",
  refused_after_send: "LinkedIn refused it after Send",
  // The page the message is sent from, before Send: nothing went.
  dom_changed: "LinkedIn's page could not be read before Send",
  prepared_ui_stale: "LinkedIn's page changed before Send",
  // A first message, which opens the conversation (`open_dm`).
  not_connected: "you're not connected any more, so nothing was sent",
  recipient_unverified: "their profile could not be read as theirs",
  message_unavailable: "their profile offers you no Message",
  conversation_exists: "a conversation with them is already on LinkedIn",
  conversation_unverified: "LinkedIn's list was too long to rule out a conversation with them",
  recipient_unbound: "LinkedIn's message window did not name them",
  thread_bound: "a conversation with them is bound now, so write there",
  opener_owner_only: "only your own words open a conversation",
};

/** Why a Like was blocked, in the owner's words — one per reason the read
 *  before the click gives (`actions/likeTarget.ts`). */
const LIKE_BLOCKED_BECAUSE: Record<string, string> = {
  target_unresolved: "what it was aimed at could not be found again",
  reply_unverifiable: "the connected browser can't read the thread to check the reply",
  parent_gone: "your comment it sits under is gone",
  parent_not_ours: "the comment it sits under is no longer yours",
  reply_gone: "their reply was deleted",
  author_changed: "the reply is no longer theirs",
  reply_edited: "they edited their reply since",
  already_reacted: "you already reacted to it some other way, and a Like would change that",
};

/** Why an Accept invite was blocked, in the owner's words — one per reason
 *  the read before the click or the sidecar gives (`invitations/accept.ts`). */
const ACCEPT_BLOCKED_BECAUSE: Record<string, string> = {
  invitation_not_listed: "LinkedIn no longer lists this request",
  invitation_withdrawn: "they withdrew the invitation",
};

const DIRECT = new Set<ActionRowView["kind"]>(["dm", "followup"]);

/** The reasons a kind of action is blocked for, in the owner's words. */
function blockedReasons(kind: ActionRowView["kind"] | undefined): Record<string, string> {
  if (kind === "invite") return INVITE_BLOCKED_BECAUSE;
  if (kind !== undefined && DIRECT.has(kind)) return DM_BLOCKED_BECAUSE;
  if (kind === "like_target") return LIKE_BLOCKED_BECAUSE;
  if (kind === "accept_invite") return ACCEPT_BLOCKED_BECAUSE;
  if (kind === "withdraw_invite") return WITHDRAW_BLOCKED_BECAUSE;
  return {};
}

/** Why a blocked row was blocked, as a clause the owner reads after "Not
 *  sent": null where no reason of its kind is named. */
export function blockedBecause(row: Pick<ActionRowView, "kind" | "receiptReason">): string | null {
  return (row.receiptReason ? blockedReasons(row.kind)[row.receiptReason] : undefined) ?? null;
}

/** The gate's hold on unattended work in a conversation that waits on the
 *  owner (`conversations.ops_status = awaiting_review`), and the same hold where
 *  only a read that could not tell whether the two are connected sent it
 *  there (`RELATIONSHIP_UNREAD_HOLD`, `execution/actionGate.ts`). */
const REVIEW_HOLD = "held:conversation_awaiting_review";
const CONNECTION_CHECK_HOLD = "held:conversation_relationship_unread";

/** A queued row the gate holds on its conversation's review — for the
 *  owner's look, or for a read that can tell whether the two are connected:
 *  it has no slot or turn to wait for. */
export function heldForReview(row: Pick<ActionRowView, "status" | "statusReason">): boolean {
  return (
    (row.status === "reserved" || row.status === "approved") &&
    (row.statusReason === REVIEW_HOLD || row.statusReason === CONNECTION_CHECK_HOLD ||
      row.statusReason === "held:journey_awaiting_review" || row.statusReason === "held:journey_relationship_unread")
  );
}

/** A row held only until a read of the person can tell whether the two are
 *  connected: Engager reads them again on its own, and the owner's yes could
 *  not send it before then. */
export function heldOnConnectionCheck(row: Pick<ActionRowView, "status" | "statusReason">): boolean {
  return heldForReview(row) && (row.statusReason === CONNECTION_CHECK_HOLD || row.statusReason === "held:journey_relationship_unread");
}

/**
 * What the row's state means for the owner, in one line — for Issues, what is
 * known, what is not, and what waits on it (spec §16 R12).
 */
export function actionStatusNote(
  row: Pick<ActionRowView, "status" | "statusReason"> &
    Partial<Pick<ActionRowView, "kind" | "receiptReason">>,
): string | null {
  const invite = row.kind === "invite";
  const direct = row.kind !== undefined && DIRECT.has(row.kind);
  if (heldOnConnectionCheck({ status: row.status, statusReason: row.statusReason })) {
    return "Held: Engager is checking whether you're connected. It reads their profile again on its own and sends once it can tell.";
  }
  if (heldForReview({ status: row.status, statusReason: row.statusReason })) {
    return "Held: this conversation waits for your review, and nothing Engager queued goes in it until you have looked.";
  }
  switch (row.status) {
    case "uncertain":
      return invite
        ? "Nobody knows yet whether the invitation went out. Engager reads their profile again before anything else on this account — Pending there means it went out; or look yourself and say which."
        : direct
          ? "Nobody knows yet whether the message went out. Engager reads the conversation again before anything else on this account — your message there means it went out; or look yourself and say which."
          : "Nobody knows yet whether this went out. Nothing else is sent on this account until you look on LinkedIn and say which.";
    case "blocked": {
      // The gate's own answer, before LinkedIn was asked anything.
      if (row.statusReason === "ceiling_reached") {
        return "Not sent: the account's 24-hour ceiling for this was already spent, so this automatic one was dropped rather than saved for later.";
      }
      if (row.statusReason?.startsWith("outside_countries:")) {
        return `Outside your countries · ${row.statusReason.slice("outside_countries:".length)}, so nothing was sent.`;
      }
      if (row.statusReason === "country_unknown") {
        return "Not sent: their profile names no country, and your Audience leaves those out.";
      }
      const because = row.receiptReason ? blockedReasons(row.kind)[row.receiptReason] : undefined;
      if (because) return `Not sent: ${because}.`;
      const reason = row.receiptReason ?? row.statusReason;
      return `LinkedIn refused it before anything changed${reason ? ` (${reason})` : ""}.`;
    }
    case "definitely_not_sent":
      return "It did not go out. A worker may propose it again; it waits for a fresh yes.";
    case "approved": {
      if (!row.statusReason?.startsWith("held:")) return "Approved. Nothing is sent before the gate re-checks it.";
      const held = row.statusReason.slice("held:".length);
      const plain = invite ? inviteHeldNote(held) : null;
      return plain ? `${plain}.` : `Approved, and held: ${held.replaceAll("_", " ")}.`;
    }
    case "awaiting_review": {
      const invalidated = row.statusReason?.startsWith("approval_invalidated:")
        ? INVALIDATED_BECAUSE[row.statusReason.slice("approval_invalidated:".length)]
        : undefined;
      if (invalidated) return `Your earlier yes no longer holds: ${invalidated}.`;
      if (row.statusReason === "mode_off") {
        return "The campaign switched this action Off after your yes, so nothing goes out until you turn it back on and say yes again.";
      }
      // An Automatic one the owner unscheduled: no yes stood behind it before.
      if (row.statusReason === "owner_unscheduled") {
        return "You took it out of the schedule, so it goes out only on your yes.";
      }
      if (row.statusReason === "country_unknown") {
        return "Their profile names no country, and your Audience makes that your call, so it goes out only on your yes.";
      }
      if (invite) {
        return "On your yes, Engager reads their profile first and sends only if you're not connected and nothing is pending.";
      }
      return direct
        ? "On your yes, Engager reads the conversation first and sends only if nothing new came from them and no one is typing in it."
        : null;
    }
    default:
      return null;
  }
}

/** "Campaign “Fintech founders” is stopped", "Conversation “Priya” — yours
 *  to answer". */
export function pauseLabel(pause: Pick<PauseView, "scope" | "reason" | "scopeName">): string {
  const named = pause.scopeName ? ` “${pause.scopeName}”` : "";
  if (pause.reason === "takeover") return `Conversation${named} — yours to answer`;
  const what =
    pause.scope === "account" ? "The account" : pause.scope === "campaign" ? `Campaign${named}` : `Conversation${named}`;
  return pause.reason === "stop" ? `${what} is stopped` : `${what} is paused (${pause.reason.replaceAll("_", " ")})`;
}
