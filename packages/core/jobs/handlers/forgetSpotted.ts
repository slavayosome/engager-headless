import { track } from "@engager/observability/analytics";
import { forgetSpotted } from "../../rooms/retention";
import { afterCommitOrNow } from "../../telemetry/emit";
import type { HandlerCtx } from "../context";

/** Database-only retention also runs while product work is paused. */
export async function handleForgetSpotted(ctx: HandlerCtx, payload: { now?: number }): Promise<void> {
  const result = await forgetSpotted(ctx.db, payload.now ?? Date.now());
  afterCommitOrNow(ctx.db, () => track("spotted_forgotten", { count: result.people }));
}
