import { db as baseDb } from "@engager/database";
import { organizations, runtimeHeartbeats } from "@engager/database/schema";
import { withOrg } from "@engager/database/tenant";
import { runtimeInstanceId } from "../execution/authority";
import { beatRuntimeHeartbeat } from "../tasks/liveness";
import { eq } from "drizzle-orm";

/**
 * The worker's proof of life, written where an interactive tool can read it.
 *
 * A worker with an empty queue is still a worker, and the question a tool asks
 * before it queues (`agentHealthy`) is about the PROCESS, not about any job. So
 * the beat cannot ride only on claimed work: an idle agent that stopped beating
 * would send the owner's next seed into their own session while a perfectly
 * good worker sat three feet away waiting for it.
 *
 * Cross-org by construction, and WORKER-SIDE — the same standing this module's
 * neighbour has: `claimNextJob` scans `jobs` across every org before it enters
 * a tenant scope, because a worker process is not a tenant. `runLoop` serves
 * whatever the database holds (one org on a laptop, every tenant on the hosted
 * worker) and there is no narrower truthful answer to "which orgs does this
 * process serve". Only the enumeration is cross-org: every WRITE is per-org and
 * inside `withOrg`, so each beat is a tenant-scoped statement under the table's
 * own policy and nothing here touches a row across a boundary.
 *
 * One statement per org rather than one for all of them, deliberately: the
 * table is RLS-FORCED on `app.current_org`, so a single multi-row insert would
 * have to be made outside tenant scope to span orgs — which is the property
 * this table is not allowed to have. The cost is bounded by the org count and
 * paid once every 2.5 minutes.
 *
 * Never throws. A beat that fails is a beat that goes stale, which is already
 * the exact meaning the reader gives it — and killing the queue over it would
 * be the failure the liveness signal was meant to describe.
 */
export async function beatRuntimeForServedOrgs(
  db: typeof baseDb,
  runtimeId: string,
  at: number = Date.now(),
): Promise<number> {
  let rows: { id: string }[];
  try {
    rows = await db.select({ id: organizations.id }).from(organizations);
  } catch {
    return 0;
  }
  let beaten = 0;
  for (const row of rows) {
    try {
      await withOrg(row.id, (tx) => beatRuntimeHeartbeat(tx, runtimeId, at));
      beaten += 1;
    } catch {
      /* one org's beat is not the loop's problem — the next tick retries */
    }
  }
  return beaten;
}

/**
 * Drop this runtime's beats on a clean exit.
 *
 * Without it the rows age out on their own inside `RUNTIME_HEARTBEAT_STALE_MS`,
 * which is correct but slow: an owner who quits the app and immediately asks
 * for a seed would be told to wait up to three minutes on a process that ended
 * while they were reading the sentence. A graceful stop knows better than the
 * clock does, so it says so. A crash still falls back to staleness, which is
 * exactly what staleness is for.
 */
export async function clearRuntimeForServedOrgs(
  db: typeof baseDb,
  runtimeId: string,
): Promise<void> {
  let rows: { id: string }[];
  try {
    rows = await db.select({ id: organizations.id }).from(organizations);
  } catch {
    return;
  }
  for (const row of rows) {
    try {
      await withOrg(row.id, (tx) =>
        tx
          .delete(runtimeHeartbeats)
          .where(eq(runtimeHeartbeats.runtimeId, runtimeId)),
      );
    } catch {
      /* the row ages out on its own; a failed tidy-up is not a failed exit */
    }
  }
}

/**
 * Start the process-level beat and hand back its stop.
 *
 * The interval is the JOB heartbeat's, deliberately: the two facts are "this
 * lease is still held" and "this process is still here", they go stale for the
 * same reason, and keeping one number means `RUNTIME_HEARTBEAT_STALE_MS` can be
 * reasoned about against a single cadence rather than against whichever timer
 * fired last.
 */
export function startRuntimeBeat(
  db: typeof baseDb,
  intervalMs: number,
  runtimeId: string = runtimeInstanceId(),
): () => void {
  void beatRuntimeForServedOrgs(db, runtimeId);
  const timer = setInterval(() => {
    void beatRuntimeForServedOrgs(db, runtimeId);
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
