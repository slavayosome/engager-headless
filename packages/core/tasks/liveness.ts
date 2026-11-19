import { gte, sql } from "drizzle-orm";
import { runtimeHeartbeats } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { resolvedAgentId } from "../ai/client";

/**
 * How stale a beat may be before the org counts as having no background agent.
 *
 * Three minutes is two things at once: comfortably more than the worker's own
 * beat interval (`LEASE_MS / 2`, 2.5 minutes) so an ordinary tick never reads
 * as death, and short enough that an owner who quit the app a moment ago is not
 * told to wait on a process that is gone. The comparison is `>=` on the age, so
 * a beat EXACTLY three minutes old is already stale — the boundary belongs to
 * the answer that keeps working (in-session) rather than the one that queues
 * into a process nobody can prove is there.
 */
export const RUNTIME_HEARTBEAT_STALE_MS = 3 * 60_000;

/**
 * Record that a runtime is alive and serving this org, right now.
 *
 * One row per (org, runtime): the beat is rewritten in place, so the table
 * stays the size of the installation rather than the size of its uptime. The
 * caller supplies the clock because the worker's beat and the tests' fake clock
 * must be the same code path — a liveness fact read against `Date.now()` and
 * written against anything else is not a fact.
 */
export async function beatRuntimeHeartbeat(
  tx: Tx,
  runtimeId: string,
  at: number = Date.now(),
): Promise<void> {
  await tx
    .insert(runtimeHeartbeats)
    .values({ runtimeId, at })
    .onConflictDoUpdate({
      target: [runtimeHeartbeats.organizationId, runtimeHeartbeats.runtimeId],
      set: { at },
    });
}

/** Whether SOME runtime has beaten for this org inside the staleness window. */
export async function runtimeBeating(
  tx: Tx,
  now: number = Date.now(),
): Promise<boolean> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(runtimeHeartbeats)
    .where(gte(runtimeHeartbeats.at, now - RUNTIME_HEARTBEAT_STALE_MS + 1));
  return (row?.n ?? 0) > 0;
}

/**
 * Does a background agent RESOLVE for this installation?
 *
 * The same question `get_status.setup.agent` answers, asked of the same
 * function: `resolvedAgentId()` returns `"api"` when the direct provider path
 * is configured, the selected adapter's id when one is stored, and throws
 * `agent_selection_required` (or one of the other `AgentCliError` codes) when
 * selection refuses outright — which is `agent.error` on that read.
 *
 * NOT `ctx.llm`. That field is a lazy test/worker seam: `buildMcpCtx` — the
 * only production builder, for stdio and HTTP alike — never sets it, and
 * nothing assigns it afterwards. Reading it here made the resolver answer
 * `interactive_external` on EVERY production install, hosted ones with a
 * beating worker included, so nothing would ever have queued again.
 */
export function backgroundAgentSelected(): boolean {
  try {
    resolvedAgentId();
    return true;
  } catch {
    return false;
  }
}

/**
 * Is there a background agent that will actually do model work for this org?
 *
 * TWO facts, and both are required, because either one alone answers a
 * different question than the caller asked:
 *
 * - a live `runtime_heartbeats` row says a PROCESS is there to claim the job;
 * - a resolvable background agent says that process has something to think
 *   WITH. A free install with no `engager agent configure` has no background
 *   selection, and a job it queued would dead-letter rather than run.
 *
 * A queued job needs both. Missing either is not a fault and never a refusal —
 * it is the routing fact that sends the work into the owner's own session
 * instead (`tasks/executor.ts`).
 */
export async function agentHealthy(
  tx: Tx,
  now: number = Date.now(),
  selected: () => boolean = backgroundAgentSelected,
): Promise<boolean> {
  if (!selected()) return false;
  return runtimeBeating(tx, now);
}
