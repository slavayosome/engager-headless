import { inArray } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import { campaigns } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";

/**
 * WHO MAY WRITE WHAT A STRATEGY OWNS.
 *
 * A campaign's worker switches and `verifyStage` are projections of its
 * active strategy, and its workers' wake is a projection
 * of its Active/Paused status (INV-25, `project.ts`). Older writers refuse
 * changes to these projections. The owner changes the strategy or pauses the
 * campaign; Start remains the owner's action in Engager.
 */

/** A step switch, Research or the like after a comment, written by an old
 *  writer on a campaign whose strategy writes it. */
export class StrategyOwnsSwitchError extends AppError {
  readonly recovery =
    "Nothing was written. Read the strategy with get_campaign and change it with patch_strategy: a narrowing lands at once, a widening waits for the owner's confirmation.";

  constructor() {
    super(
      "agentic_workflow_on",
      "This campaign runs on its strategy: its workers' steps, Research and its Like post are written only by activating a strategy version.",
      409,
    );
  }
}

/** A switch that would put Find posts into a campaign that finds leads: a
 *  Find posts switch or its Research on such a campaign. Its search depth
 *  moves Find leads' own reads (`setSearchDepth`). */
export class FindPostsRetiredError extends AppError {
  readonly recovery =
    "Nothing was written. This campaign's Scout finds leads, so Find posts and its Research are not its to switch; its search depth (quick, standard or deep) sets how far Scout carries a person.";

  constructor() {
    super("find_posts_retired", "Find posts is no longer offered. This campaign finds leads.", 409);
  }
}

/** A worker's `auto`: the wake is the campaign's status. */
export class WakeIsCampaignStatusError extends AppError {
  readonly recovery =
    "Nothing was written. The owner starts the campaign in Engager; save_campaign can pause it. Run now works either way.";

  constructor() {
    super(
      "wake_is_campaign_status",
      "This campaign runs on its strategy, so whether the server wakes its workers is the campaign's Active or Paused, not a per-worker Auto.",
      409,
    );
  }
}

/** Whether any of these campaigns exists. */
export async function runsOnStrategy(
  tx: Tx,
  campaignIds: ReadonlyArray<number | null | undefined>,
): Promise<boolean> {
  const ids = campaignIds.filter((id): id is number => id != null);
  if (ids.length === 0) return false;
  const [found] = await tx
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(inArray(campaigns.id, ids))
    .limit(1);
  return found !== undefined;
}

/** What a call WOULD write — a field the caller named, not a value it
 *  changes: re-sending what is stored is still a second writer. */
export type StrategyOwnedWrites = { switches: boolean; wake: boolean };

/**
 * The refusal for a call already known to touch a campaign that runs on its
 * strategy. A call naming both is answered with the switch refusal, the one
 * the strategy can take over; the wake refusal stays a refusal for good.
 */
export function assertNotStrategyOwned(writes: StrategyOwnedWrites): void {
  if (writes.switches) throw new StrategyOwnsSwitchError();
  if (writes.wake) throw new WakeIsCampaignStatusError();
}

/** Refuse a write of what the strategy owns, before anything is written. */
export async function refuseStrategyOwnedWrite(
  tx: Tx,
  campaignIds: ReadonlyArray<number | null | undefined>,
  writes: StrategyOwnedWrites,
): Promise<void> {
  if (!writes.switches && !writes.wake) return;
  if (await runsOnStrategy(tx, campaignIds)) assertNotStrategyOwned(writes);
}
