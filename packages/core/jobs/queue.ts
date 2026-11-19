import { deferInteractiveJob } from "../tasks/judgment";
import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  eq,
  inArray,
  lt,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { db as baseDb } from "@engager/database";
import { jobs, type Job, type JobResultValue } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import type { Refusal } from "../refusal";

export type JobType = Job["type"];

/** The base (un-scoped) DB handle the cross-org claim/complete/fail path runs on. */
type BaseDb = typeof baseDb;

export const LEASE_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;

/**
 * Throw from a handler to retry the job at a specific time (not an error).
 *
 * `refusal` is the rung that said no, when one did. A reschedule is the one
 * outcome the row otherwise keeps only as prose in `lastError`, and a send
 * that a connector keeps refusing — no browser session for the account — is
 * indistinguishable there from a cap that clears on its own. The worker writes
 * it onto `jobs.result`, in the shape a completed job's refusal already takes,
 * so a surface can tell a blocked send from a paced one without parsing text.
 */
export class RescheduleError extends Error {
  retryAt: number;
  refusal: Refusal | null;
  constructor(reason: string, retryAt?: number, refusal?: Refusal) {
    super(`reschedule: ${reason}`);
    this.name = "RescheduleError";
    this.retryAt = retryAt ?? Date.now() + 60_000;
    this.refusal = refusal ?? null;
  }
}

/**
 * Free an idempotency key whose job has already FINISHED, so the same key can
 * be enqueued again.
 *
 * `jobs_org_idempotency_unq` is unconditional and `completeJob` keeps the key,
 * so a key is permanent by default — which is exactly right for the keys that
 * mean "this may only ever happen once" (`worker:<scout>:first` is one) and
 * exactly wrong for the keys that mean "only one of these at a time". A seed is
 * the second kind: the Brain is re-seeded whenever the owner's posts, site or
 * notes move on, and a key retained past `done` answered `already_running`
 * about a job that finished weeks ago, for the life of the organization.
 *
 * Renaming rather than nulling, and to `<key>:<jobId>`, because the finished
 * row is a receipt: `get_status` and the agent surface read it back, and a key
 * that simply vanished would make a completed seed unattributable to the source
 * it ran on. The id makes the retired key unique by construction, so a second
 * retirement of the same key cannot collide.
 *
 * It cannot SILENTLY collide either. A live row already holding the exact
 * string `<key>:<jobId>` would make this update violate
 * `jobs_org_idempotency_unq` and throw, taking the enqueue's transaction with
 * it — the caller sees an error rather than a clobbered key. Reaching that
 * needs a caller to have minted an idempotency key ending in `:` plus the
 * serial id of another job in the same org, which no key format in this repo
 * produces; the point is only that the failure mode is loud.
 *
 * ONLY terminal rows. A `queued` or `running` row keeps its key, which is what
 * leaves `already_running` meaning what it says: something is actually working.
 * Call inside the SAME transaction as the `enqueue` that follows it, or a
 * concurrent insert lands between the two.
 */
export async function retireFinishedIdempotencyKey(
  tx: Tx,
  organizationId: string,
  idempotencyKey: string,
): Promise<number | null> {
  const [row] = await tx
    .update(jobs)
    .set({
      idempotencyKey: sql`${jobs.idempotencyKey} || ':' || ${jobs.id}::text`,
      updatedAt: Date.now(),
    })
    .where(
      and(
        // `jobs` is excluded from RLS, so the org predicate is explicit.
        eq(jobs.organizationId, organizationId),
        eq(jobs.idempotencyKey, idempotencyKey),
        inArray(jobs.status, ["done", "dead"]),
      ),
    )
    .returning({ id: jobs.id });
  return row?.id ?? null;
}

/**
 * Enqueue a job. The `jobs` table is NOT RLS-protected, but it still carries an
 * `organization_id` column whose default is the `app.current_org` GUC — so
 * `enqueue` is always called inside a `withOrg` tx and the org is stamped on by
 * the DB default. `.onConflictDoNothing()` makes the idempotency key a no-op on
 * a double-fire.
 */
export async function enqueue(
  tx: Tx,
  job: {
    type: JobType;
    payload?: unknown;
    nextRunAt?: number;
    idempotencyKey?: string;
    maxAttempts?: number;
  },
): Promise<number | null> {
  if (deferInteractiveJob(job.type)) return null;
  const [row] = await tx
    .insert(jobs)
    .values({
      type: job.type,
      payload: (job.payload as object) ?? null,
      nextRunAt: job.nextRunAt ?? Date.now(),
      idempotencyKey: job.idempotencyKey ?? null,
      maxAttempts: job.maxAttempts ?? 5,
    })
    .onConflictDoNothing()
    .returning({ id: jobs.id });
  return row?.id ?? null;
}

