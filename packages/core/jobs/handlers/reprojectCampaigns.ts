import {
  StrategyActivationError,
  activateStrategy,
  inForceOnChannel,
} from "../../strategy/activate";
import type { ReprojectCampaignsPayload } from "../../liveChecks/flow";
import type { HandlerCtx } from "../context";
import type { JobResult } from "../worker";

/**
 * Worker handler for `reproject_campaigns`: every flagged campaign on an
 * account activated again in place, after a write was verified — by its
 * first send or a check — or its record cleared (`liveChecks/`), so what its
 * projection writes resolves through the account's records now rather than
 * at its next version.
 *
 * Re-activating the version in force writes no new version and changes no
 * mode; a campaign whose activation refuses (it left its strategy since,
 * say) is counted and left as it is, and the rest go on.
 */
export async function handleReprojectCampaigns(
  ctx: HandlerCtx,
  payload: ReprojectCampaignsPayload,
): Promise<JobResult> {
  let reprojected = 0;
  let refused = 0;
  for (const row of await inForceOnChannel(ctx.db, payload.channelId)) {
    try {
      await activateStrategy(ctx.db, row);
      reprojected += 1;
    } catch (error) {
      if (!(error instanceof StrategyActivationError)) throw error;
      refused += 1;
    }
  }
  return { reprojected, refused };
}
