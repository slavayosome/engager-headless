import { and, eq, gte, inArray, sql } from "drizzle-orm";
import {
  actions,
  campaigns,
  channels,
  incomingComments,
  messages,
  rateLimitLedger,
  type ActionRow,
  type ActionTarget,
  type Campaign,
  type IncomingComment,
  type ConversationEventRow,
  type ConversationRow,
  type Message,
  type MessageLikeOutcome,
} from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { loadStrategy } from "../agentStep/select";
import type { CatalogStepId, TargetType } from "../strategy/catalog";
import type { ResolvedAction } from "../strategy/resolve";
import { modeFor } from "../strategy/mode";
import type {
  ActionOperation,
  ActionReceipt,
  ActionSurface,
  Preflight,
} from "../execution/actionGate";
import { clickedAt } from "../execution/reconcileReads";
import { ReplyStanceVerdict } from "../conversations/classify";
import type { ReplyReading } from "../conversations/eligibility";
import { commentId, provesDeletions } from "../linkedin/commentThread";
import { isConnectorBackoff } from "../linkedin/connectorError";
import {
  MAX_COMMENT_REPLIES,
  type CommentRepliesRead,
  type LikeStateRead,
  type PostResult,
} from "../linkedin/driver";
import { normalizePostUrn } from "../linkedin/postUrn";
import { getSystemState, pauseChannelForConnectorBackoff } from "../ratelimit/killswitch";
import {
  channelCeilings,
  completedLedgerActionPredicate,
  countSince,
  reserveResearchRead,
  type EngageAction,
} from "../ratelimit/ledger";
import { approveAction } from "./approval";
import { enqueueActionDispatch } from "./drain";
import { ActionLedgerError } from "./errors";
import { rejectAction, reserveAction, type ReserveOutcome } from "./ledger";
import { currentGeneration } from "./pause";

/**
 * LIKE THROUGH A BINDING — the action ledger's first live consumer (Phase 48;
 * spec §07 `like_target`, §17 R13 "Like the selected target"; INV-27, INV-31).
 *
 * Two catalog actions share the capability: the Ambassador's Like reply, in
 * Reply when they answer, and its Like post, in Comment on posts. Each binding names
 * its action target by SELECTOR — `their_reply` (the prospect's reply, Like reply's
 * default), `replied_comment` (the comment their reply answers) or `post` (the
 * post Like post's step comments on); the contract refuses a Like reply aimed
 * at the post. The server, never the model, turns a selector into the exact
 * target (`likeTargetFor`): the urn from the reply the step answers, the
 * comment it sits under, or the post — and a proposal aimed anywhere else is
 * discarded before it reaches the ledger (`agentStep/validate.ts`).
 *
 * The browser half (`likeTargetOperation`) rides the existing `like_post` /
 * `like_comment` ops, and a read of the post's own data — no journal. A reply
 * is liked and read with the comment it answers beside it (`target.parentUrn`):
 * LinkedIn declares a reply's reaction only in the post opened by its own link
 * to that reply, so the receipt and the reconcile open it there, and a reply
 * whose comment is unknown reads as a data that cannot tell:
 *
 *   preflight  a reply target is read back first (`readCommentReplies`, one
 *              metered thread read): still there, by the same person, in the
 *              same words — else `blocked`; a read that cannot tell holds
 *   perform    the like op reads the post's data, then the control's pressed
 *              state, before it clicks and refuses to toggle one that is
 *              pressed: `already_liked` is a no-op confirmation that spends
 *              nothing, another reaction is `blocked` (`already_reacted`), and
 *              `liked` is the post's data read afresh after the click — never
 *              the click (INV-31); a refusal raised before the click did not go
 *              out, and anything else is `uncertain`
 *   reconcile  the post's data, read without pressing (`readLikeState`), and
 *              only as the account the channel is connected as: our Like is
 *              `confirmed`; no reaction is `definitely_not_sent` only once the
 *              read is a quarter hour past the press; a data that cannot tell,
 *              or that was read as another account, leaves it open — never
 *              "not liked" — and it is never re-tried by a press (INV-10)
 *
 * The owner's own Like under a comment author's comment in a room is a fourth
 * selector, `room_comment`: no step's binding names it (the catalog's Like
 * targets stop at a post and a reply), so only the owner's press builds it
 * (`ownerLike.ts`). It rides the same `like_comment` op as a comment of the
 * post's own, with nothing to read back first — the comment is a stranger's, not
 * one of ours to verify — and its reaction key is its own kind and comment id,
 * so one comment takes one like.
 *
 * Likes stay at-least-once on every connector (`connector/capabilities.ts`);
 * the semantic key — account + post or comment + canonical target + reaction —
 * is what makes a second proposal of one like the first.
 *
 * A like of what a send answers is a row here too, linked to that send
 * (`reserveSendLike`): one yes, approved by the send's own, and the gate
 * clicks it only once the send is posted — an uncertain send keeps its like
 * waiting. What became of it is recorded on the message (`settleSendLike`).
 * Like post rides with the Comment. Like reply follows its own mode, and the
 * SERVER carries it out; the step's model never has to remember it:
 *
 *   Automatic  a reply is liked the moment it is seen, on its own row here,
 *              unattended (`likeObservedReply`) — when the reads the reply
 *              lane already runs on it clear it (`likeableReading`, and the
 *              sensitivity check). One they do not clear is the step's to
 *              judge, and a like it proposes waits for the owner's yes
 *   Ask me     the Reply the step drafts to it carries its like
 *              (`agentStep/dispatch.ts`), so the owner's one yes sends both
 *              — when the same reads clear it (`likeableRecorded`, and the
 *              sensitivity check the writer runs); a reply it likes and
 *              does not answer takes a row here, waiting for a yes
 *   Off        no reply is liked
 */

