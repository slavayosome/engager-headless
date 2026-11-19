/**
 * The drain's wall-clock arithmetic, alone in a leaf module so that validating
 * a caller's budget costs nothing but this file.
 *
 * `worker.ts` reaches every job handler and through them the commercial
 * projection, which the free interactive bundle may not carry
 * (`build.e2e.test.ts` asserts a licence-free `dist/mcp.mjs`). A surface that
 * only needs to REFUSE an impossible budget should not have to import an
 * engine to do it, so the numbers live here and `worker.ts` imports them back.
 */

/** How long a timed-out job gets to unwind after its budget signal fires, before
 *  phase-2 bookkeeping proceeds anyway. Signal-bound LLM calls cancel near-instantly;
 *  this covers the tail (a non-LLM await mid-flight). Kept small — it eats into the
 *  drain's hard-deadline grace. */
export const ABORT_SETTLE_MS = 5_000;

/** Margin reserved before the platform's hard kill: the abort-settle window plus
 *  phase-2 bookkeeping. A job's effective budget never extends into it. */
export const HARD_KILL_GRACE_MS = ABORT_SETTLE_MS + 3_000;

/** Don't bother claiming a job with less usable budget than this — even a trivial
 *  job needs time to claim, run, and record its outcome. */
export const MIN_CLAIM_BUDGET_MS = 3_000;

/** The longest wall-clock budget a drain outside the continuous worker may be
 *  handed (`core-command run`), and so the longest a job it claims can run. */
export const MAX_DRAIN_MS = 60_000;

/** The shortest wall-clock budget worth handing a drain. Below the grace margin
 *  plus the claim floor the loop exits before claiming anything, and its honest
 *  `{ processed: 0 }` is indistinguishable from an empty queue — so a caller
 *  that takes a budget from a person validates it against this first. The extra
 *  second is what makes the floor usable rather than merely arithmetic: the
 *  caller stamps `hardDeadlineMs` before that loop reads the clock for the
 *  first time, so at exactly the sum a single elapsed millisecond puts the
 *  runway back under the claim floor and returns that same hollow zero — and
 *  the job that is claimed gets a budget above the floor, not equal to it. */
export const MIN_DRAIN_MS = HARD_KILL_GRACE_MS + MIN_CLAIM_BUDGET_MS + 1_000;
