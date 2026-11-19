import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import {
  campaignStrategies,
  campaigns,
  commentWatches,
  engagementEvents,
  incomingComments,
  jobs,
  messages,
  type Reader,
} from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import type { LLM } from "../../ai/client";
import { config } from "../../config";
import type { CapabilitySurface } from "../../connector/resolve";
import { inheritedStrategies, inheritedGroup } from "../../strategy/inherit";
import { recordReplyEdit, tombstoneSources } from "../../conversations/record";
import { recordLeadTouch } from "../../leads/intake";
import { commentAfter, commentId, provesDeletions } from "../../linkedin/commentThread";
import {
  ConnectorError,
  isConnectorBackoff,
  isConnectorDrift,
  isConnectorSignIn,
} from "../../linkedin/connectorError";
import {
  MAX_COMMENT_REPLIES,
  MAX_NOTIFICATION_START,
  type AgentPage,
  type AgentPageRequest,
  type CommentRepliesRead,
  type CommentReply,
  type NotificationCard,
  type NotificationsRead,
} from "../../linkedin/driver";
import { jitteredIntervalMs, watchCheckBaseMs } from "../../pacing";
import { pauseChannelForConnectorBackoff } from "../../ratelimit/killswitch";
import {
  channelCeilings,
  lastNotificationSweepAt,
  replyCheckBaseMin,
  reserveReplyCheck,
} from "../../ratelimit/ledger";
import { replyReadNote } from "../../reader/notes";
import { readCommentRepliesByAgent, type ReaderMiss } from "../../reader/read";
import { droppedCount, type VerifiedReplies } from "../../reader/verify";
import { enqueue, RescheduleError } from "../queue";
import {
  assertHostedJobSpendStillAllowed,
  assertHostedJobSpendStillAllowedInTx,
} from "../spendAccess";
import type { SelfScopedCtx } from "../worker";
import {
  checkedWatch,
  resolveWatchThread,
  SEEN_REACTORS_CAP,
  threadReadWatches,
  type WatchThread,
} from "./monitorEngagement";

const HOUR = 3_600_000;

/**
 * How far back a reply may date and still be taken in, and whether one that
 * arrived while nothing was watching waits for the owner — what a campaign's
 * strategy says under `observation`, else its account default's, else this.
 */
export const DEFAULT_REPLY_OBSERVATION = {
  replay_lookback_hours: 168,
  catchup_requires_review: true,
} as const;

/**
 * A reply first seen this long after it was written arrived while nothing was
 * watching — the Mac asleep, the agent stopped, the account paused — and is
 * backlog. The slowest ordinary cadence (a watch past its first week, ~12h
 * jittered at the default reply setting, plus the poll's own) stays under it.
 */
export const CATCHUP_AFTER_MS = 24 * HOUR;

/** {@link CATCHUP_AFTER_MS}, stretched with a slower reply setting: twice the
 *  slowest tier, so an ordinary look at an old watch is never backlog. */
export function catchupAfterMs(cadenceMin: number): number {
  return Math.max(CATCHUP_AFTER_MS, 2 * watchCheckBaseMs(Infinity, cadenceMin));
}

/** How long a reply under our comment must stay missing — across two whole
 *  reads, nothing between them showing it — before it is removed; and how
 *  long the post our comment is on must answer that it is gone, no read
 *  between them loading it, before its watch retires ({@link missPost}). */
export const MISSING_CONFIRM_MS = 6 * HOUR;

/** What a watch says when a read did not find our comment: LinkedIn ranks a
 *  comment out of a busy post's default view, so it is never taken as gone. */
export const COMMENT_NOT_FOUND_NOTE = "your comment was not on the post's page; still watching it";

export type ReplyObservation = {
  lookbackMs: number;
  catchupRequiresReview: boolean;
};

/**
 * Where a read of what was said to us begins. Everything since the anchor —
 * the instant observing began: our comment posted, the campaign activated —
 * is always in; the lookback reaches back BEFORE it, for what was said while
 * nothing watched yet. A lookback of 0 catches up on nothing, and still misses
 * nothing said since.
 */
export function observedSince(
  policy: Pick<ReplyObservation, "lookbackMs">,
  anchorMs: number,
  now: number,
): number {
  return Math.min(now, anchorMs) - policy.lookbackMs;
}

type WatchRow = typeof commentWatches.$inferSelect;
type IncomingRow = typeof incomingComments.$inferSelect;

/**
 * pollIncoming's thread arm: what people said to comments we posted, on the
 * watches of every campaign ({@link threadReadWatches}) — whatever it runs on
 * and whatever its status: observing is a read, and a paused or stopped
 * campaign's replies still reach the owner. Only the account's stops end it
 * (the kill switch, an auto-pause, the window), at the reservation. A
 * campaign takes its replies into the pipeline: the reply_received event and
 * its `process_incoming` job, the Ambassador's to answer. A watch on a comment with no campaign is read
 * by no thread read — only its notification cards are kept, held — and a
 * watch on an ordinary REPLY of ours is never read: its root watch already
 * reads the conversation. A ROOM REPLY opens a watch on the original root,
 * taking in only later replies while our confirmed reply is still in it.
 *
 * LINKEDIN'S OWN NOTIFICATIONS FIRST. Where the connector reads them
 * (`readNotifications`), the account's notification cards are read before
 * any thread (`recordNotifications`). A reaction a card shows is recorded
 * from it. A reply is not: a card's words are LinkedIn's preview, so every
 * watch a reply card speaks of is read first this run, the replies the cards
 * named vouched for in that read, and the thread records the reply with its
 * own words. A reply no read this run recorded is kept held, out of the
 * pipeline, until a later read confirms it (`holdCardReplies`). The backlog
 * follows, oldest first, for what no card reports.
 *
 * A thread read asks for our comment by its urn as our posting receipt
 * spelled it: the connector reads LinkedIn's comment data for that comment's
 * own thread first, which lists every reply to it whether or not the post's
 * page shows the comment, and the post's page only where that data cannot
 * answer. A read that does not find our comment is never our comment gone —
 * LinkedIn ranks a comment out of a busy post's default view — and only a
 * post that answers it is gone ({@link postGone}), twice and
 * {@link MISSING_CONFIRM_MS} apart, retires a watch before its own expiry.
 *
 * Each page load — a page of cards, or a thread — spends a `reply_check` from
 * the account's reply-check budget first — never Research's `thread_read`, so
 * verifying matches cannot leave replies unseen — and opens no write turn.
 * Watches are read batched by post; one post that will not load ends its own
 * batch, and the next post is still read.
 *
 * FAIL CLOSED. A read that drifts — a page or a response the sidecar does not
 * recognise — changes nothing: no row, no tombstone, the watch exactly as it
 * was. Cards that drift leave the threads to be read as before; a thread that
 * drifts ends the parser's reads this run, since the next post has the same
 * layout. A read that fails for another reason re-paces only its own watch.
 *
 * THE AGENT READER. Where the connector hands over pages for it (`reader`),
 * a parser read of a pipeline watch that drifts, whose words and hashes
 * disagree, or that does not find our comment at all, is followed by the
 * agent reader's read of the same thread — its own page load, spending its
 * own `reply_check` — and after a drift every later pipeline watch this run
 * is read by the agent alone. A held watch's thread is the parser's alone:
 * no model reads it, and after a drift it waits for the next run. A read
 * that finds nothing under our comment is believed: a quiet watch costs no
 * model call. What the agent reader verifies is recorded as the parser's
 * read is, through the same rows, events and wakes; it only ever adds: an
 * edit or a deletion stays the parser's to prove. Returns what the run did,
 * for the job's result, and says it in one log line.
 */
