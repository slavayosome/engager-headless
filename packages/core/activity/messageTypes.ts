// The shapes of the account's message rows — the Channel's day plan, what went
// out, and what Activity lists. They live in core because the Activity tabs and
// the MCP `list_activity` read the same rows.

import type { SendOrigin } from "../ratelimit/ledger";
import type { DraftTrace, MessageLikeOutcome } from "@engager/database/schema";

export const QUEUE_STATUSES = [
  "proposed",
  "approved",
  "posting",
  "posted",
  "failed",
  "rejected",
  "needs_review",
] as const;

export type QueueStatusFilter = (typeof QUEUE_STATUSES)[number];

/** Full schema enum. `suppressed_dryrun` is not one of the seven above because
 *  it is never a state the owner asks for — a shadow row only ever appears, in
 *  Scout's Issues group. */
export type MessageStatus = QueueStatusFilter | "suppressed_dryrun";

export type QueueTarget = {
  kind: "post" | "incoming_comment" | "room_comment";
  authorName: string | null;
  excerpt: string | null;
  url: string | null;
  /** The conversation a reply's person is in, where a conversation holds them. */
  conversationId?: number | null;
  /** Who the action target is by (`core/people/key.ts`): the post's author, or the
   *  replier — null where the row names no one. Absent on a fixture that
   *  predates the field. */
  personKey?: string | null;
  /** Why Scout matched the post, and the angle it saw in it
   *  (`discovered_posts.agentRankReason`, `agentAngle`) — a comment's "Why
   *  this post". Null on a reply's target; absent on a fixture that predates
   *  the fields. */
  rankReason?: string | null;
  angle?: string | null;
};

/**
 * WHY a scheduled send is not going out: the refusal its last attempt met,
 * read off the post job's own receipt. A refused send is rescheduled, never
 * failed, so without this a comment with no browser session behind it renders
 * exactly like one waiting its turn.
 */
export type SendBlock = {
  layer: "org" | "worker" | "channel" | "connector";
  code: string;
  detail: string | null;
  /** When the queue tries again. */
  retryAt: number;
};

/**
 * The like a send carries (`messages.like_with_send`): on a draft waiting for
 * a yes, the "+ Like" its step offers and whether it is ticked; once the send
 * went out, what became of the like.
 */
export type QueueLike =
  | { kind: "offer"; on: boolean }
  | { kind: "outcome"; state: MessageLikeOutcome["state"]; reason: string | null };

export type QueueMessage = {
  id: number;
  kind: "comment" | "reply" | "room_reply";
  status: MessageStatus;
  /** finalText when a decision produced one, else the proposed draft. */
  text: string;
  edited: boolean;
  /**
   * WHO AUTHORED the words — `messages.publishOrigin` verbatim, and the sole
   * input to `pacingPolicy` (INV-1). Carried on the projection because the
   * account's plan cannot explain its own spacing without it: caps bind
   * unattended work, while a comment the owner wrote themselves is only spaced.
   *
   * AUTHORSHIP, never approval. Approving a worker's draft unchanged leaves it
   * the worker's; rewriting it makes it the owner's, which is why `edited`
   * beside this field is a second fact and not a restatement of it.
   */
  publishOrigin: SendOrigin;
  error: string | null;
  /** Why a failed send did not post, as a code (`messages.error_code`), and
   *  when it was last tried. Absent on a fixture that predates the fields. */
  errorCode?: string | null;
  lastAttemptAt?: number | null;
  externalUrn: string | null;
  createdAt: number;
  scheduledAt: number | null;
  postedAt: number | null;
  redraftRequestVersion: number;
  /** A redraft the owner asked for is still open on the row — and `error`,
   *  where set, is why it was not written. Absent on a fixture that predates
   *  the field. */
  redraftAsked?: boolean;
  /** failed AND clean-definitive (no posting marker, urn, or pending redraft)
   *  — the only failure retryDefinitiveMessageFailure will re-arm. */
  retryable: boolean;
  /** The judged set a worker's comment was picked from (`messages.trace.pick`),
   *  null where it was written alone. Absent on a fixture that predates the
   *  field. */
  pick?: NonNullable<DraftTrace["pick"]> | null;
  target: QueueTarget | null;
  /** Set only on an approved/posting row whose post job keeps being refused. */
  blocked: SendBlock | null;
  /** Null where the send carries no like. */
  like: QueueLike | null;
  /** The campaign the row was written for, so every list can name it and
   *  link it. Null where `messages.campaignId` is (it is nullable); absent on
   *  a fixture that predates the field. */
  campaignId?: number | null;
  campaignName?: string | null;
  /** The worker run that wrote the draft, where one did. */
  workerRunId?: number | null;
  /** Approved on a campaign that is Paused: it goes out after the Resume,
   *  which plans its slot (`heldForResume`). Absent on a fixture that
   *  predates the field. */
  heldForResume?: boolean;
};
