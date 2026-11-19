import { formatMoney } from "@engager/common/money";
import type { CheckoutPriceTerms } from "./client";
import type { Capability } from "./capabilities";

/** The two offers Engager sells, and the only offers that grant a new-tier
 * capability. Quantity is one; the interval is monthly. There is no separate trial
 * offer, yearly cadence, comp grant or legacy alias — a Mac trial is a
 * provider status on one of these same offers, and it grants only with a
 * card on file, to the trial's last instant (`./webhooks`, `./projection`).
 * A price this catalog does not name grants nothing however active the
 * provider says its subscription is (TIER-11).
 *
 * Money is NOT catalogued here. The amount and currency live on the Stripe
 * Price the deployment's env names, and every amount shown or frozen is read
 * from that Price object (`./offerPrice`), so a price change is a Stripe
 * change and no screen can state a number Stripe does not.
 *
 * Cloud INCLUDES the maintained Mac service, which is why `cloud_monthly_v1`
 * carries both capabilities rather than a second recurring subscription: one
 * owner has exactly one recurring Engager offer. */
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

/** A price as Stripe reported it, in the currency's minor unit. The one
 * shape every screen formats and every frozen provenance stores. */
export type PlanPrice = {
  amount: number;
  currency: string;
  interval: string;
};

/** Registered Macs one paid account may hold at once. Both offers carry the
 * same one seat: cloud includes Mac, so buying cloud never costs a seat. */
export const MAC_SEATS_PER_ACCOUNT = 1;

/** "Mac" or "Macs" for a count, so copy never prints "1 Macs". */
export function macNoun(count: number): string {
  return count === 1 ? "Mac" : "Macs";
}

/** The plan's Mac allowance in words: "One Mac", or the configured plural. Always from
 * `MAC_SEATS_PER_ACCOUNT`, never a number typed into a screen. */
export function macSeatsLabel(count: number): string {
  return count === 1 ? "One Mac" : `${count} ${macNoun(count)}`;
}

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

/** Which offer a Stripe Price id buys. Unknown ids resolve to nothing: there is
 * deliberately no fallback offer, so a rotated or foreign price fails closed
 * instead of inheriting the last catalog entry. */
export function offerForPriceId(
  priceId: string | null | undefined,
): Offer | undefined {
  if (!priceId) return undefined;
  return OFFER_IDS.map((id) => ENGAGER_OFFERS[id]).find(
    (offer) => offerPriceId(offer.id) === priceId,
  );
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

export class OfferTermsError extends Error {
  constructor(
    readonly code:
      | "offer_not_configured"
      | "offer_price_invalid"
      | "offer_quantity_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "OfferTermsError";
  }
}

/** "[price]/[interval]" in the Price's own currency and minor unit. SDK-free
 * so client components format exactly what the server read from Stripe. */
export function formatPlanPrice(price: PlanPrice): string {
  return `${formatMoney(price.amount, price.currency)}/${price.interval}`;
}

/** Validate Stripe-reported terms for one offer before any provider mutation
 * and again when a provider item becomes local authority. The Price id must
 * be the configured one and the cadence monthly at quantity one; the amount
 * and currency are whatever that Price says — Stripe is the authority on
 * money, this catalogue only on which Price sells. */
export function assertOfferPriceTerms(
  offerId: OfferId,
  terms: CheckoutPriceTerms,
  quantity = 1,
): OfferProvenance {
  const offer = ENGAGER_OFFERS[offerId];
  const priceId = offerPriceId(offerId);
  if (!priceId || terms.priceId !== priceId) {
    throw new OfferTermsError(
      "offer_not_configured",
      `No configured Stripe Price for the ${offer.name} offer`,
    );
  }
  if (quantity !== offer.quantity) {
    throw new OfferTermsError(
      "offer_quantity_mismatch",
      `The ${offer.name} offer is sold at quantity ${offer.quantity}`,
    );
  }
  if (
    !Number.isSafeInteger(terms.unitAmount) ||
    terms.unitAmount <= 0 ||
    !terms.currency ||
    terms.interval !== offer.interval
  ) {
    throw new OfferTermsError(
      "offer_price_invalid",
      `Configured Stripe Price is not a monthly price for the ${offer.name} offer`,
    );
  }
  return {
    offerId,
    priceId,
    unitAmount: terms.unitAmount,
    currency: terms.currency.toLowerCase(),
    interval: offer.interval,
    quantity: offer.quantity,
  };
}

/** Freeze provenance for a provider subscription item, or answer null when the
 * item is not exactly one unit of exactly one catalogued offer, or when the
 * item does not carry the amount, currency and interval Stripe reports for
 * its price. Callers store the result; they never re-derive authority from a
 * price id later, and never fill missing money in from anywhere else. */
export function offerProvenanceForItem(item: {
  priceId: string;
  quantity: number;
  unitAmount?: number | null;
  currency?: string | null;
  interval?: string | null;
}): OfferProvenance | null {
  const offer = offerForPriceId(item.priceId);
  if (!offer || item.quantity !== offer.quantity) return null;
  if (
    item.unitAmount == null ||
    !Number.isSafeInteger(item.unitAmount) ||
    item.unitAmount <= 0 ||
    !item.currency ||
    item.interval !== offer.interval
  ) {
    return null;
  }
  return {
    offerId: offer.id,
    priceId: item.priceId,
    unitAmount: item.unitAmount,
    currency: item.currency.toLowerCase(),
    interval: offer.interval,
    quantity: offer.quantity,
  };
}

/** Which capabilities an offer buys. An unknown offer buys nothing. */
export function offerCapabilities(
  offerId: string | null | undefined,
): readonly Exclude<Capability, "core_local">[] {
  return isOfferId(offerId) ? ENGAGER_OFFERS[offerId].capabilities : [];
}
