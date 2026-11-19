import {
  StrategyActivationError,
  activateStrategy,
} from "../../strategy/activate";
import type { HandlerCtx } from "../context";
import type { JobResult } from "../worker";

export type ActivateStrategyPayload = { campaignId: number; version: number };

/**
 * A strategy version whose `effective_at` arrived: activated now, through
 * the same validation and projection an immediate activation takes.
 *
 * A refusal is an answer, not a fault to retry. The campaign may have left its
 * strategy, or a newer version may have activated meanwhile; either way the
 * version must not activate, and the job's result says which code said no. A
 * version whose base was replaced before its instant is an answer too: it is
 * left `pending_review`, which this job's commit is what records.
 */
export async function handleActivateStrategy(
  ctx: HandlerCtx,
  payload: ActivateStrategyPayload,
): Promise<JobResult> {
  try {
    const outcome = await activateStrategy(ctx.db, payload);
    if (outcome.status === "conflict") return { strategy_conflict: 1 };
    return outcome.status === "active" ? { activated: 1 } : { scheduled: 1 };
  } catch (error) {
    if (error instanceof StrategyActivationError) return { [error.code]: 1 };
    throw error;
  }
}
