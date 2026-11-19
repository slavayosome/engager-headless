/**
 * Telemetry's start-up, called once by each long-lived Engager process (the
 * agent, the dashboard, the MCP server): tell the pipe which agent serves this
 * install, and, in the agent, run the once-per-start lifecycle facts.
 *
 * Never throws and never blocks a start: a database that is not up yet, an
 * unreadable agent state or an unwritable home all mean "report less", not
 * "fail to boot" (INV-19: telemetry never blocks or fails a product path).
 */
import { eq } from "drizzle-orm";
import { telemetryEnabled, track } from "@engager/observability/analytics";
import { bootTelemetry } from "@engager/observability/boot";
import {
  registerTelemetryContext,
  type DynamicContext,
} from "@engager/observability/context";
import { organizations } from "@engager/database/schema";
import { withOrg } from "@engager/database/tenant";
import { AGENT_ADAPTERS } from "@engager/observability/events";
import { registerRelayOrigin } from "@engager/observability/relay";
import { claimMilestone, readPlanHint, writePlanHint } from "@engager/observability/telemetryState";
import { readAgentState } from "../ai/agentCli/state";

type Adapter = (typeof AGENT_ADAPTERS)[number];

/** The adapter behind this install's background work, or "none". A hosted
 * tenant runs on Engager's own API backend, so it reports none. */
export async function installedAgentAdapter(): Promise<Adapter | "none"> {
  try {
    const state = await readAgentState();
    const id = state.backgroundSelection?.adapterId ?? state.chatSelection?.adapterId;
    return (AGENT_ADAPTERS as readonly string[]).includes(id ?? "") ? (id as Adapter) : "none";
  } catch {
    return "none";
  }
}

/**
 * What only a process that carries the licence gate can supply. Core imports
 * none of it, so the agent and the dashboard pass
 * it in. A process that passes nothing (the MCP server) reports the canonical
 * cloud and reads the plan these two leave behind (`writePlanHint`).
 */
export type TelemetrySources = {
  /** Whether this Mac holds a live managed-app claim. */
  paid?: () => boolean;
  /** Where usage data is relayed (`cloudBaseUrl`). */
  relayOrigin?: () => string;
};

/** How often a process that reads the plan refreshes the hint the others
 * report; well inside `PLAN_HINT_MAX_AGE_MS`, so one missed write is not a
 * stale plan. */
const PLAN_HINT_REFRESH_MS = 60 * 60_000;

let hintTimer: NodeJS.Timeout | null = null;

/** The claim as this process reads it; null when it cannot say. A failed read
 * is not a plan: it reports whatever hint is fresh, or `unknown`. */
function readPaid(sources: TelemetrySources): boolean | null {
  try {
    return sources.paid?.() ?? null;
  } catch {
    return null;
  }
}

/** Leave this process's reading of the plan for the ones that cannot take it. */
function stampPlanHint(sources: TelemetrySources): void {
  const paid = readPaid(sources);
  if (paid === null || !telemetryEnabled()) return;
  const before = readPlanHint()?.plan;
  writePlanHint(paid ? "paid" : "free");
  // Only a change this install watched happen: one that was already on a plan
  // when it first looked has no start to report.
  if (!paid || before !== "free") return;
  if (claimMilestone("plan_started")) track("plan_started", {});
}

/** Register what only the product knows (the agent adapter, and the plan and
 * relay origin a gate-carrying process passes in). Safe to call from any
 * process; the pipe resolves it lazily at flush time. A process that reads the
 * plan also stamps it for the others, now and hourly while it lives. */
export function registerCoreTelemetryContext(sources: TelemetrySources = {}): void {
  registerRelayOrigin(sources.relayOrigin ?? null);
  registerTelemetryContext(async (): Promise<DynamicContext> => {
    const paid = readPaid(sources);
    return { agentAdapter: await installedAgentAdapter(), ...(paid === null ? {} : { paid }) };
  });
  if (hintTimer) clearInterval(hintTimer);
  hintTimer = null;
  if (!sources.paid) return;
  stampPlanHint(sources);
  // A pending refresh must never keep a short-lived process alive.
  hintTimer = setInterval(() => stampPlanHint(sources), PLAN_HINT_REFRESH_MS);
  hintTimer.unref();
}

/** Whether this install had finished setup before this start, which is what
 * separates an install the new Terms already covered from one they did not. */
async function hadPriorUse(): Promise<boolean> {
  const organizationId = process.env.ENGAGER_ORG_ID;
  if (!organizationId) return false;
  try {
    const [org] = await withOrg(organizationId, (tx) =>
      tx
        .select({ step: organizations.onboardingStep })
        .from(organizations)
        .where(eq(organizations.id, organizationId)),
    );
    return org?.step === "done";
  } catch {
    return false;
  }
}

/** The agent process's start: context plus the install's lifecycle facts. */
export async function startAgentTelemetry(sources: TelemetrySources = {}): Promise<void> {
  try {
    if (!telemetryEnabled()) return;
    registerCoreTelemetryContext(sources);
    bootTelemetry({ hadPriorUse: await hadPriorUse() });
  } catch {
    // Reports less; boots anyway.
  }
}
