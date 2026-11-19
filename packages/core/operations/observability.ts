import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  aiUsage,
  campaigns,
  type Channel,
  commentWatches,
  engagementEvents,
  exemplars,
  feedback,
  incomingComments,
  jobs,
  messages,
  rateLimitLedger,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { LIKE_SPENDS } from "../actions/likeTarget";
import { computeLearningSignals, type LearningSignals } from "./learningSignals";
import { pendingRecalibration } from "../learning/recalibrate";
import { getSystemState } from "../ratelimit/killswitch";
import {
  channelCeilings,
  completedLedgerActionPredicate,
  effectiveDailyCommentCap,
  warmupFactor,
} from "../ratelimit/ledger";
import { workDay } from "../time";

/**
 * Pure, Next-free observability rollups over an org-scoped `tx`. Extracted from
 * `apps/dashboard/lib/queries.ts` so the dashboard pages AND the hosted MCP tools
 * read the SAME shapes. Every query is RLS-scoped to the current org via the
 * `withOrg` connection — EXCEPT `aiUsageStats`, which filters `organization_id`
 * explicitly (ai_usage is flushed on the base pool and is NOT RLS-protected).
 */

const DAY = 86_400_000;
/** Scheduler tick older than this = stale (nominal cadence is 5 min). */
const SCHEDULER_STALE_MS = 30 * 60_000;

const HOUR = 3_600_000;

/** Jobs are outside RLS, so every read must name its organization. */
export async function listOrgJobs(tx: Tx, organizationId: string, opts: { status?: typeof jobs.$inferSelect.status; limit: number; before?: { updatedAt: number; id: number } }) {
  const predicate = and(eq(jobs.organizationId, organizationId), opts.status ? eq(jobs.status, opts.status) : undefined);
  const page = opts.before ? and(predicate, or(sql`${jobs.updatedAt} < ${opts.before.updatedAt}`, and(eq(jobs.updatedAt, opts.before.updatedAt), sql`${jobs.id} < ${opts.before.id}`))) : predicate;
  const rows = await tx.select({
    id: jobs.id, type: jobs.type, status: jobs.status, attempts: jobs.attempts,
    maxAttempts: jobs.maxAttempts, nextRunAt: jobs.nextRunAt, lastError: jobs.lastError,
    updatedAt: jobs.updatedAt, payload: jobs.payload,
  }).from(jobs).where(page).orderBy(desc(jobs.updatedAt), desc(jobs.id)).limit(opts.limit);
  const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(jobs).where(predicate);
  return { rows, total: count?.n ?? 0 };
}

type LedgerAction = "comment" | "reply" | "room_reply" | "discover" | (typeof LIKE_SPENDS)[number];

/** Campaigns that are gone from every list (`deleteCampaign`) — still what
 *  their ledger rows point at. */
const deletedCampaigns = (tx: Tx) =>
  tx.select({ id: campaigns.id }).from(campaigns).where(isNotNull(campaigns.deletedAt));

/** Rolling count of ledger actions since `since`, optionally per campaign —
 *  or, `"none"`, of the sends no standing campaign owns: none at all, or one
 *  since deleted. */
async function countActions(
  tx: Tx,
  actions: LedgerAction[],
  since: number,
  campaignId?: number | "none",
): Promise<number> {
  const conds: SQL[] = [
    inArray(rateLimitLedger.action, actions),
    gte(rateLimitLedger.ts, since),
    completedLedgerActionPredicate(),
  ];
  if (campaignId === "none")
    conds.push(
      or(isNull(rateLimitLedger.campaignId), inArray(rateLimitLedger.campaignId, deletedCampaigns(tx)))!,
    );
  else if (campaignId != null)
    conds.push(eq(rateLimitLedger.campaignId, campaignId));
  const [row] = await tx
    .select({ n: sql<number>`count(*)` })
    .from(rateLimitLedger)
    .where(and(...conds));
  return Number(row?.n ?? 0);
}

