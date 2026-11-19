import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import {
  ACTION_KINDS,
  campaigns,
  channels,
  engagedProfiles,
  organizations,
  profileIdKey,
  rateLimitLedger,
  type ActionKind,
  type Campaign,
  type Channel,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { backgroundEntitlement, runtimeEntitlement } from "../entitlements/entitlement";
import { scopedStop } from "../actions/stops";
import { readExecutionAuthority } from "../execution/authority";
import { envInt } from "../config";
import { excludedRoomKeys } from "../rooms/retention";
import { memberProfilesSql, resolvePersonKeys } from "../people/directory";
import { personKey } from "../people/key";
import { DEFAULT_NETWORK } from "../network/registry";
import { REPLY_CHECK_MINUTES } from "../pacing";
import { getSystemState } from "./killswitch";
import { trackCapReached } from "../telemetry/emit";
import { driftPastOpen, withinActiveWindow, workDay } from "../time";
import {
  completedWarmupAt,
  isSupportedPublicCampaignRuntime,
} from "../operations/campaigns";

export type EngageAction =
  | "comment"
  | "reply"
  | "room_reply"
  | "like"
  | "discover"
  | "poll"
  | "profile"
  | ResearchRead
  | typeof REPLY_CHECK
  | ActionKind;

/** The kinds the action ledger carries (`actions`), whose ledger row
 *  only the dispatch gate mints (INV-13). */
export function isLedgerAction(action: EngageAction): action is ActionKind {
  return (ACTION_KINDS as readonly string[]).includes(action);
}

/** What verifying a match spends: the post read in full with its comments, or
 *  its author's profile. */
export type ResearchRead = "thread_read" | "profile_read";

/** What a look for what someone wrote back spends — under one of our own
 *  comments, or in the inbox: a read on the account's own reply-check budget,
 *  never a Research read. */
export const REPLY_CHECK = "reply_check";

export type EngageDecision =
  | { ok: true }
  | {
      ok: false;
      reason: string;
      retryAt?: number;
      permanent?: boolean;
      /** The refusal in the owner's words, where `reason` alone does not say it. */
      detail?: string;
    };

const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

/** Rows that represent a completed external action. The action ledger's
 * receipt (`execution/actionGate.ts`) is reserved before provider I/O and
 * counts only once `confirmed`. The like receipts of before every like was an
 * action (`*_like_receipt`) count only in their `succeeded` state, and
 * ordinary historical rows have no receipt kind and remain visible. */
export function completedLedgerActionPredicate() {
  return sql<boolean>`(
    coalesce(${rateLimitLedger.meta} ->> 'kind', '') not in (
      'standalone_like_receipt',
      'dismissal_like_receipt',
      'followup_like_receipt',
      'action_execution_receipt'
    )
    or ${rateLimitLedger.meta} ->> 'state' = 'succeeded'
    or (
      ${rateLimitLedger.meta} ->> 'kind' = 'action_execution_receipt'
      and ${rateLimitLedger.meta} ->> 'state' = 'confirmed'
    )
  )`;
}

/** Linear warm-up ramp from 0.25 → 1.0 over `warmupWeeks` since start.
 *  REPLY-lane + display ratio only — the comment lane's cap comes from
 *  `effectiveDailyCommentCap`, which honors the absolute `warmupStartRate`. */
export function warmupFactor(channel: Channel, now: number): number {
  if (!channel.warmupStartedAt || channel.warmupWeeks <= 0) return 1;
  const elapsedWeeks = (now - channel.warmupStartedAt) / WEEK;
  const frac = elapsedWeeks / channel.warmupWeeks;
  return Math.min(1, Math.max(0.25, 0.25 + 0.75 * frac));
}

export type WarmupCapFields = Pick<
  Channel,
  "dailyCommentCap" | "warmupWeeks" | "warmupStartedAt" | "warmupStartRate"
>;

/** The three warm-up columns, as the ramp math wants them. */
export type WarmupClock = Pick<
  Channel,
  "warmupWeeks" | "warmupStartedAt" | "warmupStartRate"
>;

/**
 * The ACCOUNT's warm-up clock, read off the channel row.
 *
 * Every ramp reader keeps its signature and keeps reading these fields off the
 * object it is handed; the call sites hydrate that object first —
 * `{ ...campaign, ...clock }`. That is what makes the move a repoint rather
 * than a rewrite of `warmupFactor` / `effectiveDailyCommentCap` /
 * `pacingPolicy` / `completedWarmupAt`, and it keeps every cap numerically
 * identical for the single-campaign case.
 *
 * Falls back to the campaign-row defaults when no channel row answers, for the
 * same reason `ledgerChannelId` falls back rather than writing NULL: an absent
 * clock must read as "no ramp running", never as a ramp with a null anchor that
 * silently uncaps.
 */
export async function channelWarmupClock(tx: Tx): Promise<WarmupClock> {
  const [row] = await tx
    .select({
      warmupWeeks: channels.warmupWeeks,
      warmupStartedAt: channels.warmupStartedAt,
      warmupStartRate: channels.warmupStartRate,
    })
    .from(channels)
    .where(eq(channels.network, DEFAULT_NETWORK))
    .orderBy(asc(channels.id))
    .limit(1);
  return {
    warmupWeeks: row?.warmupWeeks ?? 3,
    warmupStartedAt: row?.warmupStartedAt ?? null,
    warmupStartRate: row?.warmupStartRate ?? null,
  };
}

/**
 * Warm-up-adjusted daily COMMENT cap — the single source every comment-lane
 * consumer (canEngage, slot plan, work order, projections, budgets) must read,
 * or the runner's demand drifts from what the server will actually schedule.
 *
 * Ramps linearly from `start` to `dailyCommentCap` over `warmupWeeks`, where
 * `start` is the absolute `warmupStartRate` (comments/day the account already
 * sustains) or 25% of the cap when null — the null form reproduces the legacy
 * `floor(cap × (0.25 + 0.75×frac))` exactly, so existing campaigns are
 * unaffected. `warmupStartRate >= cap` yields a flat ramp ("already warmed
 * up"); Auto-post eligibility (completedWarmupAt) stays time-based regardless.
 */
export function effectiveDailyCommentCap(
  c: WarmupCapFields,
  now: number,
): number {
  const cap = c.dailyCommentCap;
  if (!c.warmupStartedAt || c.warmupWeeks <= 0) return Math.max(1, Math.floor(cap));
  const frac = Math.min(
    1,
    Math.max(0, (now - c.warmupStartedAt) / (c.warmupWeeks * WEEK)),
  );
  const start = Math.min(cap, c.warmupStartRate ?? cap * 0.25);
  return Math.max(1, Math.min(cap, Math.floor(start + (cap - start) * frac)));
}

/** WHO authorized a send — `messages.publishOrigin`. Unattended work is paced;
 *  a human act is only spaced. */
export type SendOrigin = "owner" | "worker";

/**
 * A like has no message row to read `publishOrigin` from, so its call site
 * states the origin directly.
 *
 * `OWNER_ACT` is for a like the owner pressed themselves — liking while
 * dismissing a reply in the app, or the owner's own Like on a person — which
 * takes spacing only, the rule the owner's comments follow. A like Engager
 * decides on its own (an agent's dismissal, the owner’s like action) passes
 * `worker` and is bound by the campaign's Like mode and the account's
 * like ceiling as well.
 *
 * A like that accompanies unattended publishing is not one of these sites; it
 * rides the comment's own provenance through the comment action (`actions/comment.ts`).
 */
export const OWNER_ACT: SendOrigin = "owner";

export type PacingPolicy = {
  /** True = a human act stands behind this send, so only spacing binds. */
  manual: boolean;
  /** 0 = uncapped (the planner's `Gates.dailyCap` contract). */
  commentDailyCap: number;
  /** 0 = uncapped. */
  replyDailyCap: number;
  /** null = 24/7 (the `withinActiveWindow`/`dayWindows` contract). */
  activeHours: Channel["activeHours"];
  activeDays: Channel["activeDays"];
  channelDailyCapApplies: boolean;
  /** false = no human-day session rhythm; items chain at min-gap. */
  useDayPlanAnchors: boolean;
};

/**
 * The single decision point for which volume controls bind a send:
 *
 *   **Caps bind unattended work. A human act needs only spacing.**
 *
 * When the owner WROTE it, the only pacing is the min-gap floor plus the
 * per-profile anti-repeat caps. Daily caps, the active-hours window,
 * the org daily ceiling, and the human-day anchors are engine machinery for
 * work that runs with nobody in the loop.
 *
 * That is what the retired Curate mode was really expressing (founder decision
 * 2026-07-29). Provenance is the sole input to WHETHER caps bind; the channel
 * is the sole source of WHAT they are. No campaign field participates in
 * either half.
 *
 * "Owner" means AUTHORSHIP, not approval — a deck save or an owner rewrite,
 * the same act that earns the text a voice sample. A bare approval of an agent
 * draft leaves the row `worker` and fully capped, because approving fifty
 * drafts in a minute is not fifty human acts.
 *
 * Min-gap and the account's min-action gap are NOT part of this policy — they
 * apply everywhere, unconditionally.
 */
export function pacingPolicy(
  channel: Channel,
  origin: SendOrigin,
  now: number,
): PacingPolicy {
  if (origin === "owner") {
    return {
      manual: true,
      commentDailyCap: 0,
      replyDailyCap: 0,
      activeHours: null,
      activeDays: null,
      channelDailyCapApplies: false,
      useDayPlanAnchors: false,
    };
  }
  return {
    manual: false,
    commentDailyCap: effectiveDailyCommentCap(channel, now),
    replyDailyCap: Math.max(
      1,
      Math.floor(channel.dailyReplyCap * warmupFactor(channel, now)),
    ),
    activeHours: channel.activeHours,
    activeDays: channel.activeDays,
    channelDailyCapApplies: true,
    useDayPlanAnchors: true,
  };
}

/**
 * The campaign's effective DAILY comment budget (warm-up-adjusted) + how many
 * comments it has already posted today. Gate 1 (draft
 * admission) reads this to decide how many DRAFTS to admit — it over-provisions the
 * remaining budget (the posting ledger ≠ the draft budget; the OVERPROVISION
 * multiplier absorbs the slack). Runs in the short post-filter tx (SELF_SCOPED).
 *
 * `dailyBudget` mirrors `canEngage`: `effectiveDailyCommentCap`. `remaining` is
 * the post-budget headroom (>= 0). On any query error the caller fails OPEN.
 */
export async function remainingCommentBudget(opts: {
  db: Tx;
  channel: Channel;
  now?: number;
}): Promise<{ dailyBudget: number; postedToday: number; remaining: number }> {
  const tx = opts.db;
  const now = opts.now ?? Date.now();
  const dailyBudget = effectiveDailyCommentCap(opts.channel, now);
  // ONE ledger day, the account's — budget and spend now come off the same row.
  const postedToday = await countSince(
    tx,
    { channelId: opts.channel.id },
    ["comment", "room_reply"],
    workDay(now, opts.channel.activeHours, opts.channel.activeDays).open,
    {},
  );
  return {
    dailyBudget,
    postedToday,
    remaining: Math.max(0, dailyBudget - postedToday),
  };
}

/**
 * WHOSE exposure a ledger count is measuring — the account's, or the org's
 * whole API budget. Required and positional at every call site, because RLS
 * cannot back this up: there is no `app.current_channel`, so the type system is
 * the only audit. An unmigrated four-argument call is a compile error rather
 * than a silently org-wide count.
 *
 * `{ channelId }` is posting exposure — the thing INV-4 says one connected
 * account owns. `{ orgWide: true }` is the org's read budget, which no
 * account scopes; it adds no predicate, which is exactly today's behavior, now
 * stated at the call site instead of implied by an empty filter object.
 */
export type LedgerScope = { channelId: number } | { orgWide: true };

/**
 * The account a campaign's exposure counts against. `campaigns.channel_id` is
 * non-null in practice — T-4.3's migration backfilled every existing row and
 * `createCampaignOp` stamps every new one — but the column is nullable while
 * the move is additive, so the null has to mean something here.
 *
 * It means ORG-WIDE, never `{ channelId: null }`. `eq(channel_id, NULL)` is
 * never true, so a null-scoped count returns 0 and every cap reading it stops
 * binding — the account would go uncapped exactly when its attribution is
 * broken. Org-wide counts a superset (one channel per org today, so the same
 * set), which refuses sooner rather than later. Caps fail CLOSED.
 */
export function campaignLedgerScope(
  campaign: Pick<Campaign, "channelId">,
): LedgerScope {
  return campaign.channelId != null
    ? { channelId: campaign.channelId }
    : { orgWide: true };
}

/**
 * The account to STAMP on a ledger row about to be written — the write-side
 * twin of `campaignLedgerScope`, and the reason a `{ channelId }` count keeps
 * seeing rows created after T-4.3's one-shot backfill.
 *
 * Takes whatever the call site actually holds: the campaign row (no query when
 * its `channelId` is stamped, which is every campaign `createCampaignOp` made),
 * a bare campaign id, or nothing at all. Anything unresolved falls back to the
 * org's single `channels` row rather than writing NULL — a NULL row is
 * invisible to the scope that enforces the caps, so guessing wrong on the low
 * side is the dangerous direction.
 */
export async function ledgerChannelId(
  tx: Tx,
  campaign?: Pick<Campaign, "channelId"> | number | null,
): Promise<number | null> {
  if (typeof campaign === "object" && campaign?.channelId != null)
    return campaign.channelId;
  if (typeof campaign === "number") {
    const [row] = await tx
      .select({ channelId: campaigns.channelId })
      .from(campaigns)
      .where(eq(campaigns.id, campaign));
    if (row?.channelId != null) return row.channelId;
  }
  const [channel] = await tx
    .select({ id: channels.id })
    .from(channels)
    .where(eq(channels.network, DEFAULT_NETWORK))
    .orderBy(asc(channels.id))
    .limit(1);
  return channel?.id ?? null;
}

/** Count verified aliases together without inventing a profile id for a
 * member-only recipient. Discovery erasure cannot reset confirmed exposure. */
function ledgerPersonPredicate(profileId?: string | null, memberUrn?: string | null) {
  return sql`(
    ${rateLimitLedger.targetProfileId} = ${profileId ?? null}
    or ${rateLimitLedger.targetMemberUrn} = ${memberUrn ?? null}
    or exists (select 1 from (${memberProfilesSql()}) alias
      where (alias.profile_id = ${profileId ?? null} and alias.urn = ${rateLimitLedger.targetMemberUrn})
        or (alias.urn = ${memberUrn ?? null} and alias.profile_id = ${rateLimitLedger.targetProfileId}))
  )`;
}

export async function countSince(
  tx: Tx,
  scope: LedgerScope,
  actions: EngageAction[],
  sinceTs: number,
  /**
   * NARROWING within `scope`, never a substitute for it. `campaignId` survives
   * as Scout-level attribution and reporting: `recordLedger` keeps stamping it
   * and stats keep reading it, but its only remaining ENFORCEMENT readers are
   * the two `canEngage` campaign caps and the two budget projections — and
   * those leave with the caps when T-4.5/T-4.9 move `dailyCommentCap` /
   * `dailyReplyCap` onto the channel. After that, a cap-enforcement site
   * passing `campaignId` is a bug.
   */
  filters: { campaignId?: number | null; profileId?: string | null; memberUrn?: string | null },
): Promise<number> {
  const conds = [
    inArray(rateLimitLedger.action, actions),
    gte(rateLimitLedger.ts, sinceTs),
    completedLedgerActionPredicate(),
  ];
  if ("channelId" in scope)
    conds.push(eq(rateLimitLedger.channelId, scope.channelId));
  if (filters.campaignId != null)
    conds.push(eq(rateLimitLedger.campaignId, filters.campaignId));
  if (filters.profileId || filters.memberUrn)
    conds.push(ledgerPersonPredicate(filters.profileId, filters.memberUrn));
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(rateLimitLedger)
    .where(and(...conds));
  return row?.n ?? 0;
}

async function lastActionTs(
  tx: Tx,
  actions: EngageAction[],
  campaignId: number,
): Promise<number> {
  const [row] = await tx
    .select({ m: sql<number>`coalesce(max(${rateLimitLedger.ts}), 0)::bigint` })
    .from(rateLimitLedger)
    .where(
      and(
        inArray(rateLimitLedger.action, actions),
        eq(rateLimitLedger.campaignId, campaignId),
        completedLedgerActionPredicate(),
      ),
    );
  return Number(row?.m ?? 0);
}

/** Most recent matching action across ALL campaigns (RLS scopes to the current org). */
async function lastOrgActionTs(
  tx: Tx,
  actions: EngageAction[],
): Promise<number> {
  const [row] = await tx
    .select({ m: sql<number>`coalesce(max(${rateLimitLedger.ts}), 0)::bigint` })
    .from(rateLimitLedger)
    .where(
      and(
        inArray(rateLimitLedger.action, actions),
        completedLedgerActionPredicate(),
      ),
    );
  return Number(row?.m ?? 0);
}

/**
 * The connected account's row — ceilings included. THE phase's single
 * channel-row loader: every surface that needs the channel (this file's
 * ceilings, `schedule.ts`'s pacing floor, and the day-plan seed a later task
 * threads) reads through this one function rather than issuing its own select,
 * so there is exactly one place that decides what "the org's channel" means.
 *
 * Returns the WHOLE row, id included, for that reason. `channels` is RLS-forced,
 * so a plain select inside the `withOrg` tx is already org-scoped — no explicit
 * organization predicate, unlike the `organizations` read it replaces (that
 * table sits outside RLS and had to be looked up by the GUC).
 *
 * A missing row skips the account-level checks. That is defense, not a path:
 * every org has a channel row from T-4.1a's migration seed or
 * `bootstrapLocalOrg`'s mint, both of which run before any campaign exists.
 */
export async function channelCeilings(
  tx: Tx,
): Promise<typeof channels.$inferSelect | null> {
  const [row] = await tx
    .select()
    .from(channels)
    .where(eq(channels.network, DEFAULT_NETWORK))
    .orderBy(asc(channels.id))
    .limit(1);
  return row ?? null;
}

/**
 * The account's "Check replies every", in minutes: the fresh tier every
 * comment watch's decaying cadence scales from (`watchCheckBaseMs`).
 */
export async function replyCheckBaseMin(tx: Tx): Promise<number> {
  return (await channelCeilings(tx))?.replyCheckBaseMin ?? REPLY_CHECK_MINUTES.default;
}

/**
 * The send gate's pause read, consulted by both `canEngage` and
 * `reserveReadCall`.
 *
 * Through `getSystemState`, not a raw `system_state` select: the kill switch is
 * still the org's layer-1 stop, but the risk pause is the account's and lives
 * on the `channels` row. The seam keeps both answers in one shape.
 */
async function isPaused(
  tx: Tx,
  now: number,
): Promise<{ paused: boolean; reason?: string }> {
  const s = await getSystemState(tx);
  if (!s) return { paused: false };
  if (s.killSwitch) return { paused: true, reason: "kill switch" };
  if (s.pausedUntil && s.pausedUntil > now)
    return { paused: true, reason: s.pausedReason ?? "auto-paused" };
  return { paused: false };
}

/** The owner PRESSED a send its campaign's pause holds: the one thing a pause
 *  lets through (`canEngage`'s `pressed`). */
function ridesCampaignPause(o: { campaign: Campaign | null; origin: SendOrigin; pressed?: boolean }): boolean {
  return o.pressed === true && o.origin === "owner" && o.campaign?.status === "paused";
}

/**
 * What stops a send before any budget is counted: the kill switch and the
 * risk pause, the account's write authority, a campaign archived or paused.
 * A refusal only: `canEngage` takes it first, and the points before the press
 * that cannot decide the send ask it cheaply, so none of them can admit what
 * the authoritative gate would refuse.
 */
export async function standingRefusal(tx: Tx, opts: {
  action: EngageAction; campaign: Campaign | null; channel: Channel; origin: SendOrigin; pressed?: boolean; now?: number;
}): Promise<Extract<EngageDecision, { ok: false }> | null> {
  const now = opts.now ?? Date.now();
  const { action, campaign, channel } = opts;
  const paused = await isPaused(tx, now);
  if (paused.paused) return { ok: false, reason: paused.reason ?? "paused", retryAt: now + 30 * 60_000 };
  if (action === "discover" || action === "poll") return null;

  // The account's write authority — the DB flag that retired
  // ENGAGER_BROWSER_WRITES. Authoritative HERE, per write, so every process
  // sees a flip on its next gate check (the driver's construction gate can
  // hold a stale answer for the life of its memo). Origin-blind on purpose:
  // authority is the account's, not the send's — the driver refused owner
  // sends without it too. A hold, not a verdict: 15 minutes mirrors the
  // connector backoff pause, and the message replans instead of failing.
  if (!channel.writesEnabled) return { ok: false, reason: "writes_off", retryAt: now + 15 * 60_000 };

  if (campaign?.status === "archived") return { ok: false, reason: "campaign_archived", permanent: true };
  // PAUSE ONLY STOPS NEW RUNS (founder rule, 2026-10-15): it holds what a
  // campaign's workers, and an agent's own calls, would send on their own, and
  // never an owner's press, which the campaign's Stop sending, the account's
  // Stop and the kill switch below and above still hold.
  if (campaign && campaign.status !== "active" && !ridesCampaignPause({ ...opts, campaign })) {
    return { ok: false, reason: "campaign_paused", retryAt: now + 30 * 60_000 };
  }
  return null;
}

/**
 * The single gate every quota-consuming action passes through. Runs inside the
 * org-scoped `withOrg` transaction (RLS scopes the ledger / system_state /
 * engaged_profiles to the current org), so there is no organizationId parameter.
 */
export async function canEngage(opts: {
  action: EngageAction;
  /** Target status and `maxPostAgeDays` only — every pacing and spacing number
   *  this gate reads now comes off `channel`. Null only for an owner's own
   *  act on the action ledger that rides no campaign (an invite or an
   *  acceptance pressed on someone no campaign touched): the account's gate
   *  without a campaign's — its status and its Stop. Anything else with no
   *  campaign is refused. */
  campaign: Campaign | null;
  /**
   * The connected account whose caps, window and spacing bind this send.
   *
   * REQUIRED for the same reason `origin` is: it decides what actually caps a
   * real send, so every call site states it rather than inheriting a default.
   */
  channel: Channel;
  profileId?: string | null;
  memberUrn?: string | null;
  /** This action answers someone who engaged US first (they commented on our
   *  post / replied to our comment). Skips ONLY the per-profile caps — those
   *  exist to stop repeated cold touches on a stranger, and a person in live
   *  conversation with us isn't being spammed; blocking the answer reads as
   *  ghosting. Runaway thread ping-pong is guarded by the thread depth cap in
   *  the reply action instead (`actions/reply.ts`). Daily/org caps and the min-gap floor stay hard. */
  responsive?: boolean;
  /**
   * `messages.publishOrigin` — who authorized this send. Decides whether the
   * daily caps, the active window, the org ceiling, and the day-plan anchors
   * bind (see `pacingPolicy`).
   *
   * REQUIRED on purpose: this is the input that decides whether a real send is
   * capped, so every call site must state it rather than inherit a default
   * that silently keeps old behavior. Callers holding a message row pass
   * `msg.publishOrigin`; callers acting outside a message (likes) pass
   * `OWNER_ACT` only when a human pressed the button.
   */
  origin: SendOrigin;
  /**
   * The owner PRESSED this themselves — a button on the dashboard, or their own
   * words going out — which is the one thing a paused campaign lets through
   * (`ridesPause`). Not implied by `origin`: an owner-authored send that is not a
   * press (a scheduled owner comment) is only spaced, yet Pause still holds
   * it. Set only by the owner-press paths.
   */
  pressed?: boolean;
  now?: number;
  db: Tx;
}): Promise<EngageDecision> {
  const tx = opts.db;
  const now = opts.now ?? Date.now();
  const { action, campaign, channel, origin, pressed } = opts;
  const memberKey = personKey({ memberUrn: opts.memberUrn });
  const canonical = memberKey ? (await resolvePersonKeys(tx, [memberKey])).get(memberKey) : undefined;
  const profileId = opts.profileId ?? (canonical?.startsWith("p.") ? canonical.slice(2) : null);

  // The kill switch and the account's Stop bind a campaign-less act as any;
  // what it skips is only what is a campaign's to say. An unattended act with
  // no campaign has lost the campaign that proposed it.
  if (campaign === null && !(origin === "owner" && isLedgerAction(action))) {
    return { ok: false, reason: "campaign_gone", permanent: true };
  }

  const isWrite = isLedgerAction(action) || action === "like";
  const entitlement = await (origin === "worker" && isWrite ? backgroundEntitlement : runtimeEntitlement)(tx, channel.organizationId, {
    lock: true,
  });
  if (!entitlement.allowed) {
    return {
      ok: false,
      reason: entitlement.reason,
      retryAt: now + 6 * 60 * 60_000,
    };
  }

  const standing = await standingRefusal(tx, { action, campaign, channel, origin, pressed, now });
  if (standing) return standing;

  // Discovery + polling are read-side and run 24/7: gated on kill-switch + their own
  // hourly reservation cap (reserveDiscoverCall / reservePollCall), NOT active-hours
  // or the posting caps below. Checked here BEFORE the active-hours gate so a
  // background sweep can pre-fill the funnel overnight. Only comment/reply/like
  // respect active hours.
  if (action === "discover" || action === "poll") return { ok: true };

  const ridesPause = ridesCampaignPause({ campaign, origin, pressed });
  // No refusal here for a second active campaign: the budget is the CHANNEL's,
  // so N campaigns share one account's exposure instead of multiplying it.
  // Single-target was a POLICY the operations layer held, and T-8.11 lifted it:
  // several targets are an ordinary account now.
  //
  // WHICH MAKES `channel_min_gap` LOAD-BEARING, and it is examined rather than
  // inherited. The per-lane min-gap floor below reads THIS campaign's last
  // send, so two active campaigns carry independent lane floors; the channel gap
  // (lane-blind, and off when `minActionGapSec` is 0) is therefore the whole of
  // what spaces one campaign's send against another's. That is enough, because
  // the thing it is protecting is not the lane — it is the ACCOUNT, and the
  // account's volume is bounded a level up by a day plan whose anchors are
  // seeded per channel. Two targets consume one sequence of anchors rather than
  // two overlapping ones, so what the gap has to prevent is a burst inside one
  // anchor, not two independent streams.
  //
  // No warm-up PRECONDITION here any more. Warm-up survives as what it always
  // physically was — a ramp on the daily cap (`effectiveDailyCommentCap`, read
  // by `pacingPolicy` below) — rather than a fence that refuses sends outright.
  // The owner decides when to automate; the ramp decides how much.
  if (campaign && !ridesPause && !isSupportedPublicCampaignRuntime(campaign)) {
    return {
      ok: false,
      reason: "unsupported_public_campaign_flow",
      permanent: true,
    };
  }

  if (profileId) {
    const [p] = await tx
      .select({ block: engagedProfiles.doNotEngage })
      .from(engagedProfiles)
      .where(eq(engagedProfiles.profileId, profileId));
    if (p?.block || (await excludedRoomKeys(tx)).has(`p.${profileIdKey(profileId)}`))
      return { ok: false, reason: "do_not_engage", permanent: true };
  }
  if (memberKey && (await excludedRoomKeys(tx)).has(memberKey)) {
    return { ok: false, reason: "do_not_engage", permanent: true };
  }

  // A durable Stop on the account, the campaign or the conversation with this
  // person (INV-29) holds every send until the owner resumes it — a hold, not
  // a verdict, like the campaign's own pause above; the Stop itself put the
  // scope's queued unattended sends back to drafts (`actions/pause.ts`). A
  // read is monitoring, which a Stop lets continue.
  if (action !== "profile" && action !== "thread_read" && action !== "profile_read") {
    const stopped = await scopedStop(tx, {
      channelId: channel.id,
      campaignId: campaign?.id ?? null,
      profileId,
      origin,
    });
    if (stopped) return { ok: false, reason: stopped, retryAt: now + 30 * 60_000 };
  }

  // Which volume controls bind is the SEND's call (pacingPolicy): an
  // owner-authored send is only spaced — min-gap floors, per-profile caps, and
  // the org min-action gap below — while unattended work also takes the daily
  // caps, the active window, and the org ceiling.
  //
  // Placement/account fences bind every dispatch, including owner authorship.
  // Pacing exemptions below remain independent of execution authority.
  const authority = await readExecutionAuthority(tx, channel.id);
  if (!authority.allowed) {
    return {
      ok: false,
      reason: authority.reason,
      retryAt: now + 30 * 60_000,
    };
  }
  const policy = pacingPolicy(channel, origin, now);
  // Every exposure count below is this ACCOUNT's.
  const scope: LedgerScope = { channelId: channel.id };

  const win = withinActiveWindow(now, policy.activeHours, policy.activeDays);
  if (!win.within)
    return { ok: false, reason: "outside_active_hours", retryAt: driftPastOpen(win.nextOpen) };

  // Post freshness is NOT decided here. `maxPostAgeDays` binds at triage
  // intake (`submitCandidateRanking`) and draft selection, where a stale post
  // is refused before anyone writes a comment for it. The gate answers one
  // question — does this account have exposure budget for one more action —
  // so it never reads campaign targeting.

  // The two daily caps count the ACCOUNT's day, not this campaign's: the day of
  // its hours the day plan spends (`workDay`), so a late start's make-up never
  // carries into the next window. One ledger day binds whichever campaign
  // spends it — otherwise N campaigns multiply the same budget, which is the
  // exposure INV-4 exists to bound.
  const dayOpen = workDay(now, channel.activeHours, channel.activeDays).open;
  if ((action === "comment" || action === "room_reply") && policy.commentDailyCap > 0) {
    const n = await countSince(tx, scope, ["comment", "room_reply"], dayOpen, {});
    if (n >= policy.commentDailyCap) {
      trackCapReached({ kind: "comment", scope: "campaign" }, tx);
      return {
        ok: false,
        reason: "campaign_daily_comment_cap",
        retryAt: now + 60 * 60_000,
      };
    }
  } else if (action === "reply" && policy.replyDailyCap > 0) {
    const n = await countSince(tx, scope, ["reply"], dayOpen, {});
    if (n >= policy.replyDailyCap) {
      trackCapReached({ kind: "reply", scope: "campaign" }, tx);
      return {
        ok: false,
        reason: "campaign_daily_reply_cap",
        retryAt: now + 60 * 60_000,
      };
    }
  }

  if (
    (action === "comment" || action === "reply" || action === "room_reply") &&
    (profileId || memberKey) &&
    (action === "room_reply" || !opts.responsive)
  ) {
    const refusal = await perProfileCapRefusal(tx, channel, profileId, now, opts.memberUrn);
    if (refusal) return refusal;
  }

  if (campaign && (action === "comment" || action === "reply" || action === "room_reply")) {
    const last = await lastActionTs(tx, action === "reply" ? ["reply"] : ["comment", "room_reply"], campaign.id);
    if (last > 0) {
      // Rhythm lives in the slot plan (assignSlots), not here — the gate only holds
      // the floor: never two sends of a lane within THIS CAMPAIGN's min delay
      // (clamped to 30s so a misconfigured 0 can't machine-gun the account).
      // The delay is the channel's, the last-send read is not; see the note at
      // the single-target deletion above for what that leaves unspaced.
      const minGap = Math.max(channel.minDelaySec, 30) * 1000;
      if (now - last < minGap)
        return { ok: false, reason: "min_gap", retryAt: last + minGap };
    }
  }

  // Account-level ceilings, ACROSS campaigns: the campaign caps above bound each
  // campaign in isolation, but N campaigns share ONE LinkedIn account — without an
  // account-wide gate they multiply its daily exposure (the ban vector).
  // Absolute (no warm-up scaling): warm-up shapes each campaign's ramp, the
  // account cap is the hard ceiling. Configurable in Settings; 0 disables.
  //
  // INV-1 is untouched by the move: the count stays provenance-blind and the
  // REFUSAL stays behind `PacingPolicy.channelDailyCapApplies`, so an
  // owner-authored send still consumes the budget and is never refused by it.
  if (action === "comment" || action === "reply" || action === "room_reply") {
    if (policy.channelDailyCapApplies && channel.dailyEngageCap > 0) {
      const n = await countSince(tx, scope, ["comment", "reply", "room_reply"], dayOpen, {});
      if (n >= channel.dailyEngageCap) {
        trackCapReached({ kind: action, scope: "account" }, tx);
        return {
          ok: false,
          reason: "channel_daily_cap",
          retryAt: now + 60 * 60_000,
        };
      }
    }
    // The min-action gap is spacing, not volume — it applies to every send,
    // owner-authored ones included.
    if (channel.minActionGapSec > 0) {
      const last = await lastOrgActionTs(tx, ["comment", "reply", "room_reply"]);
      const gap = channel.minActionGapSec * 1000;
      if (last > 0 && now - last < gap)
        return { ok: false, reason: "channel_min_gap", retryAt: last + gap };
    }
  }

  // The action ledger's kinds take every fence above — and the window when
  // they are unattended, which `pacingPolicy` decided from `origin` exactly as
  // it does from a message's `publishOrigin` — then the account's min-action
  // gap against every write it spaces. Their rolling-24h ceiling is the
  // account-default strategy's, which the dispatch gate reads beside this
  // call (`execution/actionGate.ts`); this gate stays strategy-blind.
  if (isLedgerAction(action) && channel.minActionGapSec > 0) {
    const last = await lastOrgActionTs(tx, ["comment", "reply", "room_reply", ...ACTION_KINDS]);
    const gap = channel.minActionGapSec * 1000;
    if (last > 0 && now - last < gap)
      return { ok: false, reason: "channel_min_gap", retryAt: last + gap };
  }

  return { ok: true };
}

/** The windows the per-person caps count in, in the order the gate reads
 *  them. */
export const PER_PROFILE_WINDOWS = [
  ["day", DAY],
  ["week", WEEK],
  ["month", MONTH],
] as const;
export type PerProfileCap = (typeof PER_PROFILE_WINDOWS)[number][0];

export type PerProfileChannel = Pick<
  Channel,
  "id" | "perProfileDayCap" | "perProfileWeekCap" | "perProfileMonthCap"
>;

/**
 * How often this account touched one person — its comments and replies to
 * them — in each window the per-person caps count, against those caps, and
 * when the caps let it touch them again: the moment enough counted touches
 * have aged out of every window that refuses them now. Null while none does.
 *
 * The counts the gate refuses on (`perProfileCapRefusal` reads them here), so
 * a person shown as resting is a person the gate refuses.
 */
export type PersonTouches = Record<PerProfileCap, number> & {
  caps: Record<PerProfileCap, number>;
  restsUntil: { cap: PerProfileCap; at: number } | null;
};

export async function personTouches(
  tx: Tx,
  input: { channelId: number; profileId: string; now: number },
): Promise<PersonTouches | null> {
  const [channel] = await tx
    .select({
      id: channels.id,
      perProfileDayCap: channels.perProfileDayCap,
      perProfileWeekCap: channels.perProfileWeekCap,
      perProfileMonthCap: channels.perProfileMonthCap,
    })
    .from(channels)
    .where(eq(channels.id, input.channelId));
  return channel ? touchesOf(tx, channel, input.profileId, input.now) : null;
}

async function touchesOf(
  tx: Tx,
  channel: PerProfileChannel,
  profileId: string | null,
  now: number,
  memberUrn?: string | null,
): Promise<PersonTouches> {
  const caps = {
    day: channel.perProfileDayCap,
    week: channel.perProfileWeekCap,
    month: channel.perProfileMonthCap,
  };
  const counts = { day: 0, week: 0, month: 0 };
  let restsUntil: PersonTouches["restsUntil"] = null;
  for (const [cap, window] of PER_PROFILE_WINDOWS) {
    counts[cap] = await countSince(
      tx,
      { channelId: channel.id },
      ["comment", "reply", "room_reply"],
      now - window,
      { profileId, memberUrn },
    );
    if (caps[cap] <= 0 || counts[cap] < caps[cap]) continue;
    // The touch whose aging out brings the count back under the cap.
    const [freeing] = await tx
      .select({ ts: rateLimitLedger.ts })
      .from(rateLimitLedger)
      .where(
        and(
          inArray(rateLimitLedger.action, ["comment", "reply", "room_reply"]),
          gte(rateLimitLedger.ts, now - window),
          completedLedgerActionPredicate(),
          eq(rateLimitLedger.channelId, channel.id),
          ledgerPersonPredicate(profileId, memberUrn),
        ),
      )
      .orderBy(asc(rateLimitLedger.ts))
      .offset(counts[cap] - caps[cap])
      .limit(1);
    const at = (freeing?.ts ?? now) + window;
    if (restsUntil === null || at > restsUntil.at) restsUntil = { cap, at };
  }
  return { ...counts, caps, restsUntil };
}

/**
 * Whether this account has already touched one person as often as its
 * per-profile caps allow — the anti-repeat half of `canEngage`, shared with
 * the verify stage, which rejects a post by such an author before reading it.
 *
 * Account-level: how often THIS account has touched this person, across every
 * campaign feeding it. No campaign filter — that is the point.
 */
export async function perProfileCapRefusal(
  tx: Tx,
  channel: PerProfileChannel,
  profileId: string | null,
  now: number,
  memberUrn?: string | null,
): Promise<Extract<EngageDecision, { ok: false }> | null> {
  const touches = await touchesOf(tx, channel, profileId, now, memberUrn);
  for (const [cap, window] of PER_PROFILE_WINDOWS) {
    if (touches.caps[cap] > 0 && touches[cap] >= touches.caps[cap])
      return { ok: false, reason: `per_profile_cap_${cap}`, retryAt: now + window };
  }
  return null;
}

/** Append one ledger row (organization_id supplied by the GUC default).
 * Normal action rows are immutable. The standalone MCP-like path reserves one
 * row before LinkedIn I/O and transitions only its receipt metadata afterward;
 * that exception prevents an unreceipted side effect and keeps retries safe. */
export async function recordLedger(
  tx: Tx,
  row: {
    action: EngageAction;
    /**
     * REQUIRED, and required because this task is what makes the column
     * load-bearing. Every row a `{ channelId }` count must see has to carry the
     * account that spent the exposure — a row left NULL after T-4.3's one-shot
     * backfill is invisible to the scope, the count comes back 0, and the
     * account's caps stop binding at the moment they become channel-scoped.
     * `null` is spelled out rather than omitted so the org-budget rows that no
     * posting scope counts are a decision at the call site, not a default.
     */
    channelId: number | null;
    campaignId?: number | null;
    targetProfileId?: string | null;
    messageId?: number | null;
    meta?: unknown;
    /** When the action happened. Omitted = now; only a row recording an
     *  action the app did not make itself (an imported comment) says
     *  otherwise, so the caps count it on the day it was spent. */
    ts?: number;
  },
): Promise<void> {
  await tx.insert(rateLimitLedger).values({
    ...(row.ts !== undefined ? { ts: row.ts } : {}),
    action: row.action,
    channelId: row.channelId,
    campaignId: row.campaignId ?? null,
    targetProfileId: row.targetProfileId ?? null,
    messageId: row.messageId ?? null,
    meta: (row.meta as object) ?? null,
  });
}

const POLL_CALLS_PER_HOUR = envInt("ENGAGER_POLL_CALLS_PER_HOUR", 120);

/**
 * Atomically reserve + record ONE provider "discovery" call against the account's
 * hourly and daily search limits. A per-org advisory xact lock serializes
 * same-org reservations so two concurrent drains (scheduled sweep + ad-hoc MCP
 * discover + cold-start burst) can't both pass at cap-1 (the count-check and the
 * insert are one critical section). Bypasses active-hours (discovery runs 24/7);
 * respects the kill-switch. Over the hourly limit → {ok:false,
 * reason:"discover_hourly_cap"} so the caller reschedules; over the daily one →
 * DAILY_SEARCH_LIMIT, with the refusal in the owner's words.
 */
export async function reserveDiscoverCall(opts: {
  db: Tx;
  campaignId?: number | null;
  now?: number;
  /** The hourly limit, for a caller that names its own instead of the account's. */
  cap?: number;
}): Promise<EngageDecision> {
  const now = opts.now ?? Date.now();
  return reserveReadCall(
    opts.db,
    "discover",
    // No org-wide count: the hourly limit is the ACCOUNT's, so both limits are
    // read together below.
    0,
    now,
    opts.campaignId ?? null,
    true,
    // Inside the same lock as the insert, so two sweeps cannot both take the
    // last search of the hour or of the day.
    // The day is asked first: spent, it holds the account longer than the
    // hour ever does, so the sweep waits for it rather than waking each hour
    // to be refused again. Either limit at 0 holds discovery for a day.
    async () => {
      const { day, hour } = await discoverBudget(opts.db, opts.campaignId ?? null, now);
      if (day.used >= day.limit) {
        const retryAt = (day.oldest ?? now) + DAY;
        return { ok: false, reason: DAILY_SEARCH_LIMIT, retryAt, detail: dailySearchLimitLine(day.limit, retryAt - now) };
      }
      const hourly = opts.cap ?? hour.limit;
      if (hour.used >= hourly) {
        return { ok: false, reason: "discover_hourly_cap", retryAt: hourly === 0 ? now + DAY : (hour.oldest ?? now) + HOUR };
      }
      return null;
    },
  );
}

/** Why a discover page was refused once the account's daily search pages
 *  are spent. */
export const DAILY_SEARCH_LIMIT = "discover_daily_cap";

/** The limits an account holds until the owner edits them: the defaults of
 *  `channels.daily_search_page_cap` and `hourly_search_cap`, and so what an
 *  org with no account row yet is held to. */
const DEFAULT_SEARCH_PAGES_PER_DAY = 150;
const DEFAULT_SEARCH_CALLS_PER_HOUR = 80;

/** Where a discovery limit in force comes from: the account's own setting, or
 *  the environment variable that overrides it. */
export type SearchLimitSource = "account" | "environment";

/** A discovery limit as it binds: the environment variable when it is set —
 *  the ops and test seam, which overrides every account and is read at call
 *  time, so it can be tuned without a restart — else the account's own. 0 turns
 *  discovery reads off, whichever it comes from. */
function searchLimit(env: string, own: number): { limit: number; source: SearchLimitSource } {
  const set = envInt(env, Number.NaN);
  return Number.isNaN(set) ? { limit: own, source: "account" } : { limit: Math.max(0, set), source: "environment" };
}

/** How a run's note that the daily search limit stopped its sweep opens,
 *  whatever the limit was that day — what a surface flagging such a run
 *  reads it by. */
export const DAILY_SEARCH_LIMIT_NOTE = "Daily search limit reached";

/** A wait as a note says it: "45 min", "3 h 20 min". */
function waitWords(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes} min`;
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
}

/** The daily search limit as the owner reads it in a run's note: the pages the
 *  account had, and in how long the oldest of them frees one — the window is
 *  rolling, so it is never "tomorrow". */
export function dailySearchLimitLine(limit: number, freesIn: number): string {
  return limit === 0
    ? `${DAILY_SEARCH_LIMIT_NOTE} (0 pages) — discovery reads are turned off for this account`
    : `${DAILY_SEARCH_LIMIT_NOTE} (${limit} pages) — the next search frees up in ${waitWords(freesIn)}`;
}

/** The page count a daily-search-limit note recorded — the limit that day,
 *  which a later change to it does not rewrite — or null for any other note.
 *  Reads the notes that said "Scout resumes tomorrow" as well as the ones
 *  that say when the next search frees up. */
export function dailySearchLimitPages(note: string): number | null {
  if (!note.startsWith(DAILY_SEARCH_LIMIT_NOTE)) return null;
  const pages = /\((\d+) pages\)/.exec(note);
  return pages ? Number(pages[1]) : null;
}

/** The searches the account behind a campaign made in the rolling day and in
 *  the last hour, each against its limit. */
export type DiscoverBudget = {
  /** The rolling 24 hours, across every campaign on the account, and when the
   *  oldest of those searches ages out. */
  day: { used: number; limit: number; oldest: number | null; source: SearchLimitSource };
  /** The last hour, and when the oldest search in it ages out. */
  hour: { used: number; limit: number; oldest: number | null; source: SearchLimitSource };
};

/**
 * Searches the account behind `campaignId` made in the rolling day and in the
 * last hour, its two limits, and when the oldest search of the day ages out.
 * One search is one reservation: a keyword or author search, or one further
 * results page of it, counted when it is made — whether it fails or finds
 * nothing new.
 *
 * Discover rows carry no channel — they are not posting exposure, and no
 * posting scope may count them — so the account is the CAMPAIGN's: a row
 * counts toward the channel its campaign is on, and a campaign with none
 * (or a row with no campaign) toward the account `ledgerChannelId` falls back
 * to. The limits are that channel's own.
 */
export async function discoverBudget(
  tx: Tx,
  campaignId: number | null,
  now: number = Date.now(),
): Promise<DiscoverBudget> {
  const channelId = await ledgerChannelId(tx, campaignId);
  const fallback = await ledgerChannelId(tx, null);
  const [row] = await tx
    .select({
      used: sql<number>`count(*)::int`,
      oldest: sql<number | null>`min(${rateLimitLedger.ts})`,
      lastHour: sql<number>`(count(*) filter (where ${rateLimitLedger.ts} >= ${now - HOUR}))::int`,
      oldestHour: sql<number | null>`min(${rateLimitLedger.ts}) filter (where ${rateLimitLedger.ts} >= ${now - HOUR})`,
    })
    .from(rateLimitLedger)
    .leftJoin(campaigns, eq(campaigns.id, rateLimitLedger.campaignId))
    .where(
      and(
        eq(rateLimitLedger.action, "discover"),
        gte(rateLimitLedger.ts, now - DAY),
        completedLedgerActionPredicate(),
        sql`coalesce(${campaigns.channelId}, ${fallback}) is not distinct from ${channelId}`,
      ),
    );
  const [own] =
    channelId === null
      ? []
      : await tx
          .select({ daily: channels.dailySearchPageCap, hourly: channels.hourlySearchCap })
          .from(channels)
          .where(eq(channels.id, channelId));
  return {
    day: {
      used: row?.used ?? 0,
      oldest: row?.oldest == null ? null : Number(row.oldest),
      ...searchLimit("ENGAGER_DISCOVERY_PAGES_PER_DAY", own?.daily ?? DEFAULT_SEARCH_PAGES_PER_DAY),
    },
    hour: {
      used: row?.lastHour ?? 0,
      oldest: row?.oldestHour == null ? null : Number(row.oldestHour),
      ...searchLimit("ENGAGER_DISCOVERY_CALLS_PER_HOUR", own?.hourly ?? DEFAULT_SEARCH_CALLS_PER_HOUR),
    },
  };
}

/** The account's searches in the rolling day against its daily limit — the
 *  day half of `discoverBudget`. */
export async function discoverPagesToday(
  tx: Tx,
  campaignId: number | null,
  now: number = Date.now(),
): Promise<DiscoverBudget["day"]> {
  return (await discoverBudget(tx, campaignId, now)).day;
}

/**
 * Meter + cap a poll call (poll_incoming). Lower-concurrency
 * than discover (one per 5-min scheduler slot, idempotency-keyed), so no advisory
 * lock — a soft count-then-record is enough. Gives the ledger a complete picture of
 * the account's read-side provider traffic.
 */
export async function reservePollCall(opts: {
  db: Tx;
  now?: number;
  cap?: number;
}): Promise<EngageDecision> {
  return reserveReadCall(
    opts.db,
    "poll",
    opts.cap ?? POLL_CALLS_PER_HOUR,
    opts.now ?? Date.now(),
    null,
    false,
  );
}

/**
 * Atomically reserve + record ONE provider author-profile call against the org's
 * hourly budget (author-impact enrichment). Advisory-locked like discover:
 * sibling campaigns' enrich jobs in one org can race at cap-1. The profile
 * endpoint is the scarcest read (~100/day observed on the spike) — 8/hr keeps
 * the theoretical ceiling under it while the author-dedup + TTL in
 * enrich_authors keep real usage far lower. Read at CALL time (not module load)
 * so ops/tests can tune it without a restart.
 */
export async function reserveProfileCall(opts: {
  db: Tx;
  campaignId?: number | null;
  now?: number;
  cap?: number;
}): Promise<EngageDecision> {
  return reserveReadCall(
    opts.db,
    "profile",
    opts.cap ?? envInt("ENGAGER_PROFILE_CALLS_PER_HOUR", 8),
    opts.now ?? Date.now(),
    opts.campaignId ?? null,
    true,
  );
}

/**
 * Atomically reserve + record ONE research read against the ACCOUNT's daily
 * read budget (`dailyThreadReadCap` / `dailyProfileReadCap`), before the read.
 *
 * Reads are the account's, not the org's API budget: each is a page load on
 * the connected session, so the row is stamped with the channel and counted in
 * its scope over a rolling 24h. They share no count with the exposure caps —
 * every posting gate counts its own actions only.
 *
 * Kill switch and pause stop reads, and so does the active window: an account
 * that only acts inside its hours does not read outside them either. A budget
 * of 0 refuses every read, which is how the owner turns verification off. The
 * advisory lock makes count-then-insert one critical section, so two
 * concurrent verifies cannot both pass at cap-1.
 *
 * Reserve in a short transaction of its own, before the page load: the lock
 * is held to commit, and a read that fails afterwards must still have spent
 * its row, or a failing read retries without bound.
 */
export async function reserveResearchRead(opts: {
  db: Tx;
  read: ResearchRead;
  channel: Pick<
    Channel,
    | "id"
    | "activeHours"
    | "activeDays"
    | "dailyThreadReadCap"
    | "dailyProfileReadCap"
  >;
  campaignId?: number | null;
  /** The author a profile read visits. */
  profileId?: string | null;
  now?: number;
}): Promise<EngageDecision> {
  const { read, channel } = opts;
  return reserveDailyRead(
    opts,
    read,
    read === "thread_read" ? channel.dailyThreadReadCap : channel.dailyProfileReadCap,
  );
}

/**
 * Atomically reserve + record ONE reply check — a read of what someone wrote
 * back: the thread under one of our own comments, a page of notification
 * cards, or the inbox and a conversation in it — against the account's own
 * daily budget (`dailyReplyCheckCap`), before the read.
 *
 * Its own count, never Research's: verifying matches spends `thread_read`, and
 * a day on which Research spends all of it must still see what people wrote
 * back to the owner. Everything else is a research read's — the kill switch,
 * the pause and the window stop it, the advisory lock serializes it, and its
 * row is spent whether or not the page then loads.
 */
export async function reserveReplyCheck(opts: {
  db: Tx;
  channel: Pick<Channel, "id" | "activeHours" | "activeDays" | "dailyReplyCheckCap">;
  campaignId?: number | null;
  now?: number;
}): Promise<EngageDecision> {
  return reserveDailyRead(opts, REPLY_CHECK, opts.channel.dailyReplyCheckCap);
}

/**
 * When the account last read its notification cards: the newest reply check
 * no campaign spent — a thread read is always a campaign's watch's, while
 * every page of cards spends one of the account's own — or null when it never
 * has. A sweep pages back no further than this.
 */
export async function lastNotificationSweepAt(tx: Tx, channelId: number): Promise<number | null> {
  const [last] = await tx
    .select({ at: sql<number | null>`max(${rateLimitLedger.ts})::float8` })
    .from(rateLimitLedger)
    .where(
      and(
        eq(rateLimitLedger.action, REPLY_CHECK),
        eq(rateLimitLedger.channelId, channelId),
        isNull(rateLimitLedger.campaignId),
      ),
    );
  return last?.at ?? null;
}

/**
 * Research's spent day as the owner reads it in a run's note, or null for a
 * refusal that is not one — the window, a stop or a read turned off each say
 * something else. A daily cap is the one refusal whose answer is tomorrow.
 */
export function researchReadLimitLine(
  reason: string,
  channel: Pick<Channel, "dailyThreadReadCap" | "dailyProfileReadCap">,
): string | null {
  if (reason === "thread_read_daily_cap")
    return `Research read limit reached (${channel.dailyThreadReadCap}/day) — checking more posts resumes tomorrow`;
  if (reason === "profile_read_daily_cap")
    return `Research profile-read limit reached (${channel.dailyProfileReadCap}/day) — checking more posts resumes tomorrow`;
  return null;
}

/**
 * The reply-check budget spent, as the owner reads it in a note, or null for
 * a refusal that is not that one. The replies under the owner's comments and
 * the messages in their inbox share it, so the line names both.
 */
export function replyCheckLimitLine(
  reason: string,
  channel: Pick<Channel, "dailyReplyCheckCap">,
): string | null {
  return reason === "reply_check_daily_cap"
    ? `Reply and DM check limit reached (${channel.dailyReplyCheckCap}/day) — checking resumes tomorrow`
    : null;
}

/** One read against one of the account's rolling-24h read budgets: the body
 *  {@link reserveResearchRead} and {@link reserveReplyCheck} share. */
async function reserveDailyRead(
  opts: {
    db: Tx;
    channel: Pick<Channel, "id" | "activeHours" | "activeDays">;
    campaignId?: number | null;
    profileId?: string | null;
    now?: number;
  },
  read: ResearchRead | typeof REPLY_CHECK,
  cap: number,
): Promise<EngageDecision> {
  const { db: tx, channel } = opts;
  const now = opts.now ?? Date.now();
  const paused = await isPaused(tx, now);
  if (paused.paused)
    return {
      ok: false,
      reason: paused.reason ?? "paused",
      retryAt: now + 30 * 60_000,
    };
  const win = withinActiveWindow(now, channel.activeHours, channel.activeDays);
  if (!win.within)
    return { ok: false, reason: "outside_active_hours", retryAt: driftPastOpen(win.nextOpen) };
  if (cap <= 0) return { ok: false, reason: `${read}_off`, permanent: true };
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${read} || ':' || ${channel.id}))`,
  );
  const [window] = await tx
    .select({
      used: sql<number>`count(*)::int`,
      oldest: sql<number | null>`min(${rateLimitLedger.ts})::float8`,
    })
    .from(rateLimitLedger)
    .where(
      and(
        eq(rateLimitLedger.action, read),
        eq(rateLimitLedger.channelId, channel.id),
        gte(rateLimitLedger.ts, now - DAY),
        completedLedgerActionPredicate(),
      ),
    );
  // Rolling: the budget frees one read when the oldest counted one ages out.
  if ((window?.used ?? 0) >= cap)
    return {
      ok: false,
      reason: `${read}_daily_cap`,
      retryAt: (window?.oldest ?? now) + DAY,
    };
  // Stamped with the clock the count above used, so the row and the window
  // that will count it agree.
  await tx.insert(rateLimitLedger).values({
    action: read,
    channelId: channel.id,
    campaignId: opts.campaignId ?? null,
    targetProfileId: read === "profile_read" ? (opts.profileId ?? null) : null,
    ts: now,
  });
  return { ok: true };
}