export async function pollReplyWatches(
  ctx: SelfScopedCtx,
  incoming: CapabilitySurface<"incoming">,
  now: number,
  reader: AgentReader | null = null,
): Promise<ReplyWatchTally> {
  const tally: ReplyWatchTally = {
    agentReads: 0,
    agentRepliesRecorded: 0,
    agentRowsDropped: 0,
    swept: false,
    notificationPages: 0,
    notifiedReplies: 0,
    notifiedReactions: 0,
    threadsRead: 0,
  };
  const notified: NotifiedWatches = { first: [], vouched: new Map(), unconfirmed: [] };
  await observeWatches(ctx, incoming, now, reader, tally, notified);
  if (notified.unconfirmed.length > 0) {
    await withOrg(ctx.organizationId, async (tx) => {
      await assertHostedJobSpendStillAllowedInTx(tx, ctx);
      await holdCardReplies(tx, notified.unconfirmed, Date.now());
    });
  }
  if (tally.swept || tally.threadsRead > 0) console.info(`[replies] ${replyWatchNote(tally)}`);
  return tally;
}

/** What one run of the watches did. */
export type ReplyWatchTally = AgentReadTally & {
  /** The notification cards were read this run. */
  swept: boolean;
  /** Pages of cards read, one `reply_check` each. */
  notificationPages: number;
  /** New replies the cards showed on watched comments. */
  notifiedReplies: number;
  /** Reactions recorded from the cards. */
  notifiedReactions: number;
  /** Threads read, by the parser or the agent reader. */
  threadsRead: number;
};

/** The run as the owner reads it: "notifications (1 page): 2 replies,
 *  1 reaction on watched comments; read 3 threads". */
function replyWatchNote(tally: ReplyWatchTally): string {
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const notifications = tally.swept
    ? `notifications (${count(tally.notificationPages, "page", "pages")}): ${count(tally.notifiedReplies, "reply", "replies")}, ${count(tally.notifiedReactions, "reaction", "reactions")} on watched comments`
    : "notifications: not read";
  return `${notifications}; read ${count(tally.threadsRead, "thread", "threads")}`;
}

/** The watches a notification card is matched against: active, unexpired, on
 *  a comment of ours, whatever its campaign runs on, or with none. */
function cardWatches(now: number) {
  return and(
    eq(commentWatches.state, "active"),
    gt(commentWatches.expiresAt, now),
    inArray(messages.kind, ["comment", "room_reply"]),
  );
}

async function observeWatches(
  ctx: SelfScopedCtx,
  incoming: CapabilitySurface<"incoming">,
  now: number,
  reader: AgentReader | null,
  tally: ReplyWatchTally,
  notified: NotifiedWatches,
): Promise<void> {
  const org = ctx.organizationId;
  if (incoming.readNotifications) {
    const cards = await sweepNotifications(ctx, incoming.readNotifications.bind(incoming), now, tally);
    if (cards === "stop") return;
    if (cards !== null) {
      tally.swept = true;
      const recorded = await withOrg(org, async (tx) => {
        await assertHostedJobSpendStillAllowedInTx(tx, ctx);
        return recordNotifications(tx, cards, now);
      });
      tally.notifiedReplies = recorded.replies;
      tally.notifiedReactions = recorded.reactions;
      notified.first = recorded.first;
      notified.vouched = recorded.vouched;
      notified.unconfirmed = recorded.unconfirmed;
    }
  }
  if (!incoming.readCommentReplies) return;
  const due = await withOrg(org, async (tx) => {
    await assertHostedJobSpendStillAllowedInTx(tx, ctx);
    const rows = await tx
      .select({ watch: commentWatches, campaignId: campaigns.id })
      .from(commentWatches)
      .innerJoin(campaigns, eq(campaigns.id, commentWatches.campaignId))
      .innerJoin(messages, eq(messages.id, commentWatches.messageId))
      .where(and(threadReadWatches(now), lte(commentWatches.nextCheckAt, now)))
      // The watches a card spoke of first, then the backlog, oldest first.
      .orderBy(
        ...(notified.first.length > 0
          ? [sql`${inArray(commentWatches.id, notified.first)} desc`]
          : []),
        commentWatches.nextCheckAt,
      )
      .limit(config.monitorBatch + notified.first.length);
    return {
      rows,
      policies: await replyObservations(
        tx,
        rows.map((row) => row.campaignId),
      ),
    };
  });

  let parserDrifted = false;
  for (const batch of byPost(due.rows)) {
    for (const { watch, campaignId } of batch) {
      if (ctx.signal?.aborted) return;
      const policy = due.policies.get(campaignId) ?? observationOf(null);
      const vouchedReplyUrns = notified.vouched.get(watch.id);
      const thread = await withOrg(org, (tx) => resolveWatchThread(tx, watch));
      if (!thread) continue;
      // The agent read cannot yet prove a room's own-reply boundary, so it
      // admits no room-thread replies.
      const agentReader = !thread.roomReplyUrn ? reader : null;

      let read: CommentRepliesRead | null = null;
      if (!parserDrifted) {
        // The reply-check budget, the window or a stop said no: it says the
        // same of every watch after this one.
        if (await reserveWatchRead(org, campaignId, Date.now())) return;
        try {
          await assertHostedJobSpendStillAllowed(ctx);
          // Our comment as our posting receipt spelled it: LinkedIn's comment
          // data is asked by that urn exactly, and refuses a ugcPost comment
          // asked in the activity spelling; the post's page finds our row by
          // its id in either.
          read = await incoming.readCommentReplies(
            watch.postUrn,
            thread.threadParentUrn,
            {
              ...(thread.roomReplyUrn
                ? { roomReplyUrn: thread.roomReplyUrn }
                : { since: observedSince(policy, watch.createdAt, now) }),
              limit: MAX_COMMENT_REPLIES,
              ...(vouchedReplyUrns ? { vouchedReplyUrns } : {}),
            },
          ); // NO connection held
          tally.threadsRead += 1;
        } catch (e) {
          if (isConnectorBackoff(e)) {
            const reason = await pauseChannelForConnectorBackoff(org, e);
            throw new RescheduleError(reason, Date.now() + 15 * 60_000);
          }
          // The post itself says it is gone: nothing will ever be under our
          // comment, once a second answer confirms it.
          if (postGone(e)) {
            await withOrg(org, async (tx) => {
              await assertHostedJobSpendStillAllowedInTx(tx, ctx);
              await missPost(tx, watch, Date.now(), await replyCheckBaseMin(tx));
            });
            continue;
          }
          if (isConnectorDrift(e)) {
            console.warn(
              `[replies] watch ${watch.id}: ${e.message}`,
              JSON.stringify((e as { diagnostic?: unknown }).diagnostic ?? null),
            );
            if (!reader) return;
            parserDrifted = true;
          } else {
            // Nobody signed in reads nothing on any post.
            if (isConnectorSignIn(e)) return;
            console.error(`[replies] watch ${watch.id}:`, e);
            await withOrg(org, async (tx) =>
              tx
                .update(commentWatches)
                .set(deferredWatch(watch, Date.now(), await replyCheckBaseMin(tx)))
                .where(eq(commentWatches.id, watch.id)),
            );
            break;
          }
        }
      }

      // The post loaded as itself: an answer that it was gone is answered.
      if (read !== null && watch.missingSince !== null) {
        await withOrg(org, (tx) =>
          tx.update(commentWatches).set({ missingSince: null }).where(eq(commentWatches.id, watch.id)),
        );
      }
      // A read whose words and hashes disagree is evidence of nothing, and
      // records nothing — the agent reader's to read instead. So is a read
      // that does not find our comment, where an agent reader can look.
      const unverifiable = read !== null && !hashesAgree(read);
      const missing = read !== null && !read.comment.present;
      if (read !== null && !((unverifiable || missing) && agentReader)) {
        const parsed = read;
        await withOrg(org, async (tx) => {
          await assertHostedJobSpendStillAllowedInTx(tx, ctx);
          await recordThreadRead(tx, watch, parsed, policy, Date.now());
        });
      }
      // A read that says nothing is under our comment is believed: only a
      // read that could not be made, not trusted, or that missed our comment
      // costs a model call.
      if (agentReader === null || (read !== null && !unverifiable && !missing)) continue;

      const agent = await readWatchByAgent(ctx, agentReader, watch, campaignId, policy);
      if (agent === "stop") return;
      // A post that will not load ends its own batch, as a parser read's
      // failure does.
      if (agent === "failed") break;
      tally.agentReads += 1;
      tally.threadsRead += 1;
      tally.agentRepliesRecorded += agent.recorded;
      tally.agentRowsDropped += agent.dropped;
    }
  }
}