/**
 * ONE definition of "a failed attempt's outcome": count it, then dead-letter at
 * maxAttempts or requeue with backoff. Shared by `failJob` and the lease reaper so
 * the two paths can never drift (they used to be duplicated). Always rotates the
 * lease token — after a failure/reap, any writes from a still-running worker
 * holding the old token must miss.
 */
function failedAttemptUpdate(
  job: Pick<Job, "attempts" | "maxAttempts" | "nextRunAt">,
  error: string,
  now: number,
  retryAt?: number,
): Partial<typeof jobs.$inferInsert> {
  const attempts = job.attempts + 1;
  const dead = attempts >= job.maxAttempts;
  return {
    status: dead ? ("dead" as const) : ("queued" as const),
    lastError: error,
    attempts,
    lockedAt: null,
    leaseToken: null,
    nextRunAt: dead ? job.nextRunAt : (retryAt ?? now + backoffMs(attempts)),
    updatedAt: now,
  };
}

/**
 * Atomically reap stale leases, then claim the next due job. Runs on the BASE db
 * (not a tenant tx) because the worker claims across ALL orgs before entering an
 * org scope — the `jobs` table is excluded from RLS for exactly this reason.
 *
 * The claim SELECT uses `FOR UPDATE SKIP LOCKED`, so multiple CONCURRENT drains
 * (serverless: several QStash-triggered invocations at once) each lock and skip a
 * different row — two workers never grab the same job. Each claim stamps a fresh
 * `leaseToken`; every subsequent write for the job (complete/fail/heartbeat) is
 * guarded on it, so a worker whose lease got reaped can't race the re-claim.
 *
 * `onlyOrgs` (tests) restricts BOTH stale-lease reaping and claiming to a set of
 * org ids so concurrent test files sharing the un-RLS'd `jobs` table never
 * mutate each other's jobs.
 * Production omits it and claims across every org. `excludeTypes` lets the
 * serverless drain skip job types whose budget exceeds its remaining runway
 * (they belong to the continuous worker) — EXCEPT as an orphan rescue: a job of
 * an excluded type that has been due for longer than `rescueAfterMs` clearly has
 * no continuous worker taking it (worker down / mid-redeploy), so the drain
 * claims it anyway with whatever budget it has. Best-effort beats starvation —
 * without this, an es2 outage silently stalls onboarding forever.
 *
 * `spareLeaseTokens` are the leases the CALLER's own process is still working.
 * A lease goes stale without its worker dying when the machine sleeps: the
 * heartbeat is a timer, and the first dark wake can run this reaper before it
 * runs the beat. Reaping a job its own process is still running burns an
 * attempt on a live run and hands the same work to a second one.
 */
export const ORPHAN_RESCUE_AFTER_MS = 3 * 60_000;

function leadStepCampaign(job: Pick<Job, "type" | "payload">): number | null {
  if ((job.type !== "lead_screen" && job.type !== "lead_judge") || typeof job.payload !== "object" || job.payload === null) return null;
  const campaignId = (job.payload as { campaignId?: unknown }).campaignId;
  return typeof campaignId === "number" && Number.isInteger(campaignId) ? campaignId : null;
}

async function coalesceQueuedLeadPhaseJobs(
  tx: Tx,
  job: Pick<Job, "id" | "organizationId" | "type" | "payload">,
  campaignId: number,
  now: number,
): Promise<void> {
  const queued = await tx.execute<{ id: number }>(sql`
    select id::int as id
    from jobs
    where organization_id = ${job.organizationId} and type = ${job.type} and status = 'queued'
      and payload ->> 'campaignId' = ${String(campaignId)}
    order by id
    for update`);
  const duplicates = queued.rows.filter((row) => row.id !== job.id);
  if (duplicates.length === 0) return;
  await tx
    .update(jobs)
    .set({ status: "done", lastError: `coalesced behind job ${job.id}`, updatedAt: now })
    .where(and(eq(jobs.organizationId, job.organizationId), inArray(jobs.id, duplicates.map((row) => row.id)), eq(jobs.status, "queued")));
}

