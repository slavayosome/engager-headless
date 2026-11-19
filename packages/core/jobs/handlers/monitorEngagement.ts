import { and, eq, gt, inArray, isNotNull, lte, not, or, sql } from "drizzle-orm";
import {
  campaigns,
  commentWatches,
  discoveredPosts,
  engagementEvents,
  incomingComments,
  messages,
} from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { config } from "../../config";
import { trackEngagement } from "../../telemetry/emit";
import type { CommentActivity, OwnCommentCounters } from "../../linkedin/driver";
import { isGrant } from "../../connector/resolve";
import { recordLeadTouch } from "../../leads/intake";
import { isRoomThreadReply, roomThreadReceipt } from "../../rooms/thread";
import { lookupProfileNames } from "../../linkedin/profileNames";
import {
  ConnectorError,
  isConnectorBackoff,
} from "../../linkedin/connectorError";
import { claimPacedRun, jitteredIntervalMs, watchCheckBaseMs } from "../../pacing";
import { pauseChannelForConnectorBackoff } from "../../ratelimit/killswitch";
import { replyCheckBaseMin, reservePollCall } from "../../ratelimit/ledger";
import { grantFor } from "../context";
import { enqueue, RescheduleError } from "../queue";
import type { SelfScopedCtx } from "../worker";

const DAY = 86_400_000;
/** Sweep cadence base (~75min jittered): one authored-comments counter call. */
const SWEEP_BASE_MS = 75 * 60_000;
/** Activity keeps a watch alive: extend to now+3d, but never past createdAt+21d. */
const ACTIVITY_EXTEND_MS = 3 * DAY;
const WATCH_MAX_LIFE_MS = 21 * DAY;
/** The reactors a watch remembers turning into `like_received` events. */
export const SEEN_REACTORS_CAP = 200;

/**
 * Engagement monitor: re-checks comments WE posted (comment_watches, armed in
 * the send) for replies/reactions — the product's real success metric.
 *
 * SELF_SCOPED, pollIncoming's connection discipline: short tx → release → the
 * provider fetch holds NO pooled connection → short write tx (pool max 1 on the
 * serverless drainers).
 *
 * Two-tier detection (spike-confirmed 2026-07-06):
 *  1. SWEEP (~75min jittered, 1 call): GET /users/{memberId}/comments returns
 *     reply/reaction counters for our recent comments; watches whose counters
 *     moved are marked due immediately.
 *  2. DRILL-IN (per due watch, 1-2 calls): replies via
 *     GET /posts/{post}/comments?comment_id=ours (thread is flat under our
 *     root comment), reactions with reactor identity via
 *     GET /posts/{post}/reactions?comment_id=ours.
 *
 * Detected replies land in incoming_comments (source='our_comment_thread',
 * dedup by the (org, comment_urn) unique index — which also guards the
 * engagement_events insert, since events are written only for NEWLY inserted
 * rows). They always land status='new'; whether/who drafts a reply is decided
 * in processIncoming via the owning campaign's Reply mode.
 * Reactions become like_received events, deduped per reactor via seenReactorIds.
 *
 * ONE ARM PER WATCH. On a connector that also reads a comment's thread
 * (`incoming.readCommentReplies`), pollIncoming's thread arm owns the watches
 * it reads ({@link threadReadWatches}) and the drill-in skips them: a reply is
 * read by one path, from one budget.
 */