export type CampaignRateState = {
  campaignId: number;
  /** Ratio ramp — reply-lane/display only. The comment lane's real budget is
   *  `caps.effectiveDailyComment` (honors the absolute warmupStartRate). */
  warmupFactor: number;
  commentsToday: number;
  repliesToday: number;
  roomRepliesToday: number;
  commentsThisHour: number;
  likesToday: number;
  caps: {
    dailyCommentCap: number;
    dailyReplyCap: number;
    perProfileDayCap: number;
    effectiveDailyComment: number;
  };
};

export type RateLimitState = {
  now: number;
  /** Org-wide count over the account's day (no system ceiling — per-campaign caps + credits throttle). */
  global: { commentsRepliesToday: number };
  campaign?: CampaignRateState;
};

/** Where the account's day began, the one its daily caps count (`workDay`);
 *  the trailing day on an install with no channel row. */
function dayOpenOf(channel: Channel | null, now: number): number {
  return channel ? workDay(now, channel.activeHours, channel.activeDays).open : now - DAY;
}

/** Rate-limit usage, shared by the MCP `get_channel` tool and the dashboard
 *  ops page. Returns null when `campaignId` is given but unknown. */
export async function rateLimitState(
  tx: Tx,
  opts: { campaignId?: number; now?: number } = {},
): Promise<RateLimitState | null> {
  const now = opts.now ?? Date.now();
  const out: RateLimitState = {
    now,
    global: {
      commentsRepliesToday: await countActions(
        tx,
        ["comment", "reply", "room_reply"],
        dayOpenOf(await channelCeilings(tx), now),
      ),
    },
  };
  if (opts.campaignId != null) {
    const [c] = await tx
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, opts.campaignId));
    if (!c) return null;
    out.campaign = await campaignRateState(tx, c, now);
  }
  return out;
}

async function campaignRateState(
  tx: Tx,
  c: typeof campaigns.$inferSelect,
  now: number,
): Promise<CampaignRateState> {
  // Every cap on this page comes off the account, so the numbers shown are the
  // ones the send gate will actually apply.
  const channel = await channelCeilings(tx);
  const dayOpen = dayOpenOf(channel, now);
  return {
    campaignId: c.id,
    warmupFactor: channel ? warmupFactor(channel, now) : 1,
    commentsToday: await countActions(tx, ["comment"], dayOpen, c.id),
    repliesToday: await countActions(tx, ["reply"], dayOpen, c.id),
    roomRepliesToday: await countActions(tx, ["room_reply"], dayOpen, c.id),
    commentsThisHour: await countActions(tx, ["comment"], now - HOUR, c.id),
    // Every like, the action ledger's as much as one a send carried — what the
    // account's like ceiling counts (`LIKE_SPENDS`), over the trailing 24 hours
    // that ceiling binds.
    likesToday: await countActions(tx, [...LIKE_SPENDS], now - DAY, c.id),
    caps: {
      dailyCommentCap: channel?.dailyCommentCap ?? 0,
      dailyReplyCap: channel?.dailyReplyCap ?? 0,
      perProfileDayCap: channel?.perProfileDayCap ?? 0,
      effectiveDailyComment: channel
        ? effectiveDailyCommentCap(channel, now)
        : 0,
    },
  };
}

/** Org rollup: global usage, one row per campaign that is active or spent the
 *  account's limits in the rolling day (same per-campaign shape as
 *  `rateLimitState`, plus the campaign name), and what no standing campaign
 *  owns — so the rows add up to the account's totals. */