/**
 * The account's notification cards, page by page: the page an ordinary page
 * load already fetched, then — while every card on a page is newer than the
 * last sweep — the next, to {@link MAX_NOTIFICATION_START}. Every page spends
 * one `reply_check` of its own, spent by no campaign: the cards are the
 * account's.
 *
 * Null when there was nothing to read for — no watch to match a card to — or
 * the first page could not be read; "stop" when no read this run can be made
 * at all: the budget, a stop, the window, nobody signed in. A later page that
 * fails leaves what the pages before it said. Counts the pages it read.
 */
async function sweepNotifications(
  ctx: SelfScopedCtx,
  readNotifications: (opts: { start: number }) => Promise<NotificationsRead>,
  now: number,
  tally: ReplyWatchTally,
): Promise<NotificationCard[] | "stop" | null> {
  const org = ctx.organizationId;
  const setup = await withOrg(org, async (tx) => {
    await assertHostedJobSpendStillAllowedInTx(tx, ctx);
    const [watching] = await tx
      .select({ id: commentWatches.id })
      .from(commentWatches)
      .innerJoin(campaigns, eq(campaigns.id, commentWatches.campaignId))
      .innerJoin(messages, eq(messages.id, commentWatches.messageId))
      .where(threadReadWatches(now))
      .limit(1);
    if (!watching) return null;
    const channel = await channelCeilings(tx);
    return { since: channel ? ((await lastNotificationSweepAt(tx, channel.id)) ?? 0) : 0 };
  });
  if (!setup) return null;

  const cards: NotificationCard[] = [];
  for (let start = 0; ; ) {
    if (await reserveWatchRead(org, null, Date.now())) return start === 0 ? "stop" : cards;
    let page: NotificationsRead;
    try {
      await assertHostedJobSpendStillAllowed(ctx);
      page = await readNotifications({ start }); // NO connection held
    } catch (e) {
      if (isConnectorBackoff(e)) {
        const reason = await pauseChannelForConnectorBackoff(org, e);
        throw new RescheduleError(reason, Date.now() + 15 * 60_000);
      }
      if (isConnectorSignIn(e)) return "stop";
      // No agent reader for the cards: a drift fails closed, and the threads
      // are read as before.
      if (isConnectorDrift(e)) {
        console.warn(
          `[replies] notifications: ${e.message}`,
          JSON.stringify((e as { diagnostic?: unknown }).diagnostic ?? null),
        );
      } else {
        console.error("[replies] notifications:", e);
      }
      return start === 0 ? null : cards;
    }
    tally.notificationPages += 1;
    cards.push(...page.cards);
    if (
      page.nextStart === null ||
      page.nextStart > MAX_NOTIFICATION_START ||
      page.oldestPublishedAt === null ||
      page.oldestPublishedAt <= setup.since
    ) {
      return cards;
    }
    start = page.nextStart;
  }
}

/** A reply a card showed whole, under the watch whose comment it answers. */
type CardReply = { watch: WatchRow; reply: CommentReply; policy: ReplyObservation };

/** What the cards left for this run's thread reads: the watches to read
 *  first, the replies a card named under each, and the replies the cards
 *  showed whole, kept until a read confirms them. */
type NotifiedWatches = {
  first: number[];
  vouched: Map<number, string[]>;
  unconfirmed: CardReply[];
};

/**
 * Write what the account's notification cards say about the comments it
 * watches, in one transaction, LinkedIn's own urns the anchor. A card is
 * matched against every active watch on a comment of ours, whatever its
 * campaign runs on, or with none:
 *
 *  - a reply card records no reply. Its words are LinkedIn's preview, which
 *    may be clipped, so its watch is read first this run, the reply vouched
 *    for in that read, and the thread's read records it with its own words.
 *    One the card showed whole waits in `unconfirmed` for the end of the run
 *    ({@link holdCardReplies}). A reply already recorded from a read asks for
 *    no read again. A comment with no campaign has no thread read: the reply
 *    its card showed is kept held, its only record, and wakes nothing;
 *  - a reaction card is a `like_received` from the person it names, once per
 *    person, and a lead touch;
 *  - a reaction card that speaks for several people, or a mention of the
 *    account on a watched post, makes its watch due now too, where a thread
 *    read will read it.
 *
 * A watch a card spoke of stays alive as activity keeps one.
 */
