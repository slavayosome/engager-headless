import { and, eq, inArray, notExists } from "drizzle-orm";
import { campaignStrategies, campaigns, type RunnerOutcome } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { normalizeQuotaState } from "../runnerQuota";

const RUNNER_CONTRACT_MAJOR = 2;
const RUNNER_CONTRACT_MINOR = 1;

/**
 * Runner-liveness read model, shared by the MCP `get_runner_status` tool and
 * the dashboard ops page. The write side (heartbeat upsert + directive) stays
 * in `mcp/tools/runner.ts` — it is runner-facing control logic, not a view.
 */

/** The service loop polls every jittered 4–6.5 minutes, independently of its
 * draft wake cadence. Four missed worst-case polls plus grace is 30 minutes. */
export const RUNNER_HEARTBEAT_STALE_MS = 30 * 60_000;

/** A runner is only called ready when it has produced a server-accepted receipt
 * recently. A fresh heartbeat proves process liveness, not useful work. */
export const RUNNER_RECEIPT_RECENT_MS = 24 * 60 * 60_000;

export const RUNNER_PROTOCOL = {
  major: RUNNER_CONTRACT_MAJOR,
  minimumMinor: RUNNER_CONTRACT_MINOR,
} as const;

export type RunnerHealthCode =
  | "linkedin_disconnected"
  | "linkedin_connection_invalid"
  | "radar_paused"
  | "target_missing"
  | "runner_credential_missing"
  | "runner_credential_revoked"
  | "runner_credential_expired"
  | "runner_upgrade_required"
  | "runner_paused"
  | "runner_stopped"
  | "runner_halted"
  | "runner_offline"
  | "runner_budget_used"
  | "runner_quota_blocked"
  | "runner_engine_overloaded"
  | "runner_engine_attention"
  | "runner_blocked"
  | "runner_working"
  | "runner_ready"
  | "runner_stalled"
  | "manual";

export type RunnerHealthTone =
  | "ready"
  | "working"
  | "degraded"
  | "blocked"
  | "manual";

/** Customer-facing, exhaustively tagged runner health. `impact` and `action`
 * deliberately live in the read model so every UI surface explains the same
 * consequence and recovery instead of translating infrastructure ad hoc. */
export type RunnerHealth = {
  code: RunnerHealthCode;
  tone: RunnerHealthTone;
  title: string;
  impact: string;
  action: string | null;
  runnerId: string | null;
  workOrderId: string | null;
  lastSeenAt: number | null;
  lastAcceptedReceiptAt: number | null;
  /** When the quota condition driving this state was last reported (server
   * clock, falling back to the heartbeat). Non-null only for quota-family
   * codes; UI "updated" lines should prefer it over receipt time there. */
  quotaObservedAt: number | null;
  /** Structured reset moment for quota-family codes when one is actually
   * known: the server-inferred UTC-midnight refill for the local daily
   * budget, or a runner-reported future provider reset. Null means no time
   * promise may be rendered. */
  quotaResetsAt: number | null;
};

type HealthRunner = {
  runnerId: string;
  state: "starting" | "preflight" | "session" | "sleeping" | "idle-remote" | "paused-local" | "halted" | "stopped";
  lastSeenAt: number;
  lastHealthyReceiptAt: number | null;
  contractMajor: number | null;
  contractMinor: number | null;
  quotaState: Record<string, unknown> | null;
  quotaStateObservedAt: number | null;
  sessionsToday: number;
  lastOutcome: RunnerOutcome | null;
};