export async function orgRateLimitState(
  tx: Tx,
  now = Date.now(),
): Promise<{
  now: number;
  global: { commentsRepliesToday: number };
  campaigns: (CampaignRateState & { name: string })[];
  unattributed: { commentsToday: number; repliesToday: number; roomRepliesToday: number; likesToday: number };
}> {
  const since = now - DAY;
  const dayOpen = dayOpenOf(await channelCeilings(tx), now);
  // A campaign paused or archived since it spent still spent: its sends count
  // against the account all day (INV-4), so its row stays until they age out.
  const spent = tx
    .selectDistinct({ id: rateLimitLedger.campaignId })
    .from(rateLimitLedger)
    .where(
      and(
        inArray(rateLimitLedger.action, ["comment", "reply", "room_reply", ...LIKE_SPENDS]),
        gte(rateLimitLedger.ts, since),
        completedLedgerActionPredicate(),
      ),
    );
  const listed = await tx
    .select()
    .from(campaigns)
    .where(
      and(
        isNull(campaigns.deletedAt),
        or(eq(campaigns.status, "active"), inArray(campaigns.id, spent)),
      ),
    )
    .orderBy(asc(campaigns.id));
  const rows = [];
  for (const c of listed) {
    rows.push({ ...(await campaignRateState(tx, c, now)), name: c.name });
  }
  return {
    now,
    global: {
      commentsRepliesToday: await countActions(
        tx,
        ["comment", "reply", "room_reply"],
        dayOpen,
      ),
    },
    campaigns: rows,
    unattributed: {
      commentsToday: await countActions(tx, ["comment"], dayOpen, "none"),
      repliesToday: await countActions(tx, ["reply"], dayOpen, "none"),
      roomRepliesToday: await countActions(tx, ["room_reply"], dayOpen, "none"),
      likesToday: await countActions(tx, [...LIKE_SPENDS], since, "none"),
    },
  };
}

/** How many quiet (no-change) monitor checks before a watch is "going quiet"
 *  (decaying toward expiry — the monitor backs off, then retires it). */
const WATCH_QUIET_THRESHOLD = 3;

export type WatchMetrics = {
  /** Watches currently monitoring a posted comment for replies/reactions. */
  active: number;
  /** Active watches whose next check is already due — the monitor's backlog.
   *  A growing number with a fresh scheduler tick = the monitor is behind. */
  dueNow: number;
  /** When the monitor will next look at any active watch. null = no active watches. */
  nextCheckAt: number | null;
  /** Active watches that reach their TTL within 24h. */
  expiringWithin24h: number;
  expired: number;
  /** Active watches with several quiet checks in a row — decaying toward expiry. */
  goingQuiet: number;
};

/** One aggregate over `comment_watches` (RLS-scoped) — the engagement-monitor
 *  health view shared by `get_status` and the dashboard ops page. */
export async function watchMetrics(
  tx: Tx,
  now = Date.now(),
): Promise<WatchMetrics> {
  const [w] = await tx
    .select({
      active: sql<number>`count(*) filter (where ${commentWatches.state} = 'active')::int`,
      dueNow: sql<number>`count(*) filter (where ${commentWatches.state} = 'active' and ${commentWatches.nextCheckAt} <= ${now})::int`,
      // ::float8 — pg returns bigint aggregates as strings; ms timestamps fit
      // float8 exactly (same convention as the scheduler-tick read below).
      nextCheckAt: sql<
        number | null
      >`min(${commentWatches.nextCheckAt}) filter (where ${commentWatches.state} = 'active')::float8`,
      expiringWithin24h: sql<number>`count(*) filter (where ${commentWatches.state} = 'active' and ${commentWatches.expiresAt} <= ${now + DAY})::int`,
      expired: sql<number>`count(*) filter (where ${commentWatches.state} = 'expired')::int`,
      goingQuiet: sql<number>`count(*) filter (where ${commentWatches.state} = 'active' and ${commentWatches.quietChecks} >= ${WATCH_QUIET_THRESHOLD})::int`,
    })
    .from(commentWatches);
  return {
    active: w?.active ?? 0,
    dueNow: w?.dueNow ?? 0,
    nextCheckAt: w?.nextCheckAt ?? null,
    expiringWithin24h: w?.expiringWithin24h ?? 0,
    expired: w?.expired ?? 0,
    goingQuiet: w?.goingQuiet ?? 0,
  };
}

export type CampaignWatchStats = {
  active: number;
  expired: number;
  /** Total replies / reactions the monitor has seen on this campaign's watched comments. */
  repliesSeen: number;
  reactionsSeen: number;
};

/** Per-campaign engagement-monitoring coverage, for `get_campaign` and
 *  the dashboard. Counts watches on this campaign's posted comments. */