/** What a conversation step can aim a like at, as the server holds it. */
export type LikeConversation = {
  postUrn: string | null;
  /** The person's reply the step answers, at the revision it was handed. */
  reply: { urn: string; authorProfileId: string; textHash: string | null } | null;
  /** The comment their reply answers — ours. */
  repliedTo: string | null;
  /** A comment author's comment on the post, found in its room: the owner's Like
   *  aims at it. Its author where a read named them, and the comment it sits
   *  under where it is a reply. */
  roomComment?: { urn: string; authorProfileId: string | null; parentUrn?: string } | null;
};

/**
 * The exact target a selector names in this conversation, or null when the
 * conversation does not have one. Pure: the canonical id is the comment's own
 * id (either inner post spelling) or the post's canonical urn, and a reply
 * carries the person and the words the gate will hold the page to.
 */
export function likeTargetFor(
  selector: TargetType,
  conversation: LikeConversation,
): ActionTarget | null {
  const { postUrn, reply, repliedTo, roomComment } = conversation;
  switch (selector) {
    case "their_reply":
      return postUrn && reply && repliedTo
        ? {
            kind: selector,
            id: commentId(reply.urn),
            urn: reply.urn,
            postUrn,
            parentUrn: repliedTo,
            authorProfileId: reply.authorProfileId,
            textHash: reply.textHash,
          }
        : null;
    case "replied_comment":
      return postUrn && repliedTo
        ? { kind: selector, id: commentId(repliedTo), urn: repliedTo, postUrn }
        : null;
    case "room_comment":
      return postUrn && roomComment
        ? {
            kind: selector,
            id: commentId(roomComment.urn),
            urn: roomComment.urn,
            postUrn,
            ...(roomComment.authorProfileId ? { authorProfileId: roomComment.authorProfileId } : {}),
            ...(roomComment.parentUrn ? { parentUrn: roomComment.parentUrn } : {}),
          }
        : null;
    case "post":
      return postUrn ? { kind: selector, id: normalizePostUrn(postUrn), urn: postUrn } : null;
    default:
      return null;
  }
}