/** The same channel, rolling window and receipt population reserveDailyRead
 * counts. This is usage across campaigns, not just this run's room reads. */
export async function threadReadsToday(tx: Tx, channelId: number, now = Date.now()): Promise<number> {
  const [row] = await tx.select({ used: sql<number>`count(*)::int` }).from(rateLimitLedger)
    .where(and(eq(rateLimitLedger.action, "thread_read"), eq(rateLimitLedger.channelId, channelId),
      gte(rateLimitLedger.ts, now - DAY), completedLedgerActionPredicate()));
  return row?.used ?? 0;
}

/** The same count for the account's profile reads, across campaigns. */
export async function profileReadsToday(tx: Tx, channelId: number, now = Date.now()): Promise<number> {
  const [row] = await tx.select({ used: sql<number>`count(*)::int` }).from(rateLimitLedger)
    .where(and(eq(rateLimitLedger.action, "profile_read"), eq(rateLimitLedger.channelId, channelId),
      gte(rateLimitLedger.ts, now - DAY), completedLedgerActionPredicate()));
  return row?.used ?? 0;
}

/** When the account's day of profile reads next frees one: the oldest read in
 *  the rolling day ages out. Null while none is counted. */
export async function profileReadsFreeAt(tx: Tx, channelId: number, now = Date.now()): Promise<number | null> {
  const [row] = await tx.select({ oldest: sql<number | null>`min(${rateLimitLedger.ts})::float8` }).from(rateLimitLedger)
    .where(and(eq(rateLimitLedger.action, "profile_read"), eq(rateLimitLedger.channelId, channelId),
      gte(rateLimitLedger.ts, now - DAY), completedLedgerActionPredicate()));
  return row?.oldest == null ? null : row.oldest + DAY;
}