export async function campaignWatchStats(
  tx: Tx,
  campaignId: number,
): Promise<CampaignWatchStats> {
  const [w] = await tx
    .select({
      active: sql<number>`count(*) filter (where ${commentWatches.state} = 'active')::int`,
      expired: sql<number>`count(*) filter (where ${commentWatches.state} = 'expired')::int`,
      repliesSeen: sql<number>`coalesce(sum(${commentWatches.lastReplyCount}), 0)::int`,
      reactionsSeen: sql<number>`coalesce(sum(${commentWatches.lastReactionCount}), 0)::int`,
    })
    .from(commentWatches)
    .where(eq(commentWatches.campaignId, campaignId));
  return {
    active: w?.active ?? 0,
    expired: w?.expired ?? 0,
    repliesSeen: w?.repliesSeen ?? 0,
    reactionsSeen: w?.reactionsSeen ?? 0,
  };
}

export type OpsMetrics = {
  pendingApprovals: number;
  postedLast24h: number;
  engagementLast24h: number;
  /** Replies awaiting action on threads WE started (source='our_comment_thread',
   *  status='new') — someone answered our comment on their post. */
  newThreadReplies: number;
  /** Engagement received in the last 7 days, by type (reply_received /
   *  like_received) — the real success metric, fed by the engagement monitor. */
  engagement7d: { type: string; n: number }[];
  killSwitch: boolean;
  pausedReason: string | null;
  pausedUntil: number | null;
  /** When the background scheduler last enqueued this org's periodic work (the
   *  poll_incoming job is enqueued unconditionally every 5-min slot, so its
   *  newest row is a tick fingerprint). null = never ticked (unprovisioned env). */
  lastSchedulerTickAt: number | null;
  /** True when the scheduler hasn't ticked for >30 min (or never): discovery,
   *  polling and engagement monitoring are NOT running. */
  schedulerStale: boolean;
  /** Engagement-monitor watch loop health (comment_watches). */
  watches: WatchMetrics;
  byStatus: { status: string; n: number }[];
  recentLedger: {
    id: number;
    ts: number;
    action: string;
    targetProfileId: string | null;
  }[];
};

export async function opsMetrics(tx: Tx): Promise<OpsMetrics> {
  const now = Date.now();

  const [pending] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(messages)
    .where(eq(messages.status, "proposed"));

  const [posted] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(rateLimitLedger)
    .where(
      and(
        inArray(rateLimitLedger.action, ["comment", "reply"]),
        gte(rateLimitLedger.ts, now - DAY),
      ),
    );

  const [engagement] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(engagementEvents)
    .where(gte(engagementEvents.ts, now - DAY));

  const [threadReplies] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(incomingComments)
    .where(
      and(
        eq(incomingComments.source, "our_comment_thread"),
        eq(incomingComments.status, "new"),
      ),
    );

  const engagement7d = await tx
    .select({ type: engagementEvents.type, n: sql<number>`count(*)::int` })
    .from(engagementEvents)
    .where(gte(engagementEvents.ts, now - 7 * DAY))
    .groupBy(engagementEvents.type);

  const byStatus = await tx
    .select({ status: messages.status, n: sql<number>`count(*)::int` })
    .from(messages)
    .groupBy(messages.status);

  // Through the seam, not a raw `system_state` select: the kill switch is the
  // org's, the risk pause is the account's, and `getSystemState` is the one
  // place that knows which row each comes from. Response shape is unchanged.
  const s = await getSystemState(tx);

  // `jobs` is NOT RLS-scoped (the worker claims cross-org), so filter by the org
  // GUC explicitly. poll_incoming is enqueued for every org on every 5-min slot,
  // which makes its newest row a reliable scheduler-tick fingerprint.
  const [tick] = await tx
    // ::float8 — pg returns bigint aggregates as strings; ms timestamps fit
    // float8 exactly (same convention as aiUsageStats).
    .select({ at: sql<number | null>`max(${jobs.createdAt})::float8` })
    .from(jobs)
    .where(
      and(
        sql`${jobs.organizationId} = nullif(current_setting('app.current_org', true), '')::uuid`,
        sql`${jobs.idempotencyKey} like 'poll\\_incoming:%'`,
      ),
    );
  const lastSchedulerTickAt = tick?.at ?? null;

  const recentLedger = await tx
    .select({
      id: rateLimitLedger.id,
      ts: rateLimitLedger.ts,
      action: rateLimitLedger.action,
      targetProfileId: rateLimitLedger.targetProfileId,
    })
    .from(rateLimitLedger)
    .where(completedLedgerActionPredicate())
    .orderBy(desc(rateLimitLedger.ts))
    .limit(20);

  const watches = await watchMetrics(tx, now);

  return {
    pendingApprovals: pending?.n ?? 0,
    postedLast24h: posted?.n ?? 0,
    engagementLast24h: engagement?.n ?? 0,
    newThreadReplies: threadReplies?.n ?? 0,
    engagement7d,
    killSwitch: s?.killSwitch ?? false,
    pausedReason: s?.pausedReason ?? null,
    pausedUntil: s?.pausedUntil ?? null,
    lastSchedulerTickAt,
    schedulerStale:
      lastSchedulerTickAt === null ||
      now - lastSchedulerTickAt > SCHEDULER_STALE_MS,
    watches,
    byStatus,
    recentLedger,
  };
}

