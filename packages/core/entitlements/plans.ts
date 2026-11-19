import type { Tx } from "@engager/database/tenant";
import { OFFER_IDS, offerPriceId, type OfferId } from "./offer";
import { commercialProjection } from "./projection";

const planKeys: Record<OfferId, string> = { mac_monthly_v1: "mac", cloud_monthly_v1: "cloud" };

/** Preserve the setup status fields for callers with existing account data. */
export async function accountPlanKey(tx: Tx, organizationId: string): Promise<string> {
  const projection = await commercialProjection(tx, organizationId);
  return projection.capabilities.length && projection.offerId ? planKeys[projection.offerId] : "none";
}

export function checkoutConfigured(): boolean {
  return OFFER_IDS.some((id) => offerPriceId(id) !== undefined);
}
