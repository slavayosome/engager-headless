import type { Capability } from "./capabilities";

/** Offer identifiers used in persisted account records and signed device claims. */
export type OfferId = "mac_monthly_v1" | "cloud_monthly_v1";

export type Offer = {
  id: OfferId;
  name: string;
  interval: "month";
  quantity: 1;
  /** Every service this offer buys. Order is display order, not precedence. */
  capabilities: readonly Exclude<Capability, "core_local">[];
  /** Env var naming this offer's Stripe Price id, resolved at CALL time so
   * price→offer mapping stays testable and rotatable. */
  priceEnv: string;
};

/** Registered Macs one paid account may hold at once. Both offers carry the
 * same one seat: cloud includes Mac, so buying cloud never costs a seat. */
export const MAC_SEATS_PER_ACCOUNT = 1;

export const ENGAGER_OFFERS: Readonly<Record<OfferId, Offer>> = {
  mac_monthly_v1: {
    id: "mac_monthly_v1",
    name: "On your Mac",
    interval: "month",
    quantity: 1,
    capabilities: ["desktop_managed"],
    priceEnv: "STRIPE_PRICE_MAC_MONTHLY",
  },
  cloud_monthly_v1: {
    id: "cloud_monthly_v1",
    name: "In cloud",
    interval: "month",
    quantity: 1,
    capabilities: ["desktop_managed"],
    priceEnv: "STRIPE_PRICE_CLOUD_MONTHLY",
  },
};

export const OFFER_IDS = Object.keys(ENGAGER_OFFERS) as readonly OfferId[];

export function isOfferId(value: string | null | undefined): value is OfferId {
  return value != null && Object.hasOwn(ENGAGER_OFFERS, value);
}

/** The configured Stripe Price id for one offer, or undefined when this
 * deployment has not configured it. Read from env at call time. */
export function offerPriceId(offerId: OfferId): string | undefined {
  // Trimmed, so a whitespace-only value is MISSING here exactly as it is to
  // `offerPriceEnvFailure` — one definition of unset, or a deployment could
  // pass the readiness check and still match no price.
  return process.env[ENGAGER_OFFERS[offerId].priceEnv]?.trim() || undefined;
}

/** The immutable provenance a subscription row freezes at projection time, in
 * the terms Stripe reported on the item. A later env rotation cannot
 * re-interpret it, and a row without it grants nothing — which is exactly
 * what every historical row looks like. */
export type OfferProvenance = {
  offerId: OfferId;
  priceId: string;
  unitAmount: number;
  currency: string;
  interval: "month";
  quantity: 1;
};

/** Which capabilities an offer buys. An unknown offer buys nothing. */
export function offerCapabilities(
  offerId: string | null | undefined,
): readonly Exclude<Capability, "core_local">[] {
  return isOfferId(offerId) ? ENGAGER_OFFERS[offerId].capabilities : [];
}