export async function handleMonitorEngagement(ctx: SelfScopedCtx, _payload: unknown): Promise<void> {
  const org = ctx.organizationId;
  const now = Date.now();

  // ---- Phase 1 (short tx): expire, sweep-claim, take the capabilities. -------
  const setup = await withOrg(org, async (tx) => {
    // A watch that runs out keeps no mark of its post answering gone once:
    // only one retired by the second answer does (`missPost`, replyWatches.ts).
    await tx
      .update(commentWatches)
      .set({ state: "expired", missingSince: null, updatedAt: now })
      .where(
        and(
          eq(commentWatches.state, "active"),
          or(
            lte(commentWatches.expiresAt, now),
            and(
              sql`${commentWatches.quietChecks} >= ${config.watchQuietMax}`,
              lte(commentWatches.createdAt, now - 3 * DAY),
            ),
          ),
        ),
      );
    const sweep = await claimPacedRun(tx, "monitor_sweep", SWEEP_BASE_MS, now);
    const activity = await grantFor(ctx, tx, "comment_activity");
    // The reply-author backfill below is its own question: a connector that
    // reads comment activity but no profiles leaves the names it already has.
    const names = await grantFor(ctx, tx, "profile");
    const incoming = await grantFor(ctx, tx, "incoming");
    return {
      sweepDue: sweep.due,
      activity: isGrant(activity) ? activity.use : null,
      names: isGrant(names) ? names.use : null,
      threadReads: isGrant(incoming) && Boolean(incoming.use.readCommentReplies),
    };
  });
  const commentActivity = setup.activity;
  if (!commentActivity?.fetchCommentActivity) return; // no comment-level access

  // ---- Phase 2 (no tx held): counter sweep → mark moved watches due. ----------
  if (setup.sweepDue && commentActivity.fetchOwnCommentCounters) {
    const reserved = await withOrg(org, (tx) => reservePollCall({ db: tx, now }));
    if (!reserved.ok) {
      throw new RescheduleError(reserved.reason ?? "poll_capped", reserved.retryAt);
    }
    let counters: OwnCommentCounters[];
    try {
      counters = await commentActivity.fetchOwnCommentCounters();
    } catch (e) {
      if (isConnectorBackoff(e)) {
        // Account-level pressure pauses the account, not just this job.
        const reason = await pauseChannelForConnectorBackoff(org, e);
        throw new RescheduleError(reason, now + 15 * 60_000);
      }
      throw e;
    }
    if (counters.length > 0) {
      const byUrn = new Map(counters.map((c) => [c.commentUrn, c]));
      await withOrg(org, async (tx) => {
        const active = await tx
          .select({
            id: commentWatches.id,
            commentUrn: commentWatches.commentUrn,
            resolvedCommentId: commentWatches.resolvedCommentId,
            lastReplyCount: commentWatches.lastReplyCount,
            lastReactionCount: commentWatches.lastReactionCount,
          })
          .from(commentWatches)
          .where(eq(commentWatches.state, "active"));
        for (const w of active) {
          const c = byUrn.get(w.resolvedCommentId ?? w.commentUrn);
          if (!c) continue;
          if (c.replyCount > w.lastReplyCount || c.reactionCount > w.lastReactionCount) {
            await tx
              .update(commentWatches)
              .set({ nextCheckAt: now, updatedAt: now })
              .where(eq(commentWatches.id, w.id));
          }
        }
      });
    }
  }

  // ---- Phase 3: drill into due watches, one at a time. ------------------------
  const due = await withOrg(org, (tx) =>
    tx
      .select({ watch: commentWatches })
      .from(commentWatches)
      .innerJoin(messages, eq(messages.id, commentWatches.messageId))
      .leftJoin(campaigns, eq(campaigns.id, commentWatches.campaignId))
      .where(
        and(
          eq(commentWatches.state, "active"),
          lte(commentWatches.nextCheckAt, now),
          ...(setup.threadReads ? [not(threadReadWatches(now))] : []),
        ),
      )
      .orderBy(commentWatches.nextCheckAt)
      .limit(config.monitorBatch),
  );

  for (const { watch } of due) {
    if (ctx.signal?.aborted) return;
    const reserved = await withOrg(org, (tx) => reservePollCall({ db: tx, now: Date.now() }));
    if (!reserved.ok) {
      throw new RescheduleError(reserved.reason ?? "poll_capped", reserved.retryAt);
    }

    let activity: CommentActivity;
    try {
      activity = await commentActivity.fetchCommentActivity(
        watch.postUrn,
        watch.resolvedCommentId ?? watch.commentUrn,
      ); // NO connection held
    } catch (e) {
      // Account-level throttling applies to every watch — pause the account and
      // reschedule the run.
      if (isConnectorBackoff(e)) {
        const reason = await pauseChannelForConnectorBackoff(org, e);
        throw new RescheduleError(reason, Date.now() + 15 * 60_000);
      }
      // 404/410 = the watched comment (or its post) no longer exists — e.g.
      // the user deleted the comment on LinkedIn. That is PERMANENT for this
      // watch: retire it immediately instead of retrying a dead target.
      if (e instanceof ConnectorError && (e.status === 404 || e.status === 410)) {
        await withOrg(org, (tx) =>
          tx
            .update(commentWatches)
            .set({ state: "expired", updatedAt: Date.now() })
            .where(eq(commentWatches.id, watch.id)),
        );
        continue;
      }
      // Anything else is a PER-WATCH failure — one broken watch must never
      // head-of-line-block the whole monitor run (it sorts first by
      // nextCheckAt on every retry). Back this watch off an hour and move on.
      await withOrg(org, (tx) =>
        tx
          .update(commentWatches)
          .set({ nextCheckAt: Date.now() + 60 * 60_000, updatedAt: Date.now() })
          .where(eq(commentWatches.id, watch.id)),
      );
      continue;
    }

    // Reply items often omit the author name (thinner shape than top-level
    // comments) — resolve it from the profile so the dashboard shows a real
    // person and the eventual reply can @-tag them. Still in the no-tx phase:
    // profile calls must not hold the pool's only connection.
    const unnamed = activity.replies.filter((r) => !r.authorName && r.authorProfileId);
    if (unnamed.length > 0 && setup.names) {
      const names = await lookupProfileNames(
        setup.names,
        unnamed.map((r) => r.authorProfileId as string),
      );
      for (const r of unnamed) r.authorName = names.get(r.authorProfileId as string);
    }

    await withOrg(org, (tx) => recordActivity(tx, watch, activity, Date.now()));
  }
}