export type ResolveRunnerHealthInput = {
  now: number;
  /** Undefined means this concern was not loaded by this caller. */
  connection?: "connected" | "missing" | "invalid" | "expired";
  /** True when the campaign in scope is deliberately paused (campaign status
   * "paused"). Distinct from `targetReady === false`, which reads as "no
   * target configured" — a paused Scout must say so, not demand setup. */
  campaignPaused?: boolean;
  /** True when the only campaigns in scope were never started: nothing in
   *  them was paused and nothing is meant to run yet, which is neither a
   *  pause nor a missing target. */
  campaignNotStarted?: boolean;
  /** Undefined means this concern was not loaded by this caller. */
  targetReady?: boolean;
  runner?: HealthRunner | null;
  /** Server-owned session pacing (E2): today's claim grants vs the server
   * budget. Server truth outranks runner self-reported quota — when the
   * server itself has stopped granting sessions, that is the honest cause. */
  serverBudget?: {
    grantedToday: number;
    dailyBudget: number;
    exhausted: boolean;
  } | null;
  /** Undefined means credentials were not loaded; null means no runner key. */
  credential?: { revokedAt: number | null; expiresAt: number | null } | null;
  openWork?: {
    id: string;
    status: "queued" | "claimed";
    leaseExpiresAt: number | null;
    claimedByRunnerId?: string | null;
  } | null;
  /** Most recent order this runner actually claimed, including terminal rows.
   * Used to prevent an older receipt from masking a newer failed/expired run. */
  lastClaimedWork?: {
    id: string;
    status: "completed" | "partial" | "failed" | "expired" | "cancelled";
    terminalAt: number;
  } | null;
};

type HealthCopy = Omit<
  RunnerHealth,
  | "runnerId"
  | "workOrderId"
  | "lastSeenAt"
  | "lastAcceptedReceiptAt"
  | "quotaObservedAt"
  | "quotaResetsAt"
>;

function health(
  input: ResolveRunnerHealthInput,
  value: HealthCopy & {
    quotaObservedAt?: number | null;
    quotaResetsAt?: number | null;
  },
): RunnerHealth {
  return {
    quotaObservedAt: null,
    quotaResetsAt: null,
    ...value,
    runnerId:
      input.runner?.runnerId ?? input.openWork?.claimedByRunnerId ?? null,
    workOrderId: input.openWork?.id ?? input.lastClaimedWork?.id ?? null,
    lastSeenAt: input.runner?.lastSeenAt ?? null,
    lastAcceptedReceiptAt: input.runner?.lastHealthyReceiptAt ?? null,
  };
}

/** The runner keys its daily budget by the UTC calendar date — engager-agent
 * `src/loop.ts` derives the day as `new Date().toISOString().slice(0, 10)` —
 * so the budget refills at the next UTC midnight. The runner reports no reset
 * time for its local cap; this is the server-inferred one. */