export async function recordNotifications(
  tx: Tx,
  cards: NotificationCard[],
  now: number,
): Promise<NotifiedWatches & { replies: number; reactions: number }> {
  const result = {
    first: [] as number[],
    vouched: new Map<number, string[]>(),
    unconfirmed: [] as CardReply[],
    replies: 0,
    reactions: 0,
  };
  if (cards.length === 0) return result;
  const watched = await tx
    .select({ watch: commentWatches, byThread: sql<boolean>`${threadReadWatches(now)}` })
    .from(commentWatches)
    .leftJoin(campaigns, eq(campaigns.id, commentWatches.campaignId))
    .innerJoin(messages, eq(messages.id, commentWatches.messageId))
    .where(cardWatches(now));
  // The watches a thread read reads: a card makes only those due.
  const threadRead = new Set(watched.flatMap(({ watch, byThread }) => (byThread ? [watch.id] : [])));
  const byComment = new Map<string, WatchRow>();
  for (const { watch } of watched) {
    byComment.set(commentId(watch.commentUrn), watch);
    if (watch.resolvedCommentId) byComment.set(commentId(watch.resolvedCommentId), watch);
  }
  // The replies a thread read already wrote under these comments — by their
  // ids, whichever inner post spelling minted them.
  const read = new Set(
    (watched.length
      ? await tx
          .select({ commentUrn: incomingComments.commentUrn })
          .from(incomingComments)
          .where(
            and(
              inArray(incomingComments.parentMessageId, watched.map(({ watch }) => watch.messageId)),
              isNotNull(incomingComments.textHash),
            ),
          )
      : []
    ).map((row) => commentId(row.commentUrn)),
  );
  const policies = await replyObservations(
    tx,
    watched.flatMap(({ watch }) => (watch.campaignId !== null ? [watch.campaignId] : [])),
  );
  const cadenceMin = await replyCheckBaseMin(tx);

  const touched = new Map<
    number,
    {
      watch: WatchRow;
      active: boolean;
      due: boolean;
      vouched: Set<string>;
      seen: Set<string>;
    }
  >();
  const touch = (watch: WatchRow) => {
    let state = touched.get(watch.id);
    if (!state) {
      state = {
        watch,
        active: false,
        due: false,
        vouched: new Set(),
        seen: new Set(watch.seenReactorIds ?? []),
      };
      touched.set(watch.id, state);
    }
    return state;
  };

  for (const card of cards) {
    if (card.kind === "mention") {
      // A comment that names the account on a watched post: whether it
      // answers our comment is the thread's to say.
      if (read.has(commentId(card.commentUrn))) continue;
      for (const { watch } of watched) {
        if (watch.postUrn === card.postUrn && threadRead.has(watch.id)) touch(watch).due = true;
      }
      continue;
    }
    const watch = byComment.get(commentId(card.commentUrn));
    if (!watch) continue;
    if (card.kind === "reply") {
      if (card.replyUrn && read.has(commentId(card.replyUrn))) continue;
      const state = touch(watch);
      state.active = true;
      if (threadRead.has(watch.id)) {
        state.due = true;
        if (card.replyUrn) state.vouched.add(card.replyUrn);
      }
      const reply = card.aggregated ? null : cardReply(card, now);
      if (reply) {
        const policy = (watch.campaignId !== null ? policies.get(watch.campaignId) : undefined) ?? observationOf(null);
        result.unconfirmed.push({ watch, reply, policy });
      }
      result.replies += 1;
      continue;
    }
    const state = touch(watch);
    if (card.actor && !state.seen.has(card.actor.profileId)) {
      state.seen.add(card.actor.profileId);
      await tx.insert(engagementEvents).values({
        messageId: watch.messageId,
        ownPostUrn: watch.postUrn,
        actorProfileId: card.actor.profileId,
        actorName: card.actor.displayName ?? null,
        type: "like_received",
        ts: card.publishedAt,
      });
      // A like is a lead TOUCH (repeat-engager promotion), never intent.
      await recordLeadTouch(tx, {
        profileId: card.actor.profileId,
        name: card.actor.displayName ?? null,
        campaignId: watch.campaignId,
      });
      result.reactions += 1;
      state.active = true;
    }
    // "Ada and 3 others": the thread's count says how many.
    if (card.aggregated && threadRead.has(watch.id)) state.due = true;
  }

  for (const { watch, active, due, vouched, seen } of touched.values()) {
    if (vouched.size > 0) result.vouched.set(watch.id, [...vouched]);
    if (due) result.first.push(watch.id);
    if (!active && !due) continue;
    await tx
      .update(commentWatches)
      .set({
        ...(active
          ? {
              ...checkedWatch(watch, true, now, cadenceMin),
              seenReactorIds: [...seen].slice(-SEEN_REACTORS_CAP),
              lastReactionCount: Math.max(watch.lastReactionCount, seen.size),
            }
          : {}),
        // Read first this run; else its own cadence stands, a card being no
        // read of the thread.
        nextCheckAt: due ? now : watch.nextCheckAt,
        updatedAt: now,
      })
      .where(eq(commentWatches.id, watch.id));
  }
  return result;
}

/** The reply a card shows whole — one person, the reply and its words — as
 *  a thread read would hand it over; null where the card says less. */
function cardReply(card: NotificationCard, now: number): CommentReply | null {
  if (!card.replyUrn || !card.replyText || !card.actor) return null;
  return {
    replyUrn: card.replyUrn,
    author: {
      profileId: card.actor.profileId,
      ...(card.actor.displayName ? { displayName: card.actor.displayName } : {}),
      profileUrl: card.actor.profileUrl,
      // LinkedIn tells no one their own reply replied to them.
      isSelf: false,
      ...(card.actor.memberUrn ? { memberUrn: card.actor.memberUrn } : {}),
    },
    text: card.replyText,
    textHash: sha256(card.replyText),
    postedAt: card.publishedAt,
    observedAt: now,
    isDirectChild: true,
  };
}

/**
 * The replies a card showed that no thread read this run recorded — the
 * budget, a failed or drifted read, a page that did not show them: kept for
 * the owner as rows, HELD, their words the card's, with no event and out of
 * the pipeline, so nothing drafts or wakes against a preview. No thread read
 * wrote them, so they carry no hash; the parser's next read that shows one
 * confirms it ({@link confirmUnreadRow}). A reply already a row, one of ours
 * by its receipt, one from before the watch's lookback ({@link observedSince}),
 * or one under a watch that cannot prove its thread is left alone.
 */
async function holdCardReplies(tx: Tx, unconfirmed: CardReply[], now: number): Promise<void> {
  for (const { watch, reply, policy } of unconfirmed) {
    if (reply.postedAt !== undefined && reply.postedAt < observedSince(policy, watch.createdAt, now)) {
      continue;
    }
    const [receipt] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.externalUrn, reply.replyUrn));
    if (receipt) continue;
    const thread = await resolveWatchThread(tx, watch);
    if (!thread || thread.roomReplyUrn) continue;
    await tx
      .insert(incomingComments)
      .values({
        ...replyRow(watch, thread, reply, now),
        textHash: null,
        observedAt: null,
        sensitivity: "hold",
        holdReason: "unconfirmed",
      })
      .onConflictDoNothing();
  }
}

/** The agent reader as a reply watch uses it: the connector's page load, and
 *  the owner's model. */
export type AgentReader = {
  readPage: (request: AgentPageRequest) => Promise<AgentPage>;
  llm: LLM;
};

/** What one agent read of a watch recorded. */
export type AgentThreadRead = { recorded: number; dropped: number };

/** What the agent reader did in one run of the watches. */
export type AgentReadTally = {
  agentReads: number;
  agentRepliesRecorded: number;
  agentRowsDropped: number;
};

/** Every reply's words hash to the hash it carries: what a read must show
 *  before anything is written from it. */
function hashesAgree(read: CommentRepliesRead): boolean {
  return read.replies.every((reply) => sha256(reply.text) === reply.textHash);
}

/**
 * One agent read of a watch's thread: reserve its own `reply_check`, load the
 * page as words and anchors, ask the owner's model, record what verifies.
 * "stop" when no further read this run can succeed — the budget, a stop,
 * nobody signed in; "failed" when the page would not load, which re-paces the
 * watch as a failed parser read does, or the post answered that it is gone
 * ({@link missPost}).
 */
