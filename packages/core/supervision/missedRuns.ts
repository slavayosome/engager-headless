import { and, desc, eq, gte, inArray, isNull, lt, lte, notExists, sql } from "drizzle-orm";
import {
  workerRuns,
  jobs,
  supervisionEvents,
  workerMissedRuns,
  type Channel,
  type WorkerMissedRunRow,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { withinActiveWindow } from "../time";
import { effectiveDailyCommentCap } from "../ratelimit/ledger";
import { anchorsInRange, commentFloorGapMs } from "../operations/schedule";

/**
 * WHAT THE MACHINE SLEPT THROUGH — recorded, never replayed (ADR-08).
 *
 * The coalescing itself is already a property of how a wake is armed: a worker
 * carries ONE `nextRunAt`, the scheduler keys its enqueue on that exact wake,
 * and `reArmedWake` advances it after the run. Ten hours of sleep therefore
 * produce one job and not one per missed tick, whatever this module does. What
 * this module adds is the part that was missing: saying HOW MANY slots went
 * unserved and WHY, so "Missed runs are summarized by worker and time" (J6) is
 * a read of rows rather than a shrug.
 *
 * Nothing here enqueues anything. It is deliberately called with the workers
 * the scheduler has ALREADY enqueued, and it returns only the record it
 * wrote — a consumer that tried to turn these rows back into work would be
 * building the catch-up burst the design exists to prevent.
 */

/** How overdue a wake must be before the gap counts as a miss rather than as
 *  ordinary tick jitter. Two scheduler periods: one tick late is the scheduler
 *  working, three is the machine having been away. */
export const MISSED_RUN_THRESHOLD_MS = 10 * 60_000;

export type MissedRunCause = WorkerMissedRunRow["cause"];

/**
 * Whether the machine was asleep at any point in `[from, to]`, from the
 * supervision HISTORY.
 *
 * The history is where the evidence actually survives. `supervision_state`
 * carries `sleepingSince` only while the sleep is open, and the wake clears it
 * before any scheduler tick runs — while it is set the state is `paused` and the
 * scheduler returns before a missed run is recorded at all. So a cause read from
 * that column can never say `sleep` about a gap a machine really slept through.
 * The `slept` and `woke` rows are append-only and still there afterwards.
 *
 * Two shapes count, and between them they cover every overlap: a sleep or a
 * wake recorded INSIDE the gap, and — for a machine that was already asleep
 * before the wake it missed and woke after it — the latest of the two before the
 * gap being a `slept`.
 */
export async function sleptDuringGap(
  tx: Tx,
  input: { organizationId: string; from: number; to: number },
): Promise<boolean> {
  const inside = await tx
    .select({ reason: supervisionEvents.reason })
    .from(supervisionEvents)
    .where(
      and(
        eq(supervisionEvents.organizationId, input.organizationId),
        inArray(supervisionEvents.reason, ["slept", "woke"]),
        gte(supervisionEvents.at, input.from),
        lte(supervisionEvents.at, input.to),
      ),
    )
    .limit(1);
  if (inside.length > 0) return true;
  const [before] = await tx
    .select({ reason: supervisionEvents.reason })
    .from(supervisionEvents)
    .where(
      and(
        eq(supervisionEvents.organizationId, input.organizationId),
        inArray(supervisionEvents.reason, ["slept", "woke"]),
        lt(supervisionEvents.at, input.from),
      ),
    )
    .orderBy(desc(supervisionEvents.at), desc(supervisionEvents.id))
    .limit(1);
  return before?.reason === "slept";
}

/**
 * Whether an overdue wake is a MISSED one — a gap there is evidence for, rather
 * than a run still waiting its turn.
 *
 * Overdue alone proves nothing: a wake stays due until its run re-arms it, and
 * that is after the work, so a run queued behind a busy lane — the first sweep
 * a start queues ahead of every worker it arms — is overdue on a machine that
 * was up the whole time. Two things are evidence:
 *
 * - **the runtime was away inside the gap.** Asleep (`sleptDuringGap`), or
 *   down and back: a runtime that stops renewing for longer than its lease
 *   records a start on the first renewal back (`renewSupervision`), and a
 *   supervised one records its own exits and restarts. Whether this tick or an
 *   earlier one enqueued the run is beside the point — a run queued and then
 *   slept through for hours was missed all the same;
 * - **the wake's run is dead.** A dead-lettered job holds the wake's key for
 *   good, so nothing will ever serve that wake.
 */
export async function wakeWentUnserved(
  tx: Tx,
  input: {
    organizationId: string;
    /** The key the scheduler enqueued the wake's run under. */
    idempotencyKey: string;
    from: number;
    to: number;
  },
): Promise<boolean> {
  if (input.to - input.from < MISSED_RUN_THRESHOLD_MS) return false;
  if (await sleptDuringGap(tx, input)) return true;
  const [restart] = await tx
    .select({ id: supervisionEvents.id })
    .from(supervisionEvents)
    .where(
      and(
        eq(supervisionEvents.organizationId, input.organizationId),
        inArray(supervisionEvents.reason, ["started", "restarted", "child_exited"]),
        gte(supervisionEvents.at, input.from),
        lte(supervisionEvents.at, input.to),
      ),
    )
    .limit(1);
  if (restart) return true;
  // The queue is not tenant-scoped, so the org is named explicitly.
  const [run] = await tx
    .select({ status: jobs.status })
    .from(jobs)
    .where(
      and(
        eq(jobs.organizationId, input.organizationId),
        eq(jobs.idempotencyKey, input.idempotencyKey),
      ),
    );
  return run?.status === "dead";
}

/**
 * Why the wakes were missed, as far as this install can honestly say.
 *
 * - `sleep` — the supervision history has the machine asleep inside the gap.
 *   This is the only cause with direct evidence behind it.
 * - `clock_change` — the wake was armed for an instant the account's CURRENT
 *   plan does not consider open at all. A DST shift or an edited timezone /
 *   active-hours setting moved the window out from under an armed wake; the
 *   machine may well have been running the whole time.
 * - `downtime` — neither: nothing served the wake, whether the process was
 *   gone or its queue was not moving.
 */
export function missedRunCause(input: {
  missedFrom: number;
  channel: Pick<Channel, "activeHours" | "activeDays">;
  /** From `sleptDuringGap`: whether the supervision history has this machine
   *  asleep at any point in the gap. */
  sleptDuringGap: boolean;
  now: number;
}): MissedRunCause {
  if (input.sleptDuringGap) return "sleep";
  return withinActiveWindow(
    input.missedFrom,
    input.channel.activeHours,
    input.channel.activeDays,
  ).within
    ? "downtime"
    : "clock_change";
}

/**
 * How many of the account's own day-plan slots elapsed unserved in the gap.
 *
 * The plan walker is the SAME one the wake is derived from and the same one
 * `assignSlots` consumes, so a DST shift or a timezone edit is accounted for by
 * construction: the anchors it yields for a range are the anchors that range
 * actually had, in the account's own local days. Counting elapsed milliseconds
 * instead would report a nine-hour night as nine missed hourly slots on an
 * account whose window is closed for eight of them.
 *
 * At least one, whenever the gap crossed the threshold at all: a wake that came
 * and went is one thing missed even when the plan places no anchor beside it.
 */
export function missedAnchorCount(input: {
  channel: Channel;
  missedFrom: number;
  now: number;
}): number {
  const anchors = anchorsInRange(input.channel, {
    from: input.missedFrom,
    to: input.now,
    effDaily: effectiveDailyCommentCap(input.channel, input.missedFrom),
    floorGapMs: commentFloorGapMs(input.channel),
  });
  return Math.max(1, anchors.length);
}

export type MissedRunRecord = {
  workerId: number;
  missedFrom: number;
  missedCount: number;
  cause: MissedRunCause;
  /** The single coalesced wake this gap produced, or null when the worker was
   *  not re-armed. Written by the caller that owns the re-arm. */
  coalescedRunAt: number | null;
};

/**
 * Record one worker's gap — one `wakeWentUnserved` has found evidence for.
 * Idempotent on `(worker, missedFrom)`: a second tick observing the same gap
 * refreshes the count and the observation time in place rather than minting a
 * second row, so the number an owner reads is "slots missed", not "ticks that
 * noticed".
 */
export async function recordMissedRun(
  tx: Tx,
  input: {
    organizationId: string;
    workerId: number;
    missedFrom: number;
    channel: Channel;
    now: number;
  },
): Promise<MissedRunRecord | null> {
  if (input.now - input.missedFrom < MISSED_RUN_THRESHOLD_MS) return null;
  const missedCount = missedAnchorCount(input);
  const cause = missedRunCause({
    ...input,
    sleptDuringGap: await sleptDuringGap(tx, {
      organizationId: input.organizationId,
      from: input.missedFrom,
      to: input.now,
    }),
  });
  await tx
    .insert(workerMissedRuns)
    .values({
      organizationId: input.organizationId,
      workerId: input.workerId,
      missedFrom: input.missedFrom,
      observedAt: input.now,
      missedCount,
      cause,
      coalescedRunAt: null,
    })
    .onConflictDoUpdate({
      target: [
        workerMissedRuns.organizationId,
        workerMissedRuns.workerId,
        workerMissedRuns.missedFrom,
      ],
      set: { observedAt: input.now, missedCount, cause },
    });
  return {
    workerId: input.workerId,
    missedFrom: input.missedFrom,
    missedCount,
    cause,
    coalescedRunAt: null,
  };
}

/** Name the one run the gap produced, once the caller that re-armed the worker
 *  knows what it is. Separate from the record above because the wake is decided
 *  by the run handler's `reArmedWake`, long after the gap was observed. */
export async function noteCoalescedRun(
  tx: Tx,
  input: {
    organizationId: string;
    workerId: number;
    missedFrom: number;
    coalescedRunAt: number;
  },
): Promise<void> {
  await tx
    .update(workerMissedRuns)
    .set({ coalescedRunAt: input.coalescedRunAt })
    .where(
      and(
        eq(workerMissedRuns.organizationId, input.organizationId),
        eq(workerMissedRuns.workerId, input.workerId),
        eq(workerMissedRuns.missedFrom, input.missedFrom),
        sql`${workerMissedRuns.coalescedRunAt} is null`,
      ),
    );
}

/** How long a miss stays something wrong. A night the Mac slept is news the
 *  next morning; a week later it is history, and the alert is not a history. */
export const MISSED_RUN_RECENT_MS = 24 * 60 * 60_000;

/**
 * The misses that are still something wrong: observed in the last day, not
 * dismissed by the owner, and not followed by a run of the same worker that
 * succeeded.
 *
 * RESOLVED IS A FACT ABOUT THE WORKER, not about the record. A miss says this
 * worker's schedule did not fire; a later run of it that succeeded says it
 * fires again, and from then on the miss is history rather than news. Read off
 * the run rows at the moment of asking, so nothing has to remember to clear a
 * record — and the records themselves are kept, untouched, for what they are.
 */
export async function listMissedRuns(
  tx: Tx,
  organizationId: string,
  opts: { now: number; limit?: number },
): Promise<WorkerMissedRunRow[]> {
  return tx
    .select()
    .from(workerMissedRuns)
    .where(
      and(
        eq(workerMissedRuns.organizationId, organizationId),
        isNull(workerMissedRuns.dismissedAt),
        gte(workerMissedRuns.observedAt, opts.now - MISSED_RUN_RECENT_MS),
        notExists(
          tx
            .select({ id: workerRuns.id })
            .from(workerRuns)
            .where(
              and(
                eq(workerRuns.organizationId, workerMissedRuns.organizationId),
                eq(workerRuns.workerId, workerMissedRuns.workerId),
                eq(workerRuns.status, "succeeded"),
                gte(workerRuns.startedAt, workerMissedRuns.missedFrom),
              ),
            ),
        ),
      ),
    )
    .orderBy(desc(workerMissedRuns.observedAt), desc(workerMissedRuns.id))
    .limit(opts.limit ?? 20);
}

/**
 * The owner dismissing misses from the alert, one record each. Only the
 * records named, and each once: a later miss is a new record and shows again.
 * The owner's own surface calls this; no agent tool does.
 */
export async function dismissMissedRuns(
  tx: Tx,
  organizationId: string,
  ids: readonly number[],
  now: number,
): Promise<void> {
  if (ids.length === 0) return;
  await tx
    .update(workerMissedRuns)
    .set({ dismissedAt: now })
    .where(
      and(
        eq(workerMissedRuns.organizationId, organizationId),
        inArray(workerMissedRuns.id, [...ids]),
        isNull(workerMissedRuns.dismissedAt),
      ),
    );
}