type WatchRow = typeof commentWatches.$inferSelect;

/**
 * The watches pollIncoming's thread arm reads (`pollReplyWatches`) wherever
 * the connector reads a comment's thread: active, unexpired, on a comment of
 * ours or a room reply, of a campaign — whatever it runs on or its status. Shared
 * with that arm, so the two ways of checking a watch divide the watches one
 * way. A query using it joins `messages` and `campaigns`.
 */
export function threadReadWatches(now: number) {
  return and(
    eq(commentWatches.state, "active"),
    gt(commentWatches.expiresAt, now),
    inArray(messages.kind, ["comment", "room_reply"]),
    isNotNull(campaigns.id),
  )!;
}

/**
 * A checked watch's next state: the decaying cadence from the account's
 * reply setting, a quiet check counted, activity keeping it alive. Shared with
 * pollIncoming's thread reads, so the two ways of checking a watch pace it one
 * way.
 */
export function checkedWatch(
  watch: Pick<WatchRow, "createdAt" | "expiresAt" | "quietChecks">,
  sawActivity: boolean,
  now: number,
  cadenceMin: number,
) {
  return {
    quietChecks: sawActivity ? 0 : watch.quietChecks + 1,
    expiresAt: sawActivity
      ? Math.min(watch.createdAt + WATCH_MAX_LIFE_MS, Math.max(watch.expiresAt, now + ACTIVITY_EXTEND_MS))
      : watch.expiresAt,
    nextCheckAt: now + jitteredIntervalMs(watchCheckBaseMs(now - watch.createdAt, cadenceMin)),
    updatedAt: now,
  };
}