export async function claimNextJob(
  db: BaseDb = baseDb,
  now: number = Date.now(),
  leaseMs: number = LEASE_MS,
  onlyOrgs?: string[],
  excludeTypes?: JobType[],
  rescueAfterMs: number = ORPHAN_RESCUE_AFTER_MS,
  spareLeaseTokens: readonly string[] = [],
): Promise<Job | null> {
  return db.transaction(async (tx) => {
    // Reap stale leases. A lease expires because the worker died mid-job (e.g. the
    // serverless function was killed at its wall-clock limit before the phase-2
    // complete/fail bookkeeping could run), so this is a FAILED attempt, not a free
    // retry: count it and record why, and dead-letter once maxAttempts is reached.
    // Long-running healthy jobs on the continuous worker HEARTBEAT their lockedAt
    // (see extendLease), so they never look stale here.
    const staleConditions = [
      eq(jobs.status, "running"),
      lt(jobs.lockedAt, now - leaseMs),
    ];
    if (onlyOrgs) {
      staleConditions.push(inArray(jobs.organizationId, onlyOrgs));
    }
    if (spareLeaseTokens.length > 0) {
      staleConditions.push(notInArray(jobs.leaseToken, [...spareLeaseTokens]));
    }
    const staleWhere = and(...staleConditions);
    // Lock stale rows at the same moment we decide they are stale. Without this
    // lock, a healthy worker can refresh `lockedAt` after the SELECT but before
    // the UPDATE below, and the reaper would overwrite that fresh heartbeat
    // with a queued/dead state. Concurrent reapers skip rows already being
    // decided by another transaction instead of both counting the same lease.
    const stale = await tx
      .select()
      .from(jobs)
      .where(staleWhere)
      .for("update", { skipLocked: true });
    for (const job of stale) {
      await tx
        .update(jobs)
        .set(
          failedAttemptUpdate(
            job,
            "worker killed mid-job (lease expired)",
            now,
          ),
        )
        .where(and(eq(jobs.id, job.id), staleWhere));
    }

    const conds = [eq(jobs.status, "queued"), lte(jobs.nextRunAt, now)];
    if (onlyOrgs) conds.push(inArray(jobs.organizationId, onlyOrgs));
    if (excludeTypes && excludeTypes.length > 0) {
      // Skip excluded types UNLESS they've been waiting long enough to be orphans.
      // A non-finite rescueAfterMs (the prep lanes pass Infinity) disables the
      // rescue entirely — and would be unrepresentable as a SQL bigint anyway.
      const notExcluded = notInArray(jobs.type, excludeTypes);
      conds.push(
        Number.isFinite(rescueAfterMs)
          ? or(notExcluded, lte(jobs.nextRunAt, now - rescueAfterMs))!
          : notExcluded,
      );
    }
    // A Find leads step runs one job at a time per campaign: one queued behind a
    // running one waits out of sight, so a lane takes other work meanwhile
    // instead of picking it up only to put it down again.
    conds.push(sql`not (${jobs.type} in ('lead_screen', 'lead_judge') and exists (
      select 1 from jobs running
      where running.organization_id = ${jobs.organizationId} and running.type = ${jobs.type}
        and running.status = 'running' and running.payload ->> 'campaignId' = ${jobs.payload} ->> 'campaignId'))`);
    // Ties in enqueue order. Jobs enqueued together share an instant, and the
    // order they were enqueued in is one their enqueuer chose: a tick's Scouts
    // before its Ambassadors (`dueWorkers`), a campaign press's workers in
    // strategy order (`runCampaignNow`).
    const [job] = await tx
      .select()
      .from(jobs)
      .where(and(...conds))
      .orderBy(asc(jobs.nextRunAt), asc(jobs.id))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!job) return null;

    const campaignId = leadStepCampaign(job);
    if (campaignId !== null) {
      const lock = await tx.execute<{ locked: boolean }>(sql`
        select pg_try_advisory_xact_lock(hashtext(${`lead-step:${job.organizationId}:${job.type}:${campaignId}`})) as locked`);
      if (!lock.rows[0]?.locked) return null;
      const running = await tx.execute<{ id: number }>(sql`
        select id::int as id
        from jobs
        where organization_id = ${job.organizationId} and type = ${job.type} and status = 'running'
          and payload ->> 'campaignId' = ${String(campaignId)}
        limit 1`);
      await coalesceQueuedLeadPhaseJobs(tx, job, campaignId, now);
      if (running.rows.length > 0) return null;
    }

    const leaseToken = randomUUID();
    await tx
      .update(jobs)
      .set({ status: "running", lockedAt: now, leaseToken, updatedAt: now })
      .where(eq(jobs.id, job.id));
    return { ...job, status: "running" as const, leaseToken };
  });
}

/** The fencing guard: this worker may only write the job while its token holds. */
function ownedBy(job: Pick<Job, "id" | "leaseToken">) {
  return and(eq(jobs.id, job.id), eq(jobs.leaseToken, job.leaseToken ?? ""));
}

/**
 * Mark the job done — but ONLY if this worker still holds the lease. A worker
 * whose lease was reaped (and whose job may already be re-running elsewhere)
 * writes nothing: without the guard its late completeJob could flip a `dead` or
 * a re-claimed `running` row to `done`.
 */