/** A preflight read that cannot tell is tried again this much later — a page
 *  load each time, so not every drain. */
const PREFLIGHT_RETRY_MS = 60 * 60_000;

export function likeTargetOperation(
  driver: ActionSurface,
  context: { organizationId: string; now: () => number },
): ActionOperation {
  return {
    async preflight(row) {
      const { target } = row;
      if (!target.urn || (target.kind !== "post" && !target.postUrn)) {
        return blockedBefore("target_unresolved");
      }
      return target.kind === "their_reply" ? verifyReply(driver, context, row) : { proceed: true };
    },
    async perform(row) {
      const { target } = row;
      if (target.kind === "post") return likeReceipt(await driver.likePost(target.urn!));
      if (!driver.likeComment) {
        return { status: "definitely_not_sent", evidence: { reason: "like_comment_unavailable" } };
      }
      return likeReceipt(await driver.likeComment(target.postUrn!, target.urn!, repliedCommentOf(target)));
    },
    async reconcile(row) {
      const { target } = row;
      if (!driver.readLikeState || !target.urn) return null;
      const read =
        target.kind === "post"
          ? await driver.readLikeState(target.urn)
          : target.postUrn
            ? await driver.readLikeState(target.postUrn, target.urn, repliedCommentOf(target))
            : null;
      if (!read) return null;
      // The post's data is the signed-in account's: another account's `Default`
      // is no evidence that ours did not like it.
      const [channel] = await withOrg(context.organizationId, (tx) =>
        tx
          .select({ account: channels.externalAccountId })
          .from(channels)
          .where(eq(channels.id, row.channelId)),
      );
      return channel?.account && read.accountId?.toLowerCase() === channel.account.toLowerCase()
        ? likeStateReceipt(read, clickedAt(row))
        : null;
    },
  };
}

/** The comment a reply target sits under, which opens the post at the reply;
 *  nothing for an action target that is not a reply. */
function repliedCommentOf(target: ActionTarget): string | undefined {
  return target.kind === "their_reply" || target.kind === "room_comment" ? target.parentUrn : undefined;
}

/** How long after the press a read showing no reaction proves the like did
 *  not land: the quarter hour every other send waits (`actions/dm.ts`). */
export const LIKE_RESOLVE_SETTLE_MS = 15 * 60_000;

/** What a read of the post's data settles of a like pressed at `pressedAt`,
 *  or null where it settles nothing yet. */
export function likeStateReceipt(read: LikeStateRead, pressedAt: number): ActionReceipt | null {
  switch (read.reaction) {
    case null:
      return null;
    case "Like":
      return { status: "confirmed", evidence: { reaction: "liked", reconciled: true } };
    case "Default":
      return read.observedAt - pressedAt >= LIKE_RESOLVE_SETTLE_MS
        ? { status: "definitely_not_sent", evidence: { reconciled: true, absentAt: read.observedAt } }
        : null;
    default:
      return { status: "blocked", evidence: { reason: "already_reacted", reaction: read.reaction } };
  }
}

function blockedBefore(reason: string): Preflight {
  return { proceed: false, receipt: { status: "blocked", evidence: { reason } } };
}

/** The like op's answer as the ledger settles it. */
export function likeReceipt(result: PostResult): ActionReceipt {
  if (result.ok) {
    return result.reaction === "already_liked"
      ? { status: "confirmed", noop: true, evidence: { reaction: "already_liked" } }
      : {
          status: "confirmed",
          // A connector that reports no reaction state read none back: its
          // answer is the provider's ok, never a pressed control.
          evidence: { reaction: result.reaction ?? null, externalUrn: result.externalUrn ?? null },
        };
  }
  if (result.code === "ALREADY_REACTED") {
    return { status: "blocked", evidence: { reason: "already_reacted", error: result.error ?? null } };
  }
  return result.notAttempted
    ? { status: "definitely_not_sent", evidence: { error: result.error ?? null, notAttempted: true } }
    : { status: "uncertain", evidence: { error: result.error ?? null } };
}