export type BriefStats = {
  activeCampaigns: number;
  /** active campaigns with a usable compiled brief (present, not coldStart). */
  withLiveBrief: number;
  /** active campaigns whose brief cold-started (nothing to frame / compile failed). */
  coldStart: number;
  /** active campaigns not yet compiled (compiledBrief null). */
  uncompiled: number;
  /** engagement received on brief-driven messages vs flat-retrieval messages (E1). */
  briefDrivenEngagement: number;
  flatEngagement: number;
};

/**
 * Compiled-brief coverage across active campaigns + engagement attribution by
 * brief provenance (E1). RLS-scoped to the current org. Engagement attribution
 * stays at 0 until the driver's outcome polling is enabled, but the link is
 * recorded on every posted message now.
 */
export async function briefStats(tx: Tx): Promise<BriefStats> {
  const actives = await tx
    .select({ compiledBrief: campaigns.compiledBrief })
    .from(campaigns)
    .where(eq(campaigns.status, "active"));
  let withLiveBrief = 0;
  let coldStart = 0;
  let uncompiled = 0;
  for (const c of actives) {
    if (!c.compiledBrief) uncompiled++;
    else if (c.compiledBrief.coldStart) coldStart++;
    else withLiveBrief++;
  }

  const [attr] = await tx
    .select({
      brief: sql<number>`count(*) filter (where ${messages.briefSourceHash} is not null)::int`,
      flat: sql<number>`count(*) filter (where ${messages.briefSourceHash} is null)::int`,
    })
    .from(engagementEvents)
    .innerJoin(messages, eq(engagementEvents.messageId, messages.id));

  return {
    activeCampaigns: actives.length,
    withLiveBrief,
    coldStart,
    uncompiled,
    briefDrivenEngagement: attr?.brief ?? 0,
    flatEngagement: attr?.flat ?? 0,
  };
}

export type AiCostRow = {
  stage: string;
  calls: number;
  tokens: number;
  costUsd: number;
};
export type AiUsageStats = {
  /** Token telemetry leads this rollup. Cost is an API-price estimate for the
   * MCP reader; the authoritative cloud allowance is read separately below. */
  totalTokens: number;
  last24hTokens: number;
  totalCostUsd: number;
  totalCalls: number;
  last24hCostUsd: number;
  /** cost of the compile_brief stage specifically (this feature's own spend). */
  compileBriefCostUsd: number;
  /** top stages by tokens (descending), for the breakdown table. */
  byStage: AiCostRow[];
};

/**
 * Per-org AI spend from `ai_usage`. NOTE: `ai_usage` is NOT RLS-protected (it is
 * flushed on the base pool after the handler tx — see withUsageContext), so it is
 * filtered by `organization_id` EXPLICITLY here, not via the GUC. Cost is stored in
 * micro-USD; we divide to USD in JS off a float8 sum.
 */