async function readWatchByAgent(
  ctx: SelfScopedCtx,
  reader: AgentReader,
  watch: WatchRow,
  campaignId: number,
  policy: ReplyObservation,
): Promise<"stop" | "failed" | AgentThreadRead> {
  const org = ctx.organizationId;
  if (await reserveWatchRead(org, campaignId, Date.now())) return "stop";
  const commentUrn = watch.resolvedCommentId ?? watch.commentUrn;
  let page: AgentPage;
  try {
    await assertHostedJobSpendStillAllowed(ctx);
    page = await reader.readPage({ intent: "comment_replies", postUrn: watch.postUrn, commentUrn }); // NO connection held
  } catch (e) {
    if (isConnectorBackoff(e)) {
      const reason = await pauseChannelForConnectorBackoff(org, e);
      throw new RescheduleError(reason, Date.now() + 15 * 60_000);
    }
    if (isConnectorSignIn(e)) return "stop";
    if (postGone(e)) {
      await withOrg(org, async (tx) => {
        await assertHostedJobSpendStillAllowedInTx(tx, ctx);
        await missPost(tx, watch, Date.now(), await replyCheckBaseMin(tx));
      });
      return "failed";
    }
    console.error(`[replies] watch ${watch.id}: the agent reader's page:`, e);
    await withOrg(org, async (tx) =>
      tx
        .update(commentWatches)
        .set(deferredWatch(watch, Date.now(), await replyCheckBaseMin(tx)))
        .where(eq(commentWatches.id, watch.id)),
    );
    return "failed";
  }
  await assertHostedJobSpendStillAllowed(ctx);
  const result = await readCommentRepliesByAgent(reader.llm, page, { commentUrn }); // NO connection held
  return withOrg(org, async (tx) => {
    await assertHostedJobSpendStillAllowedInTx(tx, ctx);
    return recordAgentThreadRead(tx, watch, result, policy, Date.now());
  });
}

/** Due watches grouped by the post they hang on, in the order first due. */
function byPost<T extends { watch: WatchRow }>(rows: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const group = groups.get(row.watch.postUrn);
    if (group) group.push(row);
    else groups.set(row.watch.postUrn, [row]);
  }
  return [...groups.values()];
}

/** The read's reservation against the account's reply-check budget, committed
 *  on its own before the page load, as a verify read's is; null when it may
 *  proceed, else why no further check this run can be made. */
async function reserveWatchRead(
  organizationId: string,
  campaignId: number | null,
  now: number,
): Promise<string | null> {
  const refused = await withOrg(organizationId, async (tx) => {
    const channel = await channelCeilings(tx);
    if (!channel) return "no_channel";
    const decision = await reserveReplyCheck({ db: tx, channel, campaignId, now });
    return decision.ok ? null : decision.reason;
  });
  if (refused === "reply_check_daily_cap") {
    console.warn(`[replies] reply checks stop for this run: ${refused}`);
  }
  return refused;
}

/** A watch whose read failed is read again at its ordinary cadence, so a
 *  thread that will not load costs no more reads than one that does. */
function deferredWatch(watch: WatchRow, now: number, cadenceMin: number) {
  return {
    nextCheckAt: now + jitteredIntervalMs(watchCheckBaseMs(now - watch.createdAt, cadenceMin)),
    updatedAt: now,
  };
}

function observationOf(
  observation: { replay_lookback_hours: number; catchup_requires_review: boolean } | null,
): ReplyObservation {
  const { replay_lookback_hours, catchup_requires_review } =
    observation ?? DEFAULT_REPLY_OBSERVATION;
  return {
    lookbackMs: replay_lookback_hours * HOUR,
    catchupRequiresReview: catchup_requires_review,
  };
}

/**
 * Each campaign's observation policy, inherited the way the resolver inherits
 * a mode: its own active strategy, else its channel's account default, else
 * {@link DEFAULT_REPLY_OBSERVATION}. A stored document that no longer parses
 * says nothing, and the next scope answers.
 */
export async function replyObservations(
  tx: Tx,
  campaignIds: number[],
): Promise<Map<number, ReplyObservation>> {
  const strategies = await inheritedStrategies(tx, campaignIds);
  return new Map(
    [...strategies].map(([campaignId, inherited]) => [
      campaignId,
      observationOf(inheritedGroup(inherited, "observation")),
    ]),
  );
}

/**
 * A campaign's own reads of the account — its inbox, its invitations — as
 * {@link observedSince} anchors them: its observation policy, and the instant
 * it began observing — its strategy's first activation, else its creation.
 */
export async function campaignObservation(
  tx: Tx,
  campaignId: number,
  now: number,
): Promise<{ policy: ReplyObservation; anchorMs: number }> {
  const policy = (await replyObservations(tx, [campaignId])).get(campaignId) ?? observationOf(null);
  const [activated] = await tx
    .select({ effectiveAt: campaignStrategies.effectiveAt })
    .from(campaignStrategies)
    .where(
      and(
        eq(campaignStrategies.campaignId, campaignId),
        inArray(campaignStrategies.status, ["active", "archived"]),
      ),
    )
    .orderBy(asc(campaignStrategies.effectiveAt))
    .limit(1);
  if (activated) return { policy, anchorMs: activated.effectiveAt };
  const [campaign] = await tx
    .select({ createdAt: campaigns.createdAt })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId));
  return { policy, anchorMs: campaign?.createdAt ?? now };
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Write what one thread read of a watched comment found, in one transaction.
 *
 *  - Our comment not found (`present: false`): a note on the watch, re-paced,
 *    and nothing else — however often it is read so. LinkedIn ranks a comment
 *    out of a busy post's default view, document and markup alike, so a page
 *    that does not show ours says nothing of whether it is there: the watch
 *    keeps to its own expiry, and every reply under it stays.
 *  - A comment the account did not write: nothing under it is ours; the watch
 *    is re-paced and nothing else changes. A read keyed by our comment's urn
 *    alone names no author (`authorIsSelf: null`): the watch's own posting
 *    receipt is what makes it ours ({@link resolveWatchThread}).
 *  - Otherwise each direct reply someone else wrote, since the watch's
 *    lookback ({@link observedSince}): a new urn is a row
 *    (`source = our_comment_thread`, held when it is backlog and the policy
 *    says backlog waits); a known urn no read wrote — a reply a notification
 *    card showed, held — takes the read's words and is released into the
 *    pipeline ({@link confirmUnreadRow}); a known urn with a new text hash is an EDIT —
 *    the row's text moves and its revision counts, never a second row; and a
 *    known reply that a whole read, vouched for by LinkedIn's own count, no
 *    longer shows is MISSING ({@link missReplies}): one such read proves
 *    nothing, and only a second at least {@link MISSING_CONFIRM_MS} on, no
 *    read between them showing it, is the reply deleted. A held reply — words
 *    no read has confirmed — goes missing only from a read whose replies came
 *    from data that lists every reply it holds (`repliesFrom`): LinkedIn's
 *    comment data for our comment's thread, or the post page's own.
 *
 * A reply's text and hash must agree, or the read is not evidence of anything
 * and nothing is written: a row comes only from a thread read that checks out.
 */