/** The account's profile reads left in the rolling day: its daily cap less
 *  what every campaign spent, never below nothing, and nothing while the cap
 *  is 0. Zero for an account that is not there. */
export async function profileReadsLeft(tx: Tx, channelId: number, now = Date.now()): Promise<number> {
  const [channel] = await tx
    .select({ cap: channels.dailyProfileReadCap })
    .from(channels)
    .where(eq(channels.id, channelId));
  if (!channel) return 0;
  return Math.max(0, channel.cap - (await profileReadsToday(tx, channelId, now)));
}

async function reserveReadCall(
  tx: Tx,
  action: EngageAction,
  cap: number,
  now: number,
  campaignId: number | null,
  lock: boolean,
  /** A further ceiling checked after the hourly one, under the same lock. */
  ceiling?: () => Promise<EngageDecision | null>,
): Promise<EngageDecision> {
  const paused = await isPaused(tx, now);
  if (paused.paused)
    return {
      ok: false,
      reason: paused.reason ?? "paused",
      retryAt: now + 30 * 60_000,
    };
  if (lock) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${action} || ':' || coalesce(current_setting('app.current_org', true), '')))`,
    );
  }
  // A non-positive (or non-finite) cap means "no hourly cap" — consistent with the
  // campaign cap fields (`perProfile*Cap <= 0` = unlimited). The per-run page
  // budget still bounds bursts, so an explicit 0 can't run away.
  if (cap > 0) {
    // Explicitly org-wide: poll/profile meter the ORG's read budget, not
    // posting exposure. No account owns these calls, and stating that here is
    // the decision the required scope parameter forces. Discover's hourly limit
    // is its account's, so it is read in `ceiling` instead.
    const used = await countSince(tx, { orgWide: true }, [action], now - HOUR, {});
    if (used >= cap)
      return {
        ok: false,
        reason: `${action}_hourly_cap`,
        retryAt: now + 10 * 60_000,
      };
  }
  const refused = await ceiling?.();
  if (refused) return refused;
  // `channelId: null` on purpose — the mirror image of the `{ orgWide: true }`
  // read above. These are org API-budget rows; no posting scope counts them,
  // and attributing them to an account would inflate that account's exposure
  // with reads it never posted.
  await tx
    .insert(rateLimitLedger)
    .values({ action, channelId: null, campaignId, meta: null });
  return { ok: true };
}