/**
 * The reply a Like reply is for, read back from its thread immediately before
 * the click: our comment still there and ours, the reply under it, by the
 * person and in the words the proposal saw. A reply the read does not show is
 * gone only when the read proves deletions (`provesDeletions`); otherwise the
 * row waits.
 */
async function verifyReply(
  driver: ActionSurface,
  context: { organizationId: string; now: () => number },
  row: ActionRow,
): Promise<Preflight> {
  const target = row.target;
  if (!target.parentUrn) return blockedBefore("target_unresolved");
  if (!driver.readCommentReplies) return blockedBefore("reply_unverifiable");
  const refused = await withOrg(context.organizationId, async (tx) => {
    const channel = await channelCeilings(tx);
    if (!channel) return { reason: "no_channel" } as const;
    const decision = await reserveResearchRead({
      db: tx,
      channel,
      read: "thread_read",
      campaignId: row.campaignId,
      now: context.now(),
    });
    return decision.ok ? null : decision;
  });
  if (refused) {
    return {
      proceed: false,
      hold: `preflight:${refused.reason}`,
      ...("retryAt" in refused && refused.retryAt !== undefined ? { retryAt: refused.retryAt } : {}),
    };
  }

  let read: CommentRepliesRead;
  try {
    read = await driver.readCommentReplies(target.postUrn!, target.parentUrn, {
      limit: MAX_COMMENT_REPLIES,
    });
  } catch (error) {
    if (isConnectorBackoff(error)) await pauseChannelForConnectorBackoff(context.organizationId, error);
    return { proceed: false, hold: "preflight:unreadable", retryAt: context.now() + PREFLIGHT_RETRY_MS };
  }
  if (!read.comment.present) return blockedBefore("parent_gone");
  // Null is a read keyed by the urn alone, which names no author: the comment
  // the reply answers is ours by the server's own record (`repliedTo`).
  if (read.comment.authorIsSelf === false) return blockedBefore("parent_not_ours");
  const reply = read.replies.find((found) => commentId(found.replyUrn) === target.id);
  if (!reply) {
    return provesDeletions(read.comment, read.truncated)
      ? blockedBefore("reply_gone")
      : { proceed: false, hold: "preflight:reply_not_shown", retryAt: context.now() + PREFLIGHT_RETRY_MS };
  }
  if (reply.author.profileId !== target.authorProfileId) return blockedBefore("author_changed");
  if (target.textHash && reply.textHash !== target.textHash) return blockedBefore("reply_edited");
  return { proceed: true };
}

/** The step whose send a like rides with, and what that like aims at: a
 *  comment likes the post it answers (Like post, on Comment on posts); a reply
 *  likes the reply it answers (Like reply, on Reply when they answer). */
const SEND_LIKES = {
  comment: { step: "comment_on_posts", target: "post" },
  reply: { step: "handle_reply", target: "their_reply" },
} as const satisfies Record<Exclude<Message["kind"], "room_reply">, { step: CatalogStepId; target: TargetType }>;

/** The binding that likes what a send of this kind answers, above Off — or
 *  null when the campaign's strategy binds none. Resolved without the clock:
 *  the window binds the click, never the decision a yes may come to later. */
export async function sendLikeBinding(
  tx: Tx,
  campaign: Pick<Campaign, "id" | "channelId">,
  kind: Message["kind"],
): Promise<{ binding: ResolvedAction; ceiling: number | null; version: number } | null> {
  if (kind === "room_reply") return null;
  const strategy = await loadStrategy(tx, campaign);
  if (!strategy) return null;
  const { step, target } = SEND_LIKES[kind];
  const binding = await modeFor(tx, { campaignId: campaign.id, capability: "like_target", target, catalogStep: step });
  if (binding.effective !== "review" && binding.effective !== "auto") return null;
  const ceiling = strategy.accountDefault?.budgets?.action_budgets_per_rolling_24h.like_target ?? null;
  return { binding, ceiling, version: strategy.version };
}