export async function recordThreadRead(
  tx: Tx,
  watch: WatchRow,
  read: CommentRepliesRead,
  policy: ReplyObservation,
  now: number,
): Promise<void> {
  if (read.replies.some((reply) => sha256(reply.text) !== reply.textHash)) {
    console.error(`[replies] watch ${watch.id}: a reply's text and hash disagree; nothing recorded`);
    return;
  }
  const cadenceMin = await replyCheckBaseMin(tx);
  if (!read.comment.present) {
    await tx
      .update(commentWatches)
      .set({ lastReadNote: COMMENT_NOT_FOUND_NOTE, ...deferredWatch(watch, now, cadenceMin) })
      .where(eq(commentWatches.id, watch.id));
    return;
  }
  const thread = await resolveWatchThread(tx, watch);
  const roomReceipt = thread?.roomReplyUrn;
  const roomPresent = roomReceipt && read.replies.some((reply) =>
    reply.isDirectChild && reply.author.isSelf && commentId(reply.replyUrn) === commentId(roomReceipt),
  );
  if (!thread || (roomReceipt
    ? !roomPresent || commentId(read.comment.urn) !== commentId(thread.threadParentUrn)
    : read.comment.authorIsSelf === false)) {
    // Not our comment after all, or a watch that cannot prove its parent:
    // nothing under it may be attributed to us.
    await tx
      .update(commentWatches)
      .set(deferredWatch(watch, now, cadenceMin))
      .where(eq(commentWatches.id, watch.id));
    return;
  }

  const since = observedSince(policy, watch.createdAt, now);
  const direct = read.replies.filter((reply) => reply.isDirectChild);
  const urns = direct.map((reply) => reply.replyUrn);
  // SELF-FILTER, as the monitor's: the owner's own replies — by the page's
  // word, or by a receipt on one of our messages — are not incoming.
  const receipts = urns.length
    ? new Set(
        (
          await tx
            .select({ urn: messages.externalUrn })
            .from(messages)
            .where(inArray(messages.externalUrn, urns))
        ).map((row) => row.urn),
      )
    : new Set<string | null>();
  const incoming = direct.filter(
    (reply) =>
      !reply.author.isSelf &&
      !receipts.has(reply.replyUrn) &&
      (!roomReceipt || commentAfter(reply.replyUrn, roomReceipt)) &&
      (reply.postedAt === undefined || reply.postedAt >= since),
  );
  // The row each reply already is, by its id: its own urn anywhere, or — a
  // reply a card held, in the card's spelling of the post — under this watch.
  const known = new Map<string, IncomingRow>();
  if (incoming.length) {
    const rows = await tx
      .select()
      .from(incomingComments)
      .where(
        or(
          inArray(incomingComments.commentUrn, incoming.map((reply) => reply.replyUrn)),
          eq(incomingComments.parentMessageId, watch.messageId),
        ),
      );
    for (const row of rows) {
      const id = commentId(row.commentUrn);
      if (!known.has(id) || row.parentMessageId === watch.messageId) known.set(id, row);
    }
  }

  let sawActivity = false;
  for (const reply of incoming) {
    const row = known.get(commentId(reply.replyUrn));
    if (!row) {
      sawActivity =
        (await insertReply(tx, watch, thread, reply, policy, now, cadenceMin)) || sawActivity;
      continue;
    }
    // Another thread's row, or one already gone: not this read's to change.
    if (row.parentMessageId !== watch.messageId || row.removedAt !== null) continue;
    // Who wrote it, as LinkedIn's conversation data names them: learnt once,
    // from the first read that carries it.
    if (row.authorMemberUrn === null && reply.author.memberUrn) {
      await tx
        .update(incomingComments)
        .set({ authorMemberUrn: reply.author.memberUrn })
        .where(eq(incomingComments.id, row.id));
    }
    if (row.textHash === reply.textHash) continue;
    if (row.textHash === null) {
      sawActivity =
        (await confirmUnreadRow(tx, watch, row, reply, policy, now, cadenceMin)) || sawActivity;
      continue;
    }
    await reviseReply(tx, row, reply, now);
    sawActivity = true;
  }

  const present = new Set(direct.map((reply) => commentId(reply.replyUrn)));
  await foundReplies(tx, watch, present);
  if (provesDeletions(read.comment, read.truncated)) {
    // Only replies inside the lookback are this read's to speak for — older
    // ones are not in the read at all.
    const live = await liveReplies(tx, watch, since);
    const listsEveryReply =
      read.comment.repliesFrom === "comment_data" || read.comment.repliesFrom === "page_data";
    await missReplies(
      tx,
      live.filter(
        (row) =>
          !present.has(commentId(row.commentUrn)) && (row.textHash !== null || listsEveryReply),
      ),
      now,
    );
  }

  // The reactions our row prints on itself: more than last seen is activity.
  const reactions = roomReceipt ? 0 : read.comment.reactionCount ?? 0;
  sawActivity ||= reactions > watch.lastReactionCount;
  await tx
    .update(commentWatches)
    .set({
      lastReplyCount: Math.max(watch.lastReplyCount, direct.length),
      lastReactionCount: Math.max(watch.lastReactionCount, reactions),
      // The parser answered this check: no agent read's note speaks for it.
      lastReadNote: null,
      ...(!roomReceipt && read.comment.resolvedId !== watch.commentUrn && !watch.resolvedCommentId
        ? { resolvedCommentId: read.comment.resolvedId }
        : {}),
      ...checkedWatch(watch, sawActivity, now, cadenceMin),
    })
    .where(eq(commentWatches.id, watch.id));
}

/**
 * Write what one agent read of a watched comment verified, in one
 * transaction, through the parser's own path: each reply someone else wrote,
 * since the watch's lookback and not one of our receipts, is a first sighting
 * (`insertReply`, stamped `reader = 'agent'`) with its event and its
 * `process_incoming` job — which is what wakes the Ambassador. A reply
 * already held is left exactly as it is: the agent reader never edits,
 * tombstones or retires anything, because a model's answer is not the whole
 * read an absence needs. A reply it verified on the page is no longer
 * missing ({@link foundReplies}).
 *
 * The watch keeps the higher of its counts and what the page showed, takes
 * the read's note and is re-paced as a checked watch — or, where nothing
 * verified, as a failed read is.
 */
