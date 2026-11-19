import { AppError } from "@engager/common/errors";
import type { Tx } from "@engager/database/tenant";
import { applyStrategyPatch, startPatchFor, type StrategyPatch } from "../strategy/patch";
import { submitStrategyPatch } from "../strategy/submit";
import { getCampaign } from "./campaigns";

/** Start is an owner action. Widening still waits for the owner's confirmation. */
export function startCampaign(tx: Tx, campaignId: number, version: number, options: { approver: string; now: number; instruction: string; confirmed: true; patch?: StrategyPatch }): Promise<{ confirmed: true; result: Awaited<ReturnType<typeof applyStrategyPatch>> }>;
export function startCampaign(tx: Tx, campaignId: number, version: number, options: { approver: string; now: number; instruction: string; confirmed?: false }): ReturnType<typeof submitStrategyPatch>;
export async function startCampaign(
  tx: Tx,
  campaignId: number,
  version: number,
  options: { approver: string; now: number; instruction: string; confirmed?: boolean; patch?: StrategyPatch },
) {
  const campaign = await getCampaign(tx, campaignId);
  if (!campaign) throw new AppError("campaign_not_found", `campaign ${campaignId} not found`, 404);
  if (options.confirmed) {
    const patch = options.patch ?? startPatchFor(campaignId, version, options.instruction);
    if (patch.campaignId !== campaignId || patch.expectedBaseVersion !== version) throw new AppError("invalid_start", "Start does not match this campaign and version.", 400);
    return { confirmed: true as const, result: await applyStrategyPatch(tx, patch, { approver: options.approver, now: options.now }) };
  }
  return submitStrategyPatch(tx, campaign.organizationId, startPatchFor(campaignId, version, options.instruction), {
    approver: options.approver, now: options.now, draft: false,
  });
}