export type WatchThread = {
  discoveredPostId: number | null;
  threadParentUrn: string;
  /** A room thread is observed only while this confirmed reply is in it. */
  roomReplyUrn?: string;
};

/** Resolve a watch to its immediate message and stable LinkedIn thread root. */
export async function resolveWatchThread(tx: Tx, watch: WatchRow): Promise<WatchThread | null> {
  const [parent] = await tx
    .select({
      kind: messages.kind,
      campaignId: messages.campaignId,
      discoveredPostId: messages.discoveredPostId,
      incomingCommentId: messages.incomingCommentId,
      externalUrn: messages.externalUrn,
      status: messages.status,
      roomReplyTarget: messages.roomReplyTarget,
    })
    .from(messages)
    .where(
      and(
        eq(messages.organizationId, watch.organizationId),
        eq(messages.id, watch.messageId),
      ),
    );
  if (!parent || !parent.externalUrn || parent.externalUrn !== watch.commentUrn) {
    return null;
  }

  let discoveredPostId: number | null;
  let threadParentUrn: string;
  let roomReplyUrn: string | undefined;
  if (parent.kind === "comment") {
    if (!parent.discoveredPostId) return null;
    discoveredPostId = parent.discoveredPostId;
    threadParentUrn = parent.externalUrn;
  } else if (parent.kind === "room_reply") {
    const target = parent.roomReplyTarget;
    if (parent.status !== "posted" || !target || target.postUrn !== watch.postUrn ||
        parent.campaignId !== watch.campaignId || !parent.externalUrn.trim()) return null;
    // A reply under a lead's comment has no post row: Scout kept the comment.
    discoveredPostId = target.source === "lead" ? null : target.discoveredPostId;
    threadParentUrn = target.parentCommentUrn;
    roomReplyUrn = parent.externalUrn;
  } else {
    if (!parent.incomingCommentId) return null;
    const [parentIncoming] = await tx
      .select()
      .from(incomingComments)
      .where(
        and(
          eq(incomingComments.organizationId, watch.organizationId),
          eq(incomingComments.id, parent.incomingCommentId),
        ),
      );
    if (!parentIncoming) return null;

    if (parentIncoming.source === "own_post") {
      if (parentIncoming.discoveredPostId || parentIncoming.parentMessageId) return null;
      discoveredPostId = null;
      threadParentUrn = parentIncoming.commentUrn;
    } else {
      if (!parentIncoming.parentMessageId || !parentIncoming.threadParentUrn) return null;
      discoveredPostId = parentIncoming.discoveredPostId;
      threadParentUrn = parentIncoming.threadParentUrn;
      if (await isRoomThreadReply(tx, parentIncoming)) {
        const receipt = await roomThreadReceipt(tx, parentIncoming);
        if (!receipt) return null;
        roomReplyUrn = receipt;
      }
    }
  }

  if (discoveredPostId) {
    const [post] = await tx
      .select({ campaignId: discoveredPosts.campaignId, postUrn: discoveredPosts.postUrn })
      .from(discoveredPosts)
      .where(
        and(
          eq(discoveredPosts.organizationId, watch.organizationId),
          eq(discoveredPosts.id, discoveredPostId),
        ),
      );
    if (!post || (watch.campaignId !== null && post.campaignId !== watch.campaignId) ||
        (roomReplyUrn && post.postUrn !== watch.postUrn)) {
      return null;
    }
  }

  return { discoveredPostId, threadParentUrn, ...(roomReplyUrn ? { roomReplyUrn } : {}) };
}