/**
 * Like reply's binding on a campaign that likes a reply the moment it is
 * seen — Active, its Like reply Automatic, and the kill switch off, which
 * stops every wake before it reaches the gate and stops this too — or null.
 * What decides whether the reply lane spends its sensitivity check on a reply
 * at all, and what `likeObservedReply` reads again in the transaction that
 * reserves.
 */
export async function likesOnSight(
  tx: Tx,
  campaignId: number,
): Promise<{ binding: ResolvedAction; version: number; campaign: Pick<Campaign, "id" | "channelId"> } | null> {
  const [campaign] = await tx
    .select({ id: campaigns.id, channelId: campaigns.channelId, status: campaigns.status })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId));
  if (!campaign || campaign.status !== "active") return null;
  if ((await getSystemState(tx))?.killSwitch === true) return null;
  const bound = await sendLikeBinding(tx, campaign, "reply");
  return bound?.binding.effective === "auto" ? { binding: bound.binding, version: bound.version, campaign } : null;
}

/**
 * Whether what the stance read saw in a reply lets the server like it on
 * sight: on topic, not hostile, no refusal — quoted or not — and nothing the
 * read could not tell. Spam and an unrelated aside are not liked. The
 * sensitivity check (press, legal, a competitor, profanity) is the other half,
 * run by the reply lane only for a reply this clears. Pure.
 */
export function likeableReading(reading: ReplyReading | null): boolean {
  return (
    reading !== null &&
    reading.relevance === "relevant" &&
    reading.stance !== "negative" &&
    !reading.optOut &&
    !reading.unquoted.includes("opt_out") &&
    !reading.uncertain
  );
}

/** What the conversation keeps of a stance read: the verdict without its quotes
 *  (`conversations/record.ts`'s `ReplyDecision.label`). */
const RecordedLabel = ReplyStanceVerdict.omit({ evidence: true });

/**
 * `likeableReading` for a reply already on its conversation, from the event that
 * recorded it: the verdict its decision kept, read as the stance read gave it.
 * A claim the quotes did not back (`unquoted`) stays a claim here, which holds
 * the like back as the checked one would, and a reply recorded unread — an
 * edit, a failed read — is not liked. Pure.
 */
export function likeableRecorded(decision: Record<string, unknown> | null | undefined): boolean {
  const label = RecordedLabel.safeParse(decision?.label);
  if (!label.success) return false;
  const { relevance, stance, opt_out, busy, question, interest, uncertain } = label.data;
  return likeableReading({ relevance, stance, optOut: opt_out, busy, question, interest, uncertain, unquoted: [] });
}

/**
 * Like a reply the moment it is first seen, unattended, through this ledger's
 * one door — on a campaign whose Like reply is Automatic, for a reply the
 * reply lane's reads cleared (`likeableReading` and the sensitivity check),
 * which the caller says. The gate clicks it as it clicks any Automatic like:
 * the account's window, its rolling-24h like ceiling and every Stop still
 * bind it (`execution/actionGate.ts`). Once per reply: the like's semantic key
 * is its action target, so seeing the reply again, or a step proposing the same
 * like, reserves nothing twice. Null where nothing is reserved — the campaign
 * no longer likes on sight, or the conversation has no reply to aim at.
 */
