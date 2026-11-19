import {
  CheckoutPriceInvalidError,
  retrieveCheckoutPriceTerms,
  type CheckoutPriceTerms,
} from "./client";
import {
  assertOfferPriceTerms,
  ENGAGER_OFFERS,
  offerPriceId,
  OfferTermsError,
  type OfferId,
  type PlanPrice,
} from "./offer";
import { resolveTrialDays } from "./trialEligibility";

export { formatPlanPrice } from "./offer";

/** One offer's price exactly as Stripe reported it on the configured Price,
 * with the trial length that Price configures (US-ONA-02). */
export type OfferPrice = PlanPrice & { priceId: string; trialDays: number };

const CACHE_TTL_MS = 60_000;
const STALE_TTL_MS = 24 * 60 * 60_000;

const cache = new Map<OfferId, { value: OfferPrice; at: number }>();

export function clearOfferPriceCacheForTests(): void {
  cache.clear();
}

type ReadOfferPriceOptions = {
  /** Checkout creation always reads fresh and never serves a stale value. */
  fresh?: boolean;
  now?: number;
  retrieve?: (priceId: string) => Promise<CheckoutPriceTerms>;
};

/**
 * Read an offer's price from the Stripe Price this deployment sells. Display
 * reads are cached for a short TTL, so a burst of page renders costs one
 * Stripe call; when Stripe is unreachable a display read may serve the last
 * cached value up to a day old. A fresh read never serves stale data — it
 * either returns what Stripe just said or throws, and the caller refuses.
 */
export async function readOfferPrice(
  offerId: OfferId,
  opts: ReadOfferPriceOptions = {},
): Promise<OfferPrice> {
  const now = opts.now ?? Date.now();
  const cached = cache.get(offerId);
  if (!opts.fresh && cached && now - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }
  const priceId = offerPriceId(offerId);
  if (!priceId) {
    throw new OfferTermsError(
      "offer_not_configured",
      `No configured Stripe Price for the ${ENGAGER_OFFERS[offerId].name} offer`,
    );
  }
  try {
    const terms = await (opts.retrieve ?? retrieveCheckoutPriceTerms)(priceId);
    const proven = assertOfferPriceTerms(offerId, terms);
    const trialDays = resolveTrialDays(terms.trialDaysMetadata);
    if (!trialDays.ok) {
      throw new OfferTermsError(
        "offer_price_invalid",
        `Configured Stripe Price for the ${ENGAGER_OFFERS[offerId].name} offer carries an invalid trial_days`,
      );
    }
    const value: OfferPrice = {
      priceId: proven.priceId,
      amount: proven.unitAmount,
      currency: proven.currency,
      interval: proven.interval,
      trialDays: trialDays.days,
    };
    cache.set(offerId, { value, at: now });
    return value;
  } catch (error) {
    // A Price Stripe answered for but rejects as unsellable is a verdict, not
    // an outage: never paper over it with yesterday's amount.
    if (
      error instanceof OfferTermsError ||
      error instanceof CheckoutPriceInvalidError
    ) {
      throw error;
    }
    if (!opts.fresh && cached && now - cached.at <= STALE_TTL_MS) {
      return cached.value;
    }
    throw error;
  }
}
