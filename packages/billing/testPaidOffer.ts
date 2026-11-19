import { randomUUID } from "node:crypto";
import { ENGAGER_OFFERS, type OfferId } from "./offer";
import {
  handleStripeSubscriptionEvent,
  type StripeSubscriptionLike,
} from "./webhooks";

/**
 * A test fixture that puts an organization on a paid offer — by driving the
 * REAL projection with a fake provider object, never by writing the columns a
 * test is about to assert.
 *
 * That matters: `subscriptions.offer_id`, `offer_terms`, `paid_through`,
 * `revoked_at` and `commercial_generation` are the projection's own output. A
 * fixture that set them directly would let a test pass while the rule that
 * produces them was broken, which is the exact shape of a mirrored test.
 *
 * Not a `.test.ts` file on purpose: several suites in three workspaces need the
 * same precondition, and `packages/core/test/cloudPlacement.ts` is the existing
 * precedent for a shared non-suite helper.
 */
export type PaidOfferFixture = {
  organizationId: string;
  /** Which offer this account bought. */
  offer?: OfferId;
  /** Provider status. `past_due` keeps whatever `paidThrough` was reached. */
  status?: "active" | "past_due" | "canceled" | "unpaid" | "trialing";
  /** Defaults to a period that ends thirty days from `now`. */
  periodEndsAt?: number;
  /** The trial's last instant, for a `trialing` projection. */
  trialEndsAt?: number;
  /** A card on file, as the subscription's default payment method. A trial
   * without one grants nothing, so a granting trial fixture sets this. */
  paymentMethodOnFile?: boolean;
  cancelAtPeriodEnd?: boolean;
  /** Reuse to project a SECOND event onto the same generation. */
  subscriptionId?: string;
  /** Defaults to a value derived from the organization, so repeated projections
   * for one org keep the customer mapping the first of them backfilled. */
  customerId?: string;
  now?: number;
};

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60_000;

/** The fixture Price's terms, as Stripe would report them on a subscription
 * item. Deliberately not any production amount: suites assert provenance
 * against THIS, so a test can never quietly re-pin the real price. */
const FIXTURE_UNIT_AMOUNT = 4_100;
export const FIXTURE_PRICE_TERMS: {
  unitAmount: number;
  currency: string;
  interval: "month";
} = {
  unitAmount: FIXTURE_UNIT_AMOUNT,
  currency: "usd",
  interval: "month",
};

/** Configure a catalogued price for this process, so the fixture's object is a
 * price the catalogue actually recognizes. Returns the price id. */
export function configureOfferPrice(offer: OfferId, priceId?: string): string {
  const value = priceId ?? `price_${offer}_test`;
  process.env[ENGAGER_OFFERS[offer].priceEnv] = value;
  return value;
}

export function stripeSubscriptionForOffer(
  input: PaidOfferFixture,
): StripeSubscriptionLike {
  const offer = input.offer ?? "cloud_monthly_v1";
  const now = input.now ?? Date.now();
  const periodEndsAt = input.periodEndsAt ?? now + THIRTY_DAYS_MS;
  const subscriptionId = input.subscriptionId ?? `sub_${randomUUID()}`;
  const priceId = configureOfferPrice(offer);
  return {
    id: subscriptionId,
    customer: {
      id:
        input.customerId ?? `cus_${input.organizationId.replaceAll("-", "")}`,
      metadata: { organizationId: input.organizationId },
    },
    status: input.status ?? "active",
    items: {
      data: [
        {
          price: {
            id: priceId,
            unit_amount: FIXTURE_PRICE_TERMS.unitAmount,
            currency: FIXTURE_PRICE_TERMS.currency,
            recurring: { interval: FIXTURE_PRICE_TERMS.interval },
          },
          quantity: ENGAGER_OFFERS[offer].quantity,
          current_period_start: Math.floor((now - THIRTY_DAYS_MS) / 1000),
          current_period_end: Math.floor(periodEndsAt / 1000),
        },
      ],
    },
    cancel_at_period_end: input.cancelAtPeriodEnd ?? false,
    ...(input.trialEndsAt != null
      ? { trial_end: Math.floor(input.trialEndsAt / 1000) }
      : {}),
    ...(input.paymentMethodOnFile
      ? { default_payment_method: "pm_fixture_card" }
      : {}),
    latest_invoice: paidInvoiceForOffer(subscriptionId, priceId),
    metadata: { organizationId: input.organizationId },
  };
}

export function paidInvoiceForOffer(
  subscriptionId: string,
  priceId: string,
): StripeSubscriptionLike["latest_invoice"] {
  return {
    id: `in_${randomUUID()}`,
    created: Math.floor(Date.now() / 1000),
    status: "paid",
    amount_remaining: 0,
    amount_paid: FIXTURE_UNIT_AMOUNT,
    amount_due: FIXTURE_UNIT_AMOUNT,
    currency: "usd",
    subscription: subscriptionId,
    lines: { data: [{ price: { id: priceId }, quantity: 1 }], has_more: false },
  };
}

/** Project one provider event for this offer and return the subscription id. */
export async function projectPaidOffer(
  input: PaidOfferFixture,
): Promise<{ subscriptionId: string; object: StripeSubscriptionLike }> {
  const object = stripeSubscriptionForOffer(input);
  const result = await handleStripeSubscriptionEvent(
    { type: "customer.subscription.updated", data: { object } },
    input.now,
  );
  if (!result.ok) {
    throw new Error(
      "paid offer fixture: the projection did not resolve an organization",
    );
  }
  return { subscriptionId: object.id, object };
}
