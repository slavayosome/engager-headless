import { subscriptions } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import {
  ENGAGER_OFFERS,
  OFFER_IDS,
  offerForPriceId,
  offerPriceId,
  type OfferId,
} from "./offer";
import { commercialProjection } from "./projection";

/**
 * Plan tiers — the display and feature-flag face of the offer catalogue. Since
 * P4 the CATALOGUE in `./offer.ts` is the only thing that maps a provider price
 * to a product, and `./projection.ts` is the only thing that decides whether an
 * organization currently holds one. This module adds no authority of its own:
 * it names the tiers those two answer with.
 *
 * Deliberately gone with P4: the legacy price-id aliases, the yearly slot, and
 * the fallback that read any unknown active price as Pro. All three were ways
 * for a row nobody catalogued to grant service (TIER-11).
 */
export type BillingInterval = "monthly" | "yearly";

export type PlanTier = {
  key: string;
  name: string;
  /**
   * Feature entitlements. Every gated surface routes through ONE predicate per
   * feature (e.g. `leadsEnabled` in core) so introducing a higher tier later is
   * a catalog edit here — flip the flag per plan — with zero feature-code
   * changes. `leads` is on for every plan today (single-tenant posture).
   */
  features?: { leads?: boolean };
};

/** The absence of an active paid offer. There is no free plan. */
export const NO_PLAN: PlanTier = {
  key: "none",
  name: "No active subscription",
  features: { leads: true },
};

const OFFER_PLANS: Readonly<Record<OfferId, PlanTier>> = {
  mac_monthly_v1: {
    key: "mac",
    name: ENGAGER_OFFERS.mac_monthly_v1.name,
    features: { leads: true },
  },
  cloud_monthly_v1: {
    key: "cloud",
    name: ENGAGER_OFFERS.cloud_monthly_v1.name,
    features: { leads: true },
  },
};

export const PLANS: PlanTier[] = [
  NO_PLAN,
  ...OFFER_IDS.map((id) => OFFER_PLANS[id]),
];

export function planForOffer(offerId: OfferId | null | undefined): PlanTier {
  return offerId ? OFFER_PLANS[offerId] : NO_PLAN;
}

/** Resolve a plan from a Stripe price id. An id outside the catalogue is not a
 * product: there is no fallback tier, by decision. */
export function planForPriceId(priceId: string | undefined): PlanTier {
  return planForOffer(offerForPriceId(priceId)?.id);
}

/** Whether this price id is one Engager sells today. The one place product
 * provenance is decided; a customer id, a status or a stored row is not it. */
export function isEngagerPriceId(priceId: string | undefined): boolean {
  return offerForPriceId(priceId) != null;
}

/** Immutable product authority frozen into the canonical subscription item.
 * One subscription buys exactly one Engager offer at quantity one. Missing
 * authority, mixed baskets, and quantity drift deliberately fail closed so
 * pre-cutover or provider-mutated rows cannot inherit access from status alone. */
export function hasEngagerPriceAuthority(
  items: (typeof subscriptions.$inferSelect)["items"],
): boolean {
  const item = items?.length === 1 ? items[0] : undefined;
  return item?.quantity === 1 && item.priceAuthorized === true;
}

/** Every offer is monthly. An id outside the catalogue has no interval. */
export function intervalForPriceId(
  priceId: string | undefined,
): BillingInterval | undefined {
  return isEngagerPriceId(priceId) ? "monthly" : undefined;
}

/** True when at least one offer has a configured provider price. */
export function checkoutConfigured(): boolean {
  return OFFER_IDS.some((id) => offerPriceId(id) !== undefined);
}

/**
 * The org's current plan tier, read from the ONE commercial projection. A
 * historical Pro row, a comp trial and an unrecognized active price all answer
 * `free`: they remain readable and they grant nothing.
 */
export async function getOrgPlan(
  tx: Tx,
  organizationId: string,
  opts: { now?: number } = {},
): Promise<PlanTier> {
  const projection = await commercialProjection(tx, organizationId, opts);
  return projection.capabilities.length > 0
    ? planForOffer(projection.offerId)
    : NO_PLAN;
}