export async function aiUsageStats(
  tx: Tx,
  organizationId: string,
): Promise<AiUsageStats> {
  const now = Date.now();
  const rows = await tx
    .select({
      stage: sql<string>`coalesce(${aiUsage.stage}, '(none)')`,
      calls: sql<number>`count(*)::int`,
      // float8 (not ::int): sum(int4)->bigint, and casting that bigint back to int4
      // throws "integer out of range" once a stage's all-time tokens exceed ~2.1B.
      // float8 holds integer token counts exactly well past any realistic total.
      tokens: sql<number>`coalesce(sum(${aiUsage.totalTokens}), 0)::float8`,
      costMicros: sql<number>`coalesce(sum(${aiUsage.costUsdMicros}), 0)::float8`,
    })
    .from(aiUsage)
    .where(eq(aiUsage.organizationId, organizationId))
    .groupBy(sql`coalesce(${aiUsage.stage}, '(none)')`);

  const [recent] = await tx
    .select({
      tokens: sql<number>`coalesce(sum(${aiUsage.totalTokens}), 0)::float8`,
      costMicros: sql<number>`coalesce(sum(${aiUsage.costUsdMicros}), 0)::float8`,
    })
    .from(aiUsage)
    .where(
      and(
        eq(aiUsage.organizationId, organizationId),
        gte(aiUsage.createdAt, now - DAY),
      ),
    );

  const byStage: AiCostRow[] = rows
    .map((r) => ({
      stage: r.stage,
      calls: r.calls,
      tokens: r.tokens,
      costUsd: r.costMicros / 1e6,
    }))
    .sort((a, b) => b.tokens - a.tokens);

  return {
    totalTokens: byStage.reduce((s, r) => s + r.tokens, 0),
    last24hTokens: recent?.tokens ?? 0,
    totalCostUsd: byStage.reduce((s, r) => s + r.costUsd, 0),
    totalCalls: byStage.reduce((s, r) => s + r.calls, 0),
    last24hCostUsd: (recent?.costMicros ?? 0) / 1e6,
    compileBriefCostUsd:
      byStage.find((r) => r.stage === "compile_brief")?.costUsd ?? 0,
    byStage,
  };
}

export type LearningStats = {
  good: number;
  bad: number;
  approve: number;
  edit: number;
  reject: number;
  acceptanceRate: number | null;
  /** Client-led recalibration flag for the ORG DEFAULT voice: when `due`, the
   *  agent should run the voice learning loop. */
  voiceCalibration: {
    due: boolean;
    newEligibleSamples: number;
    lastCalibratedAt: number | null;
  };
  /** Org-level learning signals: calibration cycles and the measurement
   *  counts, with the measurement families under telemetry. */
  learningSignals: LearningSignals;
};

export async function learningStats(
  tx: Tx,
  organizationId: string,
): Promise<LearningStats> {
  const ex = await tx
    .select({ label: exemplars.label, n: sql<number>`count(*)::int` })
    .from(exemplars)
    .groupBy(exemplars.label);
  const fb = await tx
    .select({ verdict: feedback.verdict, n: sql<number>`count(*)::int` })
    .from(feedback)
    .groupBy(feedback.verdict);
  const recalibration = await pendingRecalibration(tx);
  const learningSignals = await computeLearningSignals(tx, organizationId);

  const approve = fb.find((r) => r.verdict === "approve")?.n ?? 0;
  const edit = fb.find((r) => r.verdict === "edit")?.n ?? 0;
  const reject = fb.find((r) => r.verdict === "reject")?.n ?? 0;
  const total = approve + edit + reject;
  return {
    good: ex.find((r) => r.label === "good")?.n ?? 0,
    bad: ex.find((r) => r.label === "bad")?.n ?? 0,
    approve,
    edit,
    reject,
    acceptanceRate: total > 0 ? approve / total : null,
    voiceCalibration: {
      due: recalibration.dueForClient,
      newEligibleSamples: recalibration.newEligibleSamples,
      lastCalibratedAt: recalibration.lastCalibratedAt,
    },
    learningSignals,
  };
}
