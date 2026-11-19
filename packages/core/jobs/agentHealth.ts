import { and, eq, sql } from "drizzle-orm";
import { jobs, organizations, systemState } from "@engager/database/schema";
import { withOrg } from "@engager/database/tenant";

const PROBE_TIMEOUT_MS = 2_000;
const PROBE_CACHE_MS = 10_000;
const SCHEDULER_GRACE_MS = 6 * 60_000;

type AgentHealthState = {
  organizationExists: boolean;
  lastSchedulerTickAt: number | null;
  executionPaused: boolean;
};

async function readAgentHealth(organizationId: string): Promise<AgentHealthState> {
  return withOrg(organizationId, async (tx) => {
    await tx.execute(sql`set local statement_timeout = '1500ms'`);
    const [organization] = await tx.select({ id: organizations.id }).from(organizations)
      .where(eq(organizations.id, organizationId));
    const [state] = await tx.select({
      cloudPaused: systemState.cloudPaused,
      transferPaused: systemState.transferPaused,
    }).from(systemState);
    // jobs is deliberately outside RLS. Match the same scheduler fingerprint
    // as get_status, under an explicit organization predicate.
    const [tick] = await tx.select({ at: sql<number | null>`max(${jobs.createdAt})::float8` })
      .from(jobs).where(and(
        eq(jobs.organizationId, organizationId),
        sql`${jobs.idempotencyKey} like 'poll\\_incoming:%'`,
      ));
    return {
      organizationExists: organization !== undefined,
      lastSchedulerTickAt: tick?.at ?? null,
      executionPaused: state?.cloudPaused === true || state?.transferPaused === true,
    };
  });
}

/** A private readiness probe, not a worker-completion counter. Long jobs and
 * signed-out accounts remain healthy; a dead database or scheduler does not.
 * A timed-out query retains the single in-flight slot until it settles, so
 * repeated platform checks cannot exhaust the pool behind a stuck query. */
export function createAgentHealthProbe(input: {
  organizationId: string;
  now?: () => number;
  /** Fixture seam. Production always reads through withOrg above. */
  readState?: (organizationId: string) => Promise<AgentHealthState>;
}): () => Promise<boolean> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const readState = input.readState ?? readAgentHealth;
  let reading = false;
  let pending: Promise<boolean> | null = null;
  let cached = false;
  let cacheUntil = 0;

  return () => {
    if (now() < cacheUntil) return Promise.resolve(cached);
    if (pending) return pending;
    if (reading) return Promise.resolve(false);
    reading = true;
    pending = new Promise<boolean>((resolve) => {
      let answered = false;
      const finish = (healthy: boolean) => {
        if (answered) return;
        answered = true;
        clearTimeout(timer);
        cached = healthy;
        cacheUntil = now() + PROBE_CACHE_MS;
        pending = null;
        resolve(healthy);
      };
      const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
      void Promise.resolve().then(() => readState(input.organizationId)).then(
        (state) => {
          reading = false;
          if (answered) { cacheUntil = 0; return; }
          const at = now();
          const tick = state.lastSchedulerTickAt;
          const schedulerHealthy = state.executionPaused || at - startedAt < SCHEDULER_GRACE_MS ||
            (tick !== null && Number.isFinite(tick) && tick >= startedAt && tick <= at &&
              at - tick <= SCHEDULER_GRACE_MS);
          finish(state.organizationExists && schedulerHealthy);
        },
        () => {
          reading = false;
          if (answered) { cacheUntil = 0; return; }
          // Never surface database errors: their messages can include URLs.
          finish(false);
        },
      );
    });
    return pending;
  };
}