export function nextUtcMidnightMs(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** Product-voice relative time for banner copy ("in 25 minutes",
 * "in about 2 hours"). Never mentions time zones. */
export function relativeTimeUntil(target: number, now: number): string {
  const minutes = Math.round(Math.max(0, target - now) / 60_000);
  if (minutes < 1) return "in under a minute";
  if (minutes < 60)
    return minutes === 1 ? "in 1 minute" : `in ${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "in about 1 hour" : `in about ${hours} hours`;
  const days = Math.round(hours / 24);
  return days === 1 ? "in about 1 day" : `in about ${days} days`;
}

/** " (N runs)" only when the reported count is sane (integer 1..1000); a
 * garbage or missing count silently drops the parenthetical. */
function sessionCount(sessionsToday: number | null | undefined): string {
  if (
    typeof sessionsToday !== "number" ||
    !Number.isInteger(sessionsToday) ||
    sessionsToday < 1 ||
    sessionsToday > 1000
  ) {
    return "";
  }
  return sessionsToday === 1 ? " (1 run)" : ` (${sessionsToday} runs)`;
}

/**
 * Copy table keyed on the normalized (status, reasonCode) pair the runner
 * self-reported. Product language only: no raw runner strings, and never the
 * words "session", "quota state", or a time-zone name. Returns null when the
 * reported quota state does not block work.
 */
function quotaHealth(
  runner: HealthRunner,
  now: number,
): (HealthCopy & { quotaResetsAt?: number | null }) | null {
  const quota = normalizeQuotaState(runner.quotaState);
  if (quota.reasonCode === "local_daily_session_cap") {
    // A runner-reported future reset always wins; the UTC-midnight inference
    // is only a fallback pinned to today's engager-agent day keying, so a
    // future runner that changes its budget window needs no server release.
    const resetsAt =
      quota.resetsAt != null && quota.resetsAt > now
        ? quota.resetsAt
        : nextUtcMidnightMs(now);
    return {
      code: "runner_budget_used",
      tone: "degraded",
      title: "Daily agent budget used",
      impact: `Your agent finished its automatic runs for today${sessionCount(
        runner.sessionsToday,
      )}. It starts again ${relativeTimeUntil(
        resetsAt,
        now,
      )} — or run your agent now.`,
      action: "Adjust the agent budget or run on demand",
      quotaResetsAt: resetsAt,
    };
  }
  const providerAllowance = (): HealthCopy & {
    quotaResetsAt?: number | null;
  } => ({
    code: "runner_quota_blocked",
    tone: "degraded",
    title: "Claude/Codex allowance used up",
    impact: `Scout is waiting for your AI provider allowance; Engager billing is unaffected.${
      quota.resetsAt != null && quota.resetsAt > now
        ? ` It resets ${relativeTimeUntil(quota.resetsAt, now)}.`
        : ""
    }`,
    action: "Check your provider plan or choose another engine",
    quotaResetsAt:
      quota.resetsAt != null && quota.resetsAt > now ? quota.resetsAt : null,
  });
  if (quota.reasonCode === "engine_quota") return providerAllowance();
  if (quota.reasonCode === "engine_overloaded") {
    return {
      code: "runner_engine_overloaded",
      tone: "degraded",
      title: "Your AI provider is overloaded",
      impact: "Scout retries automatically; nothing is lost.",
      action: "No action needed — retries are automatic",
    };
  }
  if (
    quota.reasonCode === "engine_not_found" ||
    quota.reasonCode === "engine_unsupported_version" ||
    quota.reasonCode === "engine_auth_required"
  ) {
    return {
      code: "runner_engine_attention",
      tone: "degraded",
      title: "Agent engine needs attention",
      impact:
        "Your Claude/Codex install needs attention before Scout can continue.",
      action: "Run engager-agent doctor",
    };
  }
  if (quota.status === "exhausted" && quota.resetsAt != null) {
    return providerAllowance();
  }
  if (quota.status === "exhausted" || quota.status === "error") {
    return {
      code: "runner_blocked",
      tone: "degraded",
      title: "Agent can't run right now",
      impact:
        "Your agent reported it can't run more work yet. Scout resumes automatically when it can.",
      action: "Check agent status",
    };
  }
  return null;
}

/**
 * Resolve one truthful Scout health state in strict priority order. In
 * particular, liveness never masks connection/auth/protocol failures and a
 * heartbeat alone can never produce `runner_ready`.
 */
export function resolveRunnerHealth(
  input: ResolveRunnerHealthInput,
): RunnerHealth {
  if (input.connection === "missing") {
    return health(input, {
      code: "linkedin_disconnected",
      tone: "blocked",
      title: "LinkedIn is not connected",
      impact:
        "Scout cannot discover new opportunities until an account is connected.",
      action: "Connect LinkedIn",
    });
  }
  if (input.connection === "invalid" || input.connection === "expired") {
    return health(input, {
      code: "linkedin_connection_invalid",
      tone: "blocked",
      title: "LinkedIn access needs attention",
      impact:
        "New discovery and publishing are blocked; existing opportunities are preserved.",
      action: "Reconnect LinkedIn",
    });
  }
  if (input.campaignPaused === true) {
    // Deliberate pause outranks every runner concern below: an idle or offline
    // runner is the EXPECTED consequence of pausing, not a separate problem.
    // Connection/auth failures above still win — they block even after resume.
    return health(input, {
      code: "radar_paused",
      tone: "degraded",
      title: "Scout is paused",
      impact:
        "Every campaign it works for is paused, so discovery and drafting stay stopped until you resume one on Campaigns; existing opportunities and drafts are preserved.",
      action: "Resume Scout",
    });
  }
  if (input.campaignNotStarted === true) {
    return health(input, {
      code: "manual",
      tone: "manual",
      title: "On demand",
      impact:
        "Nothing runs on its own until you start a campaign. Scout sweeps when you ask it to.",
      action: "Start a campaign",
    });
  }
  if (input.targetReady === false) {
    return health(input, {
      code: "target_missing",
      tone: "blocked",
      title: "No active campaign",
      impact:
        "Scout needs an active campaign before it discovers on its own.",
      action: "Review campaigns",
    });
  }

  if (input.credential === null) {
    return health(input, {
      code: "runner_credential_missing",
      tone: "blocked",
      title: "Agent authorization is missing",
      impact: "The installed engager-agent cannot claim or submit Scout work.",
      action: "Authorize your agent again",
    });
  }
  if (input.credential?.revokedAt != null) {
    return health(input, {
      code: "runner_credential_revoked",
      tone: "blocked",
      title: "Agent authorization was revoked",
      impact:
        "Continuous Scout updates have stopped; existing opportunities are preserved.",
      action: "Authorize your agent again",
    });
  }
  if (
    input.credential?.expiresAt != null &&
    input.credential.expiresAt <= input.now
  ) {
    return health(input, {
      code: "runner_credential_expired",
      tone: "blocked",
      title: "Agent authorization expired",
      impact:
        "Continuous Scout updates have stopped; existing opportunities are preserved.",
      action: "Authorize your agent again",
    });
  }
  const runner = input.runner ?? null;
  if (!runner) {
    if (input.openWork?.status === "claimed") {
      return health(input, {
        code: "runner_stalled",
        tone: "degraded",
        title: "Scout refresh is stalled",
        impact: "Claimed work has no matching agent heartbeat.",
        action: "Check agent status",
      });
    }
    return health(input, {
      code: "manual",
      tone: "manual",
      title: "On demand",
      impact:
        'Scout updates when you open Claude or Codex and ask it to sweep.',
      action: "Switch to continuous",
    });
  }
  if (
    runner.contractMajor !== RUNNER_PROTOCOL.major ||
    runner.contractMinor == null ||
    runner.contractMinor < RUNNER_PROTOCOL.minimumMinor
  ) {
    return health(input, {
      code: "runner_upgrade_required",
      tone: "blocked",
      title: "Agent update required",
      impact:
        "The installed engager-agent cannot safely process the current Scout work contract.",
      action: "Update Engager Agent",
    });
  }
  if (runner.state === "paused-local") {
    return health(input, {
      code: "runner_paused",
      tone: "degraded",
      title: "Continuous runs are paused",
      impact:
        "Continuous updates are paused; you can still run your agent on demand.",
      action: "Resume continuous runs",
    });
  }
  if (runner.state === "stopped") {
    return health(input, {
      code: "runner_stopped",
      tone: "degraded",
      title: "Continuous runs are stopped",
      impact:
        "Continuous updates are stopped; you can still run your agent on demand.",
      action: "Start continuous runs",
    });
  }
  if (runner.state === "halted") {
    return health(input, {
      code: "runner_halted",
      tone: "blocked",
      title: "Your agent needs attention",
      impact:
        runner.lastOutcome?.note?.trim() ||
        "Your agent halted before Scout work completed.",
      action: "Check agent status",
    });
  }
  if (isStale(runner.lastSeenAt, null, input.now)) {
    return health(input, {
      code: "runner_offline",
      tone: "degraded",
      title: "Continuous agent appears offline",
      impact:
        "Scout is not refreshing automatically; you can still run your agent on demand.",
      action: "Check your agent",
    });
  }
  // Server-owned pacing outranks runner self-reports: when the SERVER has
  // stopped granting sessions for the day, that is the honest cause — the
  // runner itself may still report "available". Urgent replies and supported
  // Review/Auto-post requests keep running; the copy says so.
  if (input.serverBudget?.exhausted) {
    return health(input, {
      code: "runner_budget_used",
      tone: "degraded",
      title: "Daily agent budget used",
      impact: `Your agent finished today's scheduled runs (${input.serverBudget.grantedToday}). Replies and explicit Review/Auto-post requests still run; everything else starts again ${relativeTimeUntil(nextUtcMidnightMs(input.now), input.now)} — or run your agent now.`,
      action: "Run your agent on demand or adjust the budget",
      quotaObservedAt: runner.lastSeenAt,
    });
  }
  const quota = quotaHealth(runner, input.now);
  if (quota) {
    return health(input, {
      ...quota,
      quotaObservedAt: runner.quotaStateObservedAt ?? runner.lastSeenAt,
    });
  }
  if (
    input.openWork?.status === "claimed" &&
    input.openWork.leaseExpiresAt != null &&
    input.openWork.leaseExpiresAt > input.now
  ) {
    return health(input, {
      code: "runner_working",
      tone: "working",
      title: "Agent is updating Scout",
      impact: "A leased work order is in progress.",
      action: null,
    });
  }
  if (input.openWork?.status === "claimed") {
    return health(input, {
      code: "runner_stalled",
      tone: "degraded",
      title: "Scout refresh is stalled",
      impact:
        "The latest claimed work no longer has a live lease or terminal receipt.",
      action: "Check agent status",
    });
  }

  const receiptAt = runner.lastHealthyReceiptAt;
  if (
    input.lastClaimedWork != null &&
    (receiptAt == null || receiptAt < input.lastClaimedWork.terminalAt)
  ) {
    return health(input, {
      code: "runner_stalled",
      tone: "degraded",
      title: "Scout refresh is stalled",
      impact: "The latest claimed work has no matching accepted receipt.",
      action: "Check agent status",
    });
  }
  if (receiptAt != null && input.now - receiptAt <= RUNNER_RECEIPT_RECENT_MS) {
    return health(input, {
      code: "runner_ready",
      tone: "ready",
      title: "Agent ready",
      impact: "Your agent recently completed server-verified Scout work.",
      action: null,
    });
  }
  return health(input, {
    code: "runner_stalled",
    tone: "degraded",
    title: "Scout refresh is stalled",
    impact:
      "Your agent is online but has not produced a recent accepted receipt.",
    action: "Check agent status",
  });
}