export async function likeObservedReply(
  tx: Tx,
  input: {
    incoming: IncomingComment;
    conversation: Pick<ConversationRow, "id" | "channelId" | "authorProfileId">;
    event: Pick<ConversationEventRow, "id" | "contentHash">;
    now: number;
  },
): Promise<ReserveOutcome | null> {
  const { incoming, conversation, event } = input;
  if (incoming.campaignId === null || incoming.authorProfileId === null) return null;
  const onSight = await likesOnSight(tx, incoming.campaignId);
  if (!onSight) return null;
  const [ours] =
    incoming.parentMessageId === null
      ? []
      : await tx
          .select({ urn: messages.externalUrn })
          .from(messages)
          .where(eq(messages.id, incoming.parentMessageId));
  const target = likeTargetFor(onSight.binding.target, {
    postUrn: incoming.ownPostUrn,
    reply: { urn: incoming.commentUrn, authorProfileId: incoming.authorProfileId, textHash: incoming.textHash },
    repliedTo: incoming.threadParentUrn ?? ours?.urn ?? null,
  });
  if (!target) return null;
  return reserveAction(tx, {
    channelId: conversation.channelId,
    campaignId: onSight.campaign.id,
    conversationId: conversation.id,
    authorProfileId: conversation.authorProfileId,
    actionBindingId: onSight.binding.action_binding_id,
    kind: "like_target",
    purpose: "reaction",
    target,
    candidate: {
      text: null,
      sources: [{ eventId: event.id, contentHash: event.contentHash }],
      versions: { strategy: onSight.version, facts: [], memory: null, voice: null },
    },
    mode: "auto",
    generationSeen: await currentGeneration(tx),
    now: input.now,
  });
}

/**
 * Every row a like leaves on the account's ledger: the action ledger's
 * receipt (`like_target`), and the `like` rows from before every like was an
 * action. The account's like ceiling counts them all (INV-4) — a like that
 * went out with a comment spends what one of its own would.
 */
export const LIKE_SPENDS = ["like_target", "like"] as const satisfies readonly EngageAction[];

const DAY = 24 * 60 * 60_000;

/** What a reply's like aims at — Like reply's targets, never Like post's: a
 *  reply, the comment it answers, or another person's comment on the post. */
const REPLY_LIKE_TARGETS = ["their_reply", "replied_comment", "room_comment"] as const satisfies readonly TargetType[];

/**
 * How many of the account's likes since `since` were Like reply's: a ledger
 * like whose action row aimed at a reply. Counted off the rows `LIKE_SPENDS`
 * counts, under the same predicate, so it is a share of that total — the rest
 * are Like post's — and never a second count.
 */
export async function replyLikesSince(tx: Tx, channelId: number, since: number): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(rateLimitLedger)
    .leftJoin(
      actions,
      sql`${actions.id} = (${rateLimitLedger.meta} ->> 'actionExecutionId')::bigint`,
    )
    .where(
      and(
        inArray(rateLimitLedger.action, [...LIKE_SPENDS]),
        eq(rateLimitLedger.channelId, channelId),
        gte(rateLimitLedger.ts, since),
        completedLedgerActionPredicate(),
        inArray(sql`${actions.target} ->> 'kind'`, [...REPLY_LIKE_TARGETS]),
      ),
    );
  return row?.n ?? 0;
}

/** Whether the account's like ceiling for the rolling day is spent. A null
 *  ceiling caps nothing, as at the dispatch gate. */
export async function likeCeilingReached(
  tx: Tx,
  input: { channelId: number; ceiling: number | null; now: number },
): Promise<boolean> {
  if (input.ceiling === null) return false;
  const spent = await countSince(tx, { channelId: input.channelId }, [...LIKE_SPENDS], input.now - DAY, {});
  return spent >= input.ceiling;
}

/**
 * What becomes of the like a send's step binds, decided once the send has
 * posted (`actions/messageSend.ts`):
 *
 *   ride  it is reserved as an action linked to the send and approved by it —
 *         whatever let the send go, the owner's yes or its own Automatic, lets
 *         its like go with it. A comment carries the Like post its step
 *         binds; a reply only the like its step proposed with it
 *         (`likeWithSend` true). It spends the account's like ceiling
 *   skip  a like the step proposed with its reply, whose Like reply is Off
 *         by now
 *   none  no like: the owner unticked it, a reply the step did not like, or
 *         a step that binds none
 *
 */
