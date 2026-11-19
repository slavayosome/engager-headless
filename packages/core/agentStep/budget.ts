import type { StrategyStep } from "../strategy/contract";

/**
 * A wake's budgets (spec §04 "Budgets and exits", §08 "bounded loops") as
 * arithmetic on what the server spent. Pure.
 *
 * Four limits per step per wake, each from the step's strategy: model
 * calls, dispatched tool actions, wall time and tokens. Iterations, time and
 * tokens are checked BEFORE a model call — a call over any of them is never
 * made. Tool actions are admitted per call: a call past the limit is
 * discarded and the step ends `budget_exhausted` once its admitted calls are
 * done. A crashed wake's spend carries into the wake that adopts its
 * checkpoint, so a crash cannot buy a fresh budget.
 */

export type StepBudget = StrategyStep["budget"];

export type BudgetSpent = {
  iterations: number;
  toolActions: number;
  elapsedMs: number;
  tokens: number;
};

export type BudgetTrip = "iterations" | "elapsed" | "tokens";

/** The limit a next model call would cross, or null when it may be made. */
export function tripBeforeCall(budget: StepBudget, spent: BudgetSpent): BudgetTrip | null {
  if (spent.iterations >= budget.iterations_per_wake) return "iterations";
  if (spent.elapsedMs >= budget.elapsed_seconds_per_wake * 1_000) return "elapsed";
  if (spent.tokens >= budget.tokens_per_wake) return "tokens";
  return null;
}

/** How many more tool calls this wake may dispatch. */
export function remainingActions(budget: StepBudget, spent: BudgetSpent): number {
  return Math.max(0, budget.tool_actions_per_wake - spent.toolActions);
}

/**
 * The server's estimate of the tokens a call spent: a quarter of the UTF-8
 * bytes it sent and received, rounded up. An estimate it computes from text it
 * holds, never a count a model or a CLI reported (INV-2).
 */
export function estimateTokens(...texts: string[]): number {
  const bytes = texts.reduce((sum, text) => sum + Buffer.byteLength(text, "utf8"), 0);
  return Math.ceil(bytes / 4);
}

/** Consecutive iterations that dispatched nothing they proposed before the
 *  step's `on_no_progress` decides. One is a correction the step may make;
 *  two is a plan going round. */
export const NO_PROGRESS_LIMIT = 2;

/**
 * Whether an iteration moved the step, and whether the run of iterations that
 * did not has reached the limit. An iteration that proposed nothing is not a
 * no-progress one: it is the step's last word, and the loop ends on its
 * status.
 */
export function progressAfter(
  iteration: { proposed: number; dispatched: number },
  streak: number,
): { streak: number; stalled: boolean } {
  if (iteration.proposed === 0 || iteration.dispatched > 0) {
    return { streak: 0, stalled: false };
  }
  const next = streak + 1;
  return { streak: next, stalled: next >= NO_PROGRESS_LIMIT };
}