export async function recordAgentThreadRead(
  tx: Tx,
  watch: WatchRow,
  result: VerifiedReplies | ReaderMiss,
  policy: ReplyObservation,
  now: number,
): Promise<AgentThreadRead> {
  const [current] = await tx.select().from(commentWatches).where(eq(commentWatches.id, watch.id));
  if (!current) return { recorded: 0, dropped: 0 };
  const cadenceMin = await replyCheckBaseMin(tx);
  const thread = result.status === "verified" ? await resolveWatchThread(tx, current) : null;
  if (result.status !== "verified" || !thread || thread.roomReplyUrn) {
    await tx
      .update(commentWatches)
      .set({ lastReadNote: replyReadNote(result, 0), ...deferredWatch(current, now, cadenceMin) })
      .where(eq(commentWatches.id, current.id));
    return { recorded: 0, dropped: result.status === "verified" ? droppedCount(result.dropped) : 0 };
  }

  const since = observedSince(policy, current.createdAt, now);
  const urns = result.replies.map((reply) => reply.replyUrn);
  // SELF-FILTER, as the parser path's: the owner's own replies are not
  // incoming.
  const receipts = urns.length
    ? new Set(
        (
          await tx
            .select({ urn: messages.externalUrn })
            .from(messages)
            .where(inArray(messages.externalUrn, urns))
        ).map((row) => row.urn),
      )
    : new Set<string | null>();
  let recorded = 0;
  for (const reply of result.replies) {
    if (reply.author.isSelf || receipts.has(reply.replyUrn)) continue;
    if (reply.postedAt !== undefined && reply.postedAt < since) continue;
    if (await insertReply(tx, current, thread, reply, policy, now, cadenceMin, "agent")) {
      recorded += 1;
    }
  }
  // A reply the page shows is not missing: the agent reader proves no
  // absence, but what it verified on the page is there.
  await foundReplies(tx, current, new Set(result.replies.map((reply) => commentId(reply.replyUrn))));
  const reactions = result.reactionCount ?? 0;
  const sawActivity = recorded > 0 || reactions > current.lastReactionCount;
  await tx
    .update(commentWatches)
    .set({
      lastReplyCount: Math.max(current.lastReplyCount, result.replies.length, result.replyCount ?? 0),
      lastReactionCount: Math.max(current.lastReactionCount, reactions),
      lastReadNote: replyReadNote(result, recorded),
      ...(result.resolvedUrn !== current.commentUrn && !current.resolvedCommentId
        ? { resolvedCommentId: result.resolvedUrn }
        : {}),
      ...checkedWatch(current, sawActivity, now, cadenceMin),
    })
    .where(eq(commentWatches.id, current.id));
  return { recorded, dropped: droppedCount(result.dropped) };
}

/** A first sighting: one row, its reply_received event and its pipeline job.
 *  False when another writer took the urn first. */
async function insertReply(
  tx: Tx,
  watch: WatchRow,
  thread: WatchThread,
  reply: CommentReply,
  policy: ReplyObservation,
  now: number,
  cadenceMin: number,
  reader: Reader = "parser",
): Promise<boolean> {
  const [inserted] = await tx
    .insert(incomingComments)
    .values({
      ...replyRow(watch, thread, reply, now),
      ...backlogHold(reply, policy, now, cadenceMin),
      reader,
    })
    .onConflictDoNothing()
    .returning({ id: incomingComments.id });
  if (!inserted) return false;
  await replyArrived(tx, watch, inserted.id, reply, now);
  return true;
}

/** A thread reply's row, as any reader records it. */
function replyRow(watch: WatchRow, thread: WatchThread, reply: CommentReply, now: number) {
  return {
    campaignId: watch.campaignId,
    ownPostUrn: watch.postUrn,
    commentUrn: reply.replyUrn,
    authorProfileId: reply.author.profileId,
    authorMemberUrn: reply.author.memberUrn ?? null,
    authorName: reply.author.displayName,
    text: reply.text,
    textHash: reply.textHash,
    observedAt: reply.observedAt,
    receivedAt: reply.postedAt ?? now,
    source: "our_comment_thread" as const,
    discoveredPostId: thread.discoveredPostId,
    parentMessageId: watch.messageId,
    threadParentUrn: thread.threadParentUrn,
    status: "new" as const,
  };
}

/** Backlog reaches a person before anything is drafted against it. */
function backlogHold(
  reply: CommentReply,
  policy: ReplyObservation,
  now: number,
  cadenceMin: number,
): { sensitivity: "hold"; holdReason: "backlog" } | { sensitivity: "ok"; holdReason: null } {
  const backlog =
    reply.postedAt === undefined || now - reply.postedAt > catchupAfterMs(cadenceMin);
  return backlog && policy.catchupRequiresReview
    ? { sensitivity: "hold", holdReason: "backlog" }
    : { sensitivity: "ok", holdReason: null };
}

/** A reply's first sighting reaches the account: its reply_received event and
 *  its pipeline job. */
async function replyArrived(
  tx: Tx,
  watch: WatchRow,
  incomingCommentId: number,
  reply: CommentReply,
  now: number,
): Promise<void> {
  await tx.insert(engagementEvents).values({
    messageId: watch.messageId,
    ownPostUrn: watch.postUrn,
    actorProfileId: reply.author.profileId,
    actorName: reply.author.displayName,
    type: "reply_received",
    ts: reply.postedAt ?? now,
  });
  await enqueue(tx, {
    type: "process_incoming",
    payload: { incomingCommentId },
    idempotencyKey: `process_incoming:${incomingCommentId}`,
    nextRunAt: now,
  });
}

/**
 * A row no thread read wrote takes this read's words as its first revision —
 * no edit, nothing withdrawn. A reply a notification card showed was kept
 * HELD and out of the pipeline until now ({@link holdCardReplies}): its words
 * confirmed, it reaches the account, once, and is released into the pipeline,
 * held only where a thread read's own first sighting would be. A row another
 * reader wrote is already in the pipeline and only takes the words. True when a held
 * reply reached the account.
 */
async function confirmUnreadRow(
  tx: Tx,
  watch: WatchRow,
  row: IncomingRow,
  reply: CommentReply,
  policy: ReplyObservation,
  now: number,
  cadenceMin: number,
): Promise<boolean> {
  const [confirmed] = await tx
    .update(incomingComments)
    .set({ text: reply.text, textHash: reply.textHash, observedAt: reply.observedAt })
    .where(and(eq(incomingComments.id, row.id), isNull(incomingComments.textHash)))
    .returning({ id: incomingComments.id });
  if (!confirmed) return false;
  const [queued] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        // `jobs` is outside RLS, so the org predicate is explicit: the
        // transaction's own.
        sql`${jobs.organizationId} = nullif(current_setting('app.current_org', true), '')::uuid`,
        eq(jobs.idempotencyKey, `process_incoming:${row.id}`),
      ),
    );
  if (queued) return false;
  // Confirmed, it is held for what holds any reply its watch reads, and no
  // longer as an unconfirmed card.
  await tx
    .update(incomingComments)
    .set(backlogHold(reply, policy, now, cadenceMin))
    .where(eq(incomingComments.id, row.id));
  await replyArrived(tx, watch, row.id, reply, now);
  return true;
}

/**
 * The reply was edited: the row takes the words the thread shows now and
 * counts a revision, and a reply already on a conversation gains the revision as a
 * superseding event. A draft written against the old words answers something
 * nobody says any more, so it is withdrawn, and the row is open again for a
 * reply to what it says now.
 */
async function reviseReply(
  tx: Tx,
  row: IncomingRow,
  reply: CommentReply,
  now: number,
): Promise<void> {
  const [revised] = await tx
    .update(incomingComments)
    .set({
      text: reply.text,
      textHash: reply.textHash,
      textRevision: row.textRevision + 1,
      observedAt: reply.observedAt,
    })
    .where(
      and(
        eq(incomingComments.id, row.id),
        eq(incomingComments.textRevision, row.textRevision),
      ),
    )
    .returning();
  if (revised) await recordReplyEdit(tx, revised, now);
  const withdrawn = await withdrawUnsentDrafts(tx, [row.id], "reply_edited");
  if (withdrawn.length > 0) {
    await tx
      .update(incomingComments)
      .set({ status: "new" })
      .where(
        and(
          eq(incomingComments.id, row.id),
          eq(incomingComments.status, "reply_proposed"),
        ),
      );
  }
}