export type SendLike =
  | { kind: "ride"; ceiling: number | null; actionBindingId: string; version: number }
  | { kind: "skip"; reason: "like_off" }
  | { kind: "none" };

export async function sendLike(
  tx: Tx,
  campaign: Pick<Campaign, "id" | "channelId">,
  message: Pick<Message, "kind" | "likeWithSend">,
): Promise<SendLike> {
  if (message.likeWithSend === false) return { kind: "none" };
  const bound = await sendLikeBinding(tx, campaign, message.kind);
  if (!bound) {
    return message.kind === "reply" && message.likeWithSend
      ? { kind: "skip", reason: "like_off" }
      : { kind: "none" };
  }
  return message.kind === "comment" || message.likeWithSend
    ? { kind: "ride", ceiling: bound.ceiling, actionBindingId: bound.binding.action_binding_id, version: bound.version }
    : { kind: "none" };
}

/** Which sends of this campaign carry a like — what a draft waiting for a
 *  yes offers as "+ Like". A reply's is the step's to propose, so a reply
 *  offers one only where the step did (`likeWithSend` not null). */
export async function sendLikeOffers(
  tx: Tx,
  campaign: Pick<Campaign, "id" | "channelId">,
): Promise<Record<Message["kind"], boolean>> {
  return {
    comment: (await sendLikeBinding(tx, campaign, "comment")) !== null,
    reply: (await sendLikeBinding(tx, campaign, "reply")) !== null,
    room_reply: false,
  };
}

/** What the send a like rides with answered. */
export type SendLikeAim = {
  postUrn: string;
  /** The comment a reply is posted under, and the comment or reply it answers. */
  commentId?: string;
  replyToUrn?: string;
};

/**
 * What a send's like presses: the post a comment answered, or the reply a
 * reply answered. A reply under a comment of ours is read back before the
 * click (`their_reply`); one under someone else's comment on our post is a
 * room comment, liked at its own link beside the thread's root.
 */
async function sendLikeTarget(tx: Tx, message: Message, aim: SendLikeAim): Promise<ActionTarget | null> {
  if (message.kind === "comment") return likeTargetFor("post", { postUrn: aim.postUrn, reply: null, repliedTo: null });
  if (!aim.replyToUrn || message.incomingCommentId === null) return null;
  const [incoming] = await tx.select().from(incomingComments).where(eq(incomingComments.id, message.incomingCommentId));
  if (!incoming) return null;
  const parent = aim.commentId !== aim.replyToUrn ? aim.commentId : undefined;
  if (incoming.source === "our_comment_thread" && incoming.authorProfileId && parent) {
    return likeTargetFor("their_reply", {
      postUrn: aim.postUrn,
      reply: { urn: aim.replyToUrn, authorProfileId: incoming.authorProfileId, textHash: incoming.textHash },
      repliedTo: parent,
    });
  }
  return likeTargetFor("room_comment", {
    postUrn: aim.postUrn,
    reply: null,
    repliedTo: null,
    roomComment: { urn: aim.replyToUrn, authorProfileId: incoming.authorProfileId || null, ...(parent ? { parentUrn: parent } : {}) },
  });
}

/** What the message keeps of its like: why it was not made, or how it ended. */
async function setSendLikeOutcome(tx: Tx, messageId: number, outcome: Omit<MessageLikeOutcome, "at">, at = Date.now()) {
  await tx.update(messages).set({ likeOutcome: { ...outcome, at } }).where(eq(messages.id, messageId));
}

/**
 * Reserve the like a send carries, in the transaction that claims the send
 * for posting (`actions/comment.ts`, `actions/reply.ts`): one `like_target` action linked to the
 * message and approved by the send's own yes. The gate sends it as it sends
 * any like — the account's window, its like ceiling and every Stop bind it, as
 * an unattended like (`origin: worker`) whoever wrote the send — and holds it
 * until the message is posted, cancelling it if the message never will be.
 * A like the step does not bind, or the owner unticked, reserves nothing; one
 * the account has no room for, or a Stop outranks, is recorded on the message
 * as skipped.
 */