/** Persist one drill-in result: intake new replies, event new reactors, re-pace. */
async function recordActivity(
  tx: Tx,
  watch: WatchRow,
  activity: CommentActivity,
  now: number,
): Promise<void> {
  let sawActivity = false;

  // SELF-FILTER: LinkedIn threads are flat under the root comment, so the
  // drill-in listing includes OUR OWN posted replies. Without this, a reply we
  // just posted re-enters as "incoming" (phantom author), inflates
  // reply_received, and gets drafted against — the bot talking to itself.
  // Everything we post carries its externalUrn on the messages row, so match
  // reply urns against our own posted messages and drop the hits.
  const replyUrns = activity.replies.map((r) => r.replyUrn).filter(Boolean);
  const ours = replyUrns.length
    ? new Set(
        (
          await tx
            .select({ urn: messages.externalUrn })
            .from(messages)
            .where(inArray(messages.externalUrn, replyUrns))
        ).map((m) => m.urn),
      )
    : new Set<string | null>();
  const incomingReplies = activity.replies.filter((r) => !ours.has(r.replyUrn));
  const thread = incomingReplies.length > 0
    ? await resolveWatchThread(tx, watch)
    : null;

  for (const reply of incomingReplies) {
    // Old rows predate stable links. If their watch cannot prove a same-tenant
    // immediate parent and root, ignore the inbound instead of mis-threading it.
    // The legacy activity listing cannot prove the room's root and our reply
    // are still together. Only a complete thread read admits that conversation.
    if (!thread || thread.roomReplyUrn) continue;
    const [inserted] = await tx
      .insert(incomingComments)
      .values({
        campaignId: watch.campaignId,
        ownPostUrn: watch.postUrn,
        commentUrn: reply.replyUrn,
        authorProfileId: reply.authorProfileId,
        authorName: reply.authorName,
        text: reply.text,
        receivedAt: reply.ts ?? now,
        source: "our_comment_thread",
        discoveredPostId: thread.discoveredPostId,
        parentMessageId: watch.messageId,
        threadParentUrn: thread.threadParentUrn,
        // Always 'new': whether a reply gets drafted (and by whom) is decided in
        // ONE place — processIncoming, via the campaign's Reply mode.
        status: "new",
      })
      .onConflictDoNothing()
      .returning({ id: incomingComments.id });
    if (!inserted) continue; // seen in an earlier check
    sawActivity = true;
    await tx.insert(engagementEvents).values({
      messageId: watch.messageId,
      ownPostUrn: watch.postUrn,
      actorProfileId: reply.authorProfileId,
      actorName: reply.authorName,
      type: "reply_received",
      ts: reply.ts ?? now,
    });
    await enqueue(tx, {
      type: "process_incoming",
      payload: { incomingCommentId: inserted.id },
      idempotencyKey: `process_incoming:${inserted.id}`,
    });
  }

  const seen = new Set(watch.seenReactorIds ?? []);
  if (activity.reactions) {
    for (const r of activity.reactions) {
      if (!r.actorProfileId || seen.has(r.actorProfileId)) continue;
      seen.add(r.actorProfileId);
      sawActivity = true;
      await tx.insert(engagementEvents).values({
        messageId: watch.messageId,
        ownPostUrn: watch.postUrn,
        actorProfileId: r.actorProfileId,
        actorName: r.actorName,
        type: "like_received",
        ts: now,
      });
      // Usage data: a person liked our comment (counted once per person).
      trackEngagement({ kind: "like_on_comment", sentAt: watch.createdAt, receivedAt: now }, tx);
      // A like is a lead TOUCH (repeat-engager promotion), never intent.
      await recordLeadTouch(tx, {
        profileId: r.actorProfileId,
        name: r.actorName ?? null,
        campaignId: watch.campaignId,
      });
    }
  }

  await tx
    .update(commentWatches)
    .set({
      lastReplyCount: Math.max(watch.lastReplyCount, activity.replyCount),
      lastReactionCount: Math.max(watch.lastReactionCount, activity.reactionCount),
      seenReactorIds: [...seen].slice(-SEEN_REACTORS_CAP),
      ...checkedWatch(watch, sawActivity, now, await replyCheckBaseMin(tx)),
    })
    .where(eq(commentWatches.id, watch.id));
}