/**
 * Whether a read's failure is the post our comment is on answering that it is
 * gone: a connector's 404/410, or the browser sidecar's THREAD_UNAVAILABLE
 * that is worth no retry, which its comment read answers only for LinkedIn's
 * own page for a post deleted or removed (`replies.py`). Every other page
 * without the post may load as it next time.
 */
function postGone(e: unknown): boolean {
  if (!(e instanceof ConnectorError)) return false;
  if (e.status === 404 || e.status === 410) return true;
  return (e as { code?: unknown }).code === "THREAD_UNAVAILABLE" && !e.retryable;
}

/**
 * The post our comment is on answered that it is gone ({@link postGone}). The
 * first such answer only marks the watch (`missing_since`) and puts its next
 * check {@link MISSING_CONFIRM_MS} on; one at least that long after it, no
 * read between them having loaded the post, retires it with the mark kept —
 * so an expired watch that holds one is on a post that is gone. A read that
 * loads the post clears the mark.
 */
async function missPost(tx: Tx, watch: WatchRow, now: number, cadenceMin: number): Promise<void> {
  if (watch.missingSince !== null && now - watch.missingSince >= MISSING_CONFIRM_MS) {
    await retireWatch(tx, watch, now);
    return;
  }
  const missingSince = watch.missingSince ?? now;
  const deferred = deferredWatch(watch, now, cadenceMin);
  await tx
    .update(commentWatches)
    .set({
      ...deferred,
      missingSince,
      nextCheckAt: Math.max(deferred.nextCheckAt, missingSince + MISSING_CONFIRM_MS),
    })
    .where(eq(commentWatches.id, watch.id));
}

/** The post our comment was on is gone: every reply under it goes with it
 *  ({@link removeReplies}), and the watch retires. */
async function retireWatch(tx: Tx, watch: WatchRow, now: number): Promise<void> {
  await removeReplies(tx, await liveReplies(tx, watch, null), now);
  await tx
    .update(commentWatches)
    .set({ state: "expired", updatedAt: now })
    .where(eq(commentWatches.id, watch.id));
}

/** The rows a thread read of this watch speaks for: replies directly under
 *  its comment that no read has found gone, posted since `since` (any age when
 *  null — the post going takes every reply under it). */
async function liveReplies(
  tx: Tx,
  watch: WatchRow,
  since: number | null,
): Promise<IncomingRow[]> {
  return tx
    .select()
    .from(incomingComments)
    .where(
      and(
        eq(incomingComments.parentMessageId, watch.messageId),
        eq(incomingComments.source, "our_comment_thread"),
        isNull(incomingComments.removedAt),
        ...(since !== null ? [gte(incomingComments.receivedAt, since)] : []),
      ),
    );
}

/** Replies a read showed — by their ids — are not missing, whatever a read
 *  before it said: their marks clear ({@link missReplies}). */
async function foundReplies(tx: Tx, watch: WatchRow, shown: Set<string>): Promise<void> {
  if (shown.size === 0) return;
  const marked = await tx
    .select({ id: incomingComments.id, commentUrn: incomingComments.commentUrn })
    .from(incomingComments)
    .where(
      and(
        eq(incomingComments.parentMessageId, watch.messageId),
        isNotNull(incomingComments.missingSince),
      ),
    );
  const found = marked.filter((row) => shown.has(commentId(row.commentUrn)));
  if (found.length === 0) return;
  await tx
    .update(incomingComments)
    .set({ missingSince: null })
    .where(inArray(incomingComments.id, found.map((row) => row.id)));
}

/**
 * Replies a complete read of their thread did not show, our comment present.
 * The first such read only marks them (`missing_since`); one at least
 * {@link MISSING_CONFIRM_MS} after it, no read between them having shown the
 * reply, is the reply gone ({@link removeReplies}). A reader that missed a
 * row reads exactly as a deleted reply does, and never twice that far apart.
 */
async function missReplies(tx: Tx, rows: IncomingRow[], now: number): Promise<void> {
  const first = rows.filter((row) => row.missingSince === null);
  if (first.length > 0) {
    await tx
      .update(incomingComments)
      .set({ missingSince: now })
      .where(inArray(incomingComments.id, first.map((row) => row.id)));
  }
  await removeReplies(
    tx,
    rows.filter((row) => row.missingSince !== null && now - row.missingSince >= MISSING_CONFIRM_MS),
    now,
  );
}

/** Tombstone replies that are gone, and the conversation sources they are: there
 *  is nothing left to answer, so their unsent drafts are withdrawn, and a row
 *  with no answer waiting stops waiting for one. A draft the owner already
 *  approved stays theirs. */
async function removeReplies(
  tx: Tx,
  rows: IncomingRow[],
  now: number,
): Promise<void> {
  if (rows.length === 0) return;
  const ids = rows.map((row) => row.id);
  await tx
    .update(incomingComments)
    .set({ removedAt: now })
    .where(inArray(incomingComments.id, ids));
  await tombstoneSources(tx, ids, now);
  const withdrawn = await withdrawUnsentDrafts(tx, ids, "reply_removed");
  const unanswered = eq(incomingComments.status, "new");
  await tx
    .update(incomingComments)
    .set({ status: "ignored" })
    .where(
      and(
        inArray(incomingComments.id, ids),
        withdrawn.length > 0
          ? or(
              unanswered,
              and(
                eq(incomingComments.status, "reply_proposed"),
                inArray(incomingComments.id, withdrawn),
              ),
            )
          : unanswered,
      ),
    );
}

/**
 * Withdraw the reply drafts still waiting for a yes on these rows — the
 * `proposed` ones; anything the owner already approved is theirs to recall.
 * Shaped as `dontReply` withdraws one: rejected, the redraft request cleared
 * and its version advanced, with the reason the source moved. Returns the
 * incoming rows whose draft went.
 */
async function withdrawUnsentDrafts(
  tx: Tx,
  incomingCommentIds: number[],
  reason: "reply_edited" | "reply_removed",
): Promise<number[]> {
  const drafts = await tx
    .select({
      id: messages.id,
      incomingCommentId: messages.incomingCommentId,
      version: messages.redraftRequestVersion,
    })
    .from(messages)
    .where(
      and(
        eq(messages.kind, "reply"),
        eq(messages.status, "proposed"),
        inArray(messages.incomingCommentId, incomingCommentIds),
      ),
    )
    .for("update");
  for (const draft of drafts) {
    await tx
      .update(messages)
      .set({
        status: "rejected",
        scheduledAt: null,
        error: reason,
        redraftRequestId: null,
        redraftRequestVersion: draft.version + 1,
        redraftRequestedAt: null,
        redraftRequestedBy: null,
        redraftRequestNote: null,
      })
      .where(and(eq(messages.id, draft.id), eq(messages.status, "proposed")));
  }
  return drafts.flatMap((draft) =>
    draft.incomingCommentId !== null ? [draft.incomingCommentId] : [],
  );
}