export function isStale(
  lastSeenAt: number,
  _draftIntervalMinutes: number | null,
  now: number,
): boolean {
  return now - lastSeenAt > RUNNER_HEARTBEAT_STALE_MS;
}

/**
 * The health of the campaigns' workers, from the account's connection and the
 * campaigns' own states: signed out, every campaign paused, no active one.
 * `campaignId` narrows it to one campaign's page.
 */
export async function scoutHealthSnapshot(
  tx: Tx,
  opts: { campaignId?: number; now?: number; linkedInConnected: boolean },
): Promise<RunnerHealth> {
  const now = opts.now ?? Date.now();
  const live = await tx
    .select({ id: campaigns.id, status: campaigns.status })
    .from(campaigns)
    .where(inArray(campaigns.status, ["active", "paused"]));
  const active = live.filter((campaign) => campaign.status === "active");
  const paused = live.filter((campaign) => campaign.status === "paused");
  // A paused campaign that never had a version in force was never started.
  const started = paused.length === 0
    ? []
    : await tx
        .select({ id: campaigns.id })
        .from(campaigns)
        .where(
          and(
            inArray(campaigns.id, paused.map((campaign) => campaign.id)),
            notExists(
              tx
                .select({ id: campaignStrategies.id })
                .from(campaignStrategies)
                .where(and(eq(campaignStrategies.campaignId, campaigns.id), eq(campaignStrategies.status, "active"))),
            ),
          ),
        );
  const notStarted = new Set(started.map((row) => row.id));
  const pausedStarted = paused.filter((campaign) => !notStarted.has(campaign.id));
  const only = opts.campaignId;
  return resolveRunnerHealth({
    now,
    connection: opts.linkedInConnected ? "connected" : "missing",
    campaignPaused: only != null ? pausedStarted.some((c) => c.id === only) : active.length === 0 && pausedStarted.length > 0,
    campaignNotStarted: only != null ? notStarted.has(only) : active.length === 0 && pausedStarted.length === 0 && notStarted.size > 0,
    targetReady: only != null ? active.some((c) => c.id === only) : active.length > 0,
  });
}
