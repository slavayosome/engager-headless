import { foldNoAnswer } from "../../leads/lifecycle";
import { leadsEnabled } from "../../leads/gate";
import type { HandlerCtx } from "../context";

/** The daily fold of Find leads people nobody answered into No answer. It
 *  reads no LinkedIn and calls no model: one UPDATE over rows already stored. */
export async function handleLeadLifecycle(ctx: HandlerCtx, payload: { now?: number }): Promise<void> {
  if (!(await leadsEnabled(ctx.db))) return;
  await foldNoAnswer(ctx.db, payload.now ?? Date.now());
}
