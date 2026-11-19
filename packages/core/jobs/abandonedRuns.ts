/**
 * How long a worker run may hold its channel, and what each of the two paths
 * that close a run its process left running writes on it, alone in a leaf
 * module so the dashboard words those rows from the same strings core writes
 * without importing the handler.
 */

/** Long enough for a sweep plus two model calls, short enough that a crashed
 *  run self-heals within one cadence. Renewed before every phase. */
export const RUN_LEASE_MS = 20 * 60_000;

/** Hard wall-clock stop. Past this the run closes cleanly as failed with its
 *  phase recorded, instead of holding the campaign until the lease lapses. */
export const RUN_BUDGET_MS = 15 * 60_000;

/** A run cannot legitimately outlive the lease it renews plus the budget it
 *  stops itself at, so one still `running` past the sum is reaped. */
export const ABANDONED_RUN_AFTER_MS = RUN_LEASE_MS + RUN_BUDGET_MS;

/** What the abandoned-run reaper writes on a run it closes `failed`. */
export const REAPED_RUN_NOTE = "reaped: exceeded lease TTL + wall-clock budget";

/** What a run closed `interrupted` as the local runtime starts again after a
 *  quit says, on its row and its job's (`releaseRunsLeftRunning`). */
export const QUIT_MID_RUN_NOTE = "Engager quit mid-run";