export async function completeJob(
  db: BaseDb = baseDb,
  job: Pick<Job, "id" | "leaseToken">,
  /** What the handler reported doing — counts, or the refusal that says it
   *  could not. Written here, on the same lease-guarded update that marks the
   *  job done, so a receipt can never outlive the row it describes or be
   *  attributed to a job someone else re-claimed. */
  result?: JobResultValue | null,
): Promise<void> {
  const updated = await db
    .update(jobs)
    .set({
      status: "done",
      lockedAt: null,
      leaseToken: null,
      updatedAt: Date.now(),
      ...(result === undefined ? {} : { result }),
    })
    .where(ownedBy(job))
    .returning({ id: jobs.id });
  if (updated.length === 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[queue] completeJob(${job.id}) skipped: lease no longer held (reaped or re-claimed)`,
    );
  }
}

/**
 * Extend a running job's lease (the continuous worker's heartbeat for jobs that
 * legitimately run past LEASE_MS). Token-guarded: a reaped job stops being
 * extendable, so a zombie worker can't keep a stolen lease alive.
 */
export async function extendLease(
  db: BaseDb = baseDb,
  job: Pick<Job, "id" | "leaseToken">,
  now: number = Date.now(),
): Promise<boolean> {
  const updated = await db
    .update(jobs)
    .set({ lockedAt: now, updatedAt: now })
    .where(and(ownedBy(job), eq(jobs.status, "running")))
    .returning({ id: jobs.id });
  return updated.length > 0;
}

function backoffMs(attempts: number): number {
  const base = Math.min(MAX_BACKOFF_MS, Math.pow(2, attempts) * 30_000);
  const jitter = base * (0.5 + Math.random()); // 0.5x..1.5x
  return Math.min(MAX_BACKOFF_MS, Math.round(jitter));
}

/**
 * Handle a failed/rescheduled job: backoff + requeue, or dead-letter (via the
 * shared `failedAttemptUpdate`). Token-guarded like completeJob: if the lease was
 * reaped, the reaper has ALREADY recorded a failed attempt for this run — writing
 * another would double-count it (and could stomp a re-claimed run's state).
 */
export async function failJob(
  db: BaseDb = baseDb,
  job: Job,
  error: string,
  opts?: {
    retryAt?: number;
    countAttempt?: boolean;
    /** A reschedule's receipt — the refusal behind it, or null when the hold
     *  is the account's own pacing. Written on every reschedule so the row
     *  says what the LATEST attempt found: a refusal that cleared must not
     *  outlive the attempt that saw it. Ignored when the attempt counts. */
    result?: JobResultValue | null;
  },
): Promise<void> {
  const countAttempt = opts?.countAttempt ?? true;
  const now = Date.now();

  const set = countAttempt
    ? failedAttemptUpdate(job, error, now, opts?.retryAt)
    : // A reschedule is not a failure: no attempt counted, never dead-letters.
      {
        status: "queued" as const,
        lastError: error,
        lockedAt: null,
        leaseToken: null,
        nextRunAt: opts?.retryAt ?? now + backoffMs(job.attempts),
        updatedAt: now,
        ...(opts?.result === undefined ? {} : { result: opts.result }),
      };
  const updated = await db
    .update(jobs)
    .set(set)
    .where(ownedBy(job))
    .returning({ id: jobs.id });
  if (updated.length === 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[queue] failJob(${job.id}) skipped: lease no longer held (reaped or re-claimed)`,
    );
  }
}

/**
 * Hand a job whose process is gone back to the queue now, rather than once its
 * lease ages past `LEASE_MS`: the attempt is counted exactly as the lease
 * reaper counts it, so a job that takes its process down with it still
 * dead-letters, and otherwise it is due at once. Only a job last claimed or
 * heartbeaten before `before`, which the caller vouches no live process can
 * have done (`releaseRunsLeftRunning`). Locked and decided like the reaper's
 * rows, and the lease token is cleared, so a late completion of the old claim
 * writes nothing. Says where the job went, or null when it was not abandoned.
 */
export async function requeueAbandonedJob(
  tx: Tx,
  input: { organizationId: string; jobId: number; before: number; now: number; error: string },
): Promise<"queued" | "dead" | null> {
  const abandoned = and(
    eq(jobs.id, input.jobId),
    eq(jobs.organizationId, input.organizationId),
    eq(jobs.status, "running"),
    lt(jobs.lockedAt, input.before),
  );
  const [job] = await tx.select().from(jobs).where(abandoned).for("update", { skipLocked: true });
  if (!job) return null;
  const update = failedAttemptUpdate(job, input.error, input.now, input.now);
  await tx.update(jobs).set(update).where(abandoned);
  return update.status === "dead" ? "dead" : "queued";
}