export async function reserveSendLike(
  tx: Tx,
  input: { campaign: Campaign; message: Message; aim: SendLikeAim; now?: number },
): Promise<void> {
  const { campaign, message } = input;
  const now = input.now ?? Date.now();
  const decision = await sendLike(tx, campaign, message);
  if (decision.kind === "none") return;
  const skip = (reason: string) => setSendLikeOutcome(tx, message.id, { state: "skipped", reason }, now);
  if (decision.kind === "skip") return skip(decision.reason);
  if (campaign.channelId === null) return skip("channel_row_missing");
  if (await likeCeilingReached(tx, { channelId: campaign.channelId, ceiling: decision.ceiling, now })) {
    return skip("action_budget_24h");
  }
  const target = await sendLikeTarget(tx, message, input.aim);
  if (!target) return skip("target_unresolved");
  const reserved = await reserveAction(tx, {
    channelId: campaign.channelId,
    campaignId: campaign.id,
    conversationId: null,
    authorProfileId: message.targetProfileId,
    actionBindingId: decision.actionBindingId,
    messageId: message.id,
    kind: "like_target",
    purpose: "reaction",
    target,
    candidate: { text: null, sources: [], versions: { strategy: decision.version, facts: [], memory: null, voice: null } },
    // The send's yes is this like's: it waits for no other.
    mode: "review",
    generationSeen: await currentGeneration(tx),
    now,
  });
  if (reserved.status === "refused") return skip(reserved.reason === "mode_off" ? "like_off" : reserved.reason);
  let action = reserved.action;
  if (reserved.status === "duplicate") {
    // This send's own like, reserved by an earlier attempt: still its own. One
    // the gate cancelled with a failed send comes back with the retry.
    if (action.messageId !== message.id) return skip("already_queued");
    if (action.status !== "cancelled" || action.statusReason !== "send_not_posted") return;
    action = (await tx
      .update(actions)
      .set({ status: "awaiting_review", statusReason: null, settledAt: null, updatedAt: now })
      .where(eq(actions.id, action.id))
      .returning())[0]!;
  }
  try {
    await approveAction(tx, { id: action.id, approver: `send:${message.id}`, silent: true, now });
  } catch (error) {
    if (!(error instanceof ActionLedgerError)) throw error;
    await rejectAction(tx, { id: action.id, by: "send", reason: error.code, now });
    return skip(error.code);
  }
}

/** The send a like rides with is posted: wake the drain for the like that
 *  waited on it. */
export async function wakeSendLike(tx: Tx, messageId: number): Promise<void> {
  const [like] = await tx
    .select({ channelId: actions.channelId })
    .from(actions)
    .where(and(eq(actions.messageId, messageId), eq(actions.kind, "like_target"), eq(actions.status, "approved")));
  if (like) await enqueueActionDispatch(tx, like.channelId, Date.now());
}

/** What a settled like says on the send it rode with, in the transaction that
 *  settles it, whoever settled it: the gate, a reconciliation read, the owner. */
export async function settleSendLike(
  tx: Tx,
  row: ActionRow,
  receipt: ActionReceipt,
  now: number,
): Promise<void> {
  if (row.messageId === null) return;
  const receiptId = row.id;
  switch (receipt.status) {
    case "confirmed":
      return setSendLikeOutcome(tx, row.messageId, { state: "liked", receiptId }, now);
    case "uncertain":
      return setSendLikeOutcome(tx, row.messageId, { state: "unconfirmed", receiptId }, now);
    case "definitely_not_sent":
    case "blocked": {
      const reason = receipt.evidence.resolvedBy
        ? "owner_confirmed_not_liked"
        : String(receipt.evidence.reason ?? receipt.evidence.error ?? receipt.status);
      return setSendLikeOutcome(tx, row.messageId, { state: "not_liked", receiptId, reason }, now);
    }
  }
}
