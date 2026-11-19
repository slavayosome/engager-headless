import { randomUUID } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "@engager/database";
import {
  commercialOfferIntents,
  organizations,
  stripeEvents,
  stripeProjectionLeases,
  subscriptions,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { isEngagerPriceId } from "./plans";
import {
  offerForPriceId,
  offerProvenanceForItem,
  type OfferProvenance,
} from "./offer";
import { assignCommercialGeneration } from "./projection";

/**
 * The subset of a Stripe subscription object this package depends on. Declaring it
 * here (rather than importing Stripe's types) keeps this module SDK-free and
 * unit-testable: tests construct plain objects, prod passes the real Stripe event.
 *
 * The Basil API (2025-03-31+, Stripe SDK 17.x) moved `current_period_start/end`
 * off the subscription object onto each subscription ITEM, so we read both
 * locations (item-level first available wins; top-level kept for older accounts).
 */
export type StripeSubscriptionLike = {
  id: string;
  customer:
    | string
    | {
        id: string;
        metadata?: { organizationId?: string };
        invoice_settings?: {
          default_payment_method?: string | { id: string } | null;
        } | null;
        default_source?: string | { id: string } | null;
      };
  status: string;
  /** The card the subscription itself will charge, as an id or expanded. */
  default_payment_method?: string | { id: string } | null;
  items?: {
    data: {
      price: {
        id: string;
        unit_amount?: number | null;
        currency?: string | null;
        recurring?: { interval?: string | null } | null;
      };
      quantity?: number;
      current_period_start?: number | null;
      current_period_end?: number | null;
    }[];
  };
  current_period_start?: number | null;
  current_period_end?: number | null;
  trial_end?: number | null;
  cancel_at?: number | null;
  cancel_at_period_end?: boolean;
  /** The provider schedule governing this subscription, when one does. A
   * period-end offer change installs one; reading it is how a scheduled change
   * is told apart from a change that never landed (`./offerChange.ts`). */
  schedule?:
    | string
    | {
        id: string;
        status?: string;
        subscription?: string | { id: string } | null;
        phases?: {
          start_date: number;
          end_date: number;
          items: {
            price: string | { id: string };
            quantity?: number;
          }[];
        }[];
      }
    | null;
  pending_update?: { expires_at: number } | null;
  latest_invoice?:
    | string
    | {
        id: string;
        created?: number;
        status: string | null;
        amount_remaining: number;
        amount_paid: number;
        amount_due: number;
        currency: string;
        subscription?: string | { id: string } | null;
        parent?: {
          subscription_details?: {
            subscription: string | { id: string };
          } | null;
        } | null;
        lines: {
          data: {
            quantity: number | null;
            price?: { id: string } | null;
            pricing?: {
              price_details?: { price: string | { id: string } } | null;
            } | null;
          }[];
          has_more?: boolean;
        };
      }
    | null;
  metadata?: {
    organizationId?: string;
    checkoutSessionId?: string;
  };
};

/** Expanded canonical invoice evidence, never the delivery event's status. An
 * old paid invoice for the Mac price cannot authorize the Cloud replacement. */
export function hasPaidOfferInvoice(
  object: StripeSubscriptionLike,
  quote?: { quoteUnitAmount: number; quoteCurrency: string; createdAt: number },
): boolean {
  const invoice = object.latest_invoice;
  const item = object.items?.data;
  if (
    !invoice ||
    typeof invoice === "string" ||
    object.pending_update ||
    object.status !== "active" ||
    invoice.status !== "paid" ||
    invoice.amount_remaining !== 0 ||
    invoice.amount_paid < invoice.amount_due ||
    invoice.lines.has_more ||
    item?.length !== 1
  )
    return false;
  if (
    quote &&
    (invoice.amount_due !== quote.quoteUnitAmount ||
      invoice.currency.toLowerCase() !== quote.quoteCurrency.toLowerCase() ||
      invoice.created == null ||
      invoice.created < Math.floor(quote.createdAt / 1000))
  )
    return false;
  const subscription =
    invoice.parent?.subscription_details?.subscription ?? invoice.subscription;
  if (
    (typeof subscription === "string" ? subscription : subscription?.id) !==
    object.id
  )
    return false;
  return invoice.lines.data.some((line) => {
    const price = line.pricing?.price_details?.price ?? line.price;
    return (
      (typeof price === "string" ? price : price?.id) === item[0]!.price.id &&
      line.quantity === (item[0]!.quantity ?? 1)
    );
  });
}

/**
 * Is there a payment method on file anywhere Stripe would charge one from —
 * the subscription's own default, the expanded customer's invoice default, or
 * a legacy customer source? A trial grants only with one (§5.7): Checkout in
 * subscription mode collects the card up front, so its absence means this
 * trial was never the owner's Checkout trial and must not become access.
 * Pure over the canonical object; the customer arm needs the expansion
 * `fetchSubscription` already requests.
 */
export function hasPaymentMethod(object: StripeSubscriptionLike): boolean {
  const present = (
    value: string | { id: string } | null | undefined,
  ): boolean =>
    typeof value === "string" ? value.length > 0 : Boolean(value?.id);
  if (present(object.default_payment_method)) return true;
  if (typeof object.customer === "string") return false;
  return (
    present(object.customer.invoice_settings?.default_payment_method) ||
    present(object.customer.default_source)
  );
}

/** Whether the canonical object's expanded latest invoice reads settled:
 * paid, with nothing remaining. An absent or unexpanded invoice is no
 * evidence either way — production's `fetchSubscription` expands it. */
function latestInvoiceIsPaid(object: StripeSubscriptionLike): boolean {
  const invoice = object.latest_invoice;
  return (
    invoice != null &&
    typeof invoice !== "string" &&
    invoice.status === "paid" &&
    invoice.amount_remaining === 0
  );
}

export type StripeSubscriptionEvent = {
  type: string;
  data: { object: StripeSubscriptionLike };
};

export type ReceivedStripeSubscriptionEvent = {
  type: string;
  data: { object: { id: string } };
};

export type HandleResult = { ok: true; organizationId: string } | { ok: false };

/**
 * What a processed (or redelivered) webhook MEANS to the caller, derived from
 * the canonical subscription — never from the delivery event's own claims
 * about state. `null` is an ordinary subscription change (or a stale
 * delivery whose canonical state no longer says what the event type says):
 * it projects like any other event but carries no email/receipt meaning.
 * US-ONA-09 defines the five named kinds; the emails themselves belong to
 * later stories, and `refunded` is consumed by US-ONA-06.
 */
export type StripeWebhookKind =
  | "trial_started"
  | "trial_will_end"
  | "payment_failed"
  | "payment_paid"
  | "refunded"
  | null;

export type ProcessStripeSubscriptionResult =
  | {
      status: "processed";
      organizationId: string;
      kind: StripeWebhookKind;
      subscriptionId: string;
      invoiceId: string | null;
    }
  | {
      status: "ignored";
      kind: StripeWebhookKind;
      organizationId: string | null;
      subscriptionId: string | null;
      invoiceId: string | null;
    }
  /** Null when no `subscriptions` row carries this Stripe id yet — a
   *  redelivery that arrived before the projection ever landed. The route's
   *  post-processing arm runs only when it is non-null. */
  | {
      status: "duplicate";
      organizationId: string | null;
      kind: StripeWebhookKind;
      /** Null for a redelivered invoice/charge that never named one. */
      subscriptionId: string | null;
      invoiceId: string | null;
    };

/** The subset of a Stripe invoice object the webhook processor depends on.
 * Amounts ride along because the trial's zero-amount invoice must not read
 * as a paid receipt; state is still never read from them. */
export type StripeInvoiceLike = {
  id: string;
  amount_due?: number | null;
  amount_paid?: number | null;
  subscription?: string | { id: string } | null;
  parent?: {
    subscription_details?: {
      subscription: string | { id: string };
    } | null;
  } | null;
};

export type ReceivedStripeInvoiceEvent = {
  type: string;
  data: { object: StripeInvoiceLike };
};

/** The subset of a Stripe charge object needed to find its subscription.
 * A charge names its invoice or, on Basil, its payment intent;
 * the subscription then comes from that invoice, exactly as invoice events
 * resolve it. `refunded` is Stripe's own flag: true once the WHOLE charge is
 * refunded, still false after a partial refund. */
export type StripeChargeLike = {
  id: string;
  invoice?: string | StripeInvoiceLike | null;
  payment_intent?: string | { id: string } | null;
  refunded?: boolean;
};

export type ReceivedStripeChargeEvent = {
  type: string;
  data: { object: StripeChargeLike };
};

/** The subscription an invoice belongs to: Basil's
 * `parent.subscription_details.subscription` first, the legacy top-level
 * `subscription` as fallback — the same read `hasPaidOfferInvoice` makes. */
export function stripeInvoiceSubscriptionId(
  invoice: StripeInvoiceLike,
): string | null {
  const subscription =
    invoice.parent?.subscription_details?.subscription ?? invoice.subscription;
  if (!subscription) return null;
  const id = typeof subscription === "string" ? subscription : subscription.id;
  return id || null;
}

function stripeCustomerId(
  customer: StripeSubscriptionLike["customer"],
): string | null {
  if (typeof customer === "string") return customer || null;
  return customer.id || null;
}

/** Stripe sends period/trial timestamps in seconds; the DB stores ms. */
function secToMs(sec: number | null | undefined): number | null {
  return typeof sec === "number" ? sec * 1000 : null;
}

/** Period end (seconds) read item-level first (Basil), then top-level. One
 * reader, exported because a scheduled offer change takes effect at exactly
 * this boundary and must not compute it a second way. */
export function periodEndSec(
  object: StripeSubscriptionLike,
): number | null | undefined {
  return (
    object.current_period_end ?? object.items?.data?.[0]?.current_period_end
  );
}

/** Period start (seconds) read item-level first (Basil), then top-level. */
function periodStartSec(
  object: StripeSubscriptionLike,
): number | null | undefined {
  return (
    object.current_period_start ?? object.items?.data?.[0]?.current_period_start
  );
}

/**
 * Resolve the org that owns this subscription. Primary path: match
 * `organizations.billingCustomerId`. Fallback: the `organizationId` we stamped on
 * subscription metadata during guarded-trial creation — this rescues the case where the
 * customer was created but the `billingCustomerId` write failed (otherwise the
 * customer is orphaned and the org can never unlock). On the fallback we backfill
 * `billingCustomerId` so future events resolve via the primary path.
 */
async function resolveOrganizationId(
  tx: Tx,
  object: StripeSubscriptionLike,
): Promise<string | null> {
  const customerId = stripeCustomerId(object.customer);
  if (!customerId) return null;
  const [byCustomer] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.billingCustomerId, customerId));

  const subscriptionOrgId = object.metadata?.organizationId;
  const customerOrgId =
    typeof object.customer === "string"
      ? undefined
      : object.customer.metadata?.organizationId;
  if (
    subscriptionOrgId &&
    customerOrgId &&
    subscriptionOrgId !== customerOrgId
  ) {
    return null;
  }
  const metaOrgId = subscriptionOrgId ?? customerOrgId;
  // A customer mapping and subscription metadata are two independent ownership
  // signals. Never let one silently override the other: doing so could apply a
  // subscription to the wrong tenant.
  if (byCustomer) {
    if (metaOrgId && metaOrgId !== byCustomer.id) return null;
    return byCustomer.id;
  }
  if (!metaOrgId) return null;
  const [byMeta] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, metaOrgId));
  if (!byMeta) return null;
  // Backfill only an unclaimed org. A concurrent event may have established a
  // different customer mapping since the reads above; do not overwrite it.
  const [backfilled] = await tx
    .update(organizations)
    .set({ billingCustomerId: customerId })
    .where(
      and(
        eq(organizations.id, byMeta.id),
        isNull(organizations.billingCustomerId),
      ),
    )
    .returning({ id: organizations.id });
  if (backfilled) return backfilled.id;

  const [current] = await tx
    .select({ billingCustomerId: organizations.billingCustomerId })
    .from(organizations)
    .where(eq(organizations.id, byMeta.id));
  return current?.billingCustomerId === customerId ? byMeta.id : null;
}

async function applyStripeSubscriptionEvent(
  tx: Tx,
  event: StripeSubscriptionEvent,
  expectedOrganizationId?: string,
  now: number = Date.now(),
  confirmedFullRefund = false,
): Promise<HandleResult> {
  const object = event.data.object;

  const organizationId = await resolveOrganizationId(tx, object);
  if (!organizationId) return { ok: false };
  if (expectedOrganizationId && organizationId !== expectedOrganizationId) {
    return { ok: false };
  }

  // The projection is always built from a canonical Stripe subscription. Its
  // status is authoritative; the delivery event type may be stale or reordered.
  const providerActive =
    object.status === "active" ||
    object.status === "trialing" ||
    object.status === "past_due";

  const [stored] = await tx
    .select({
      items: subscriptions.items,
      periodStartsAt: subscriptions.periodStartsAt,
      offerTerms: subscriptions.offerTerms,
      paidThrough: subscriptions.paidThrough,
      revokedAt: subscriptions.revokedAt,
      confirmedRefundAt: subscriptions.confirmedRefundAt,
      paymentFailedAt: subscriptions.paymentFailedAt,
      checkoutSessionId: subscriptions.checkoutSessionId,
      checkoutTerms: subscriptions.checkoutTerms,
      guardedCancellationToken: subscriptions.guardedCancellationToken,
      guardedCancellationStartedAt: subscriptions.guardedCancellationStartedAt,
      guardedCancellationRequestedByUserId:
        subscriptions.guardedCancellationRequestedByUserId,
    })
    .from(subscriptions)
    .where(eq(subscriptions.id, object.id));
  const incomingItems = object.items?.data ?? [];
  // Provenance freezes the terms Stripe reported ON THE ITEM. An item whose
  // price object arrives abbreviated (no amount, currency or interval) freezes
  // nothing: money is never filled in from anywhere else.
  const itemTerms = (item: (typeof incomingItems)[number]) => ({
    priceId: item.price.id,
    quantity: item.quantity ?? 1,
    unitAmount: item.price.unit_amount,
    currency: item.price.currency,
    interval: item.price.recurring?.interval,
  });
  const incomingOffer =
    incomingItems.length === 1
      ? offerProvenanceForItem(itemTerms(incomingItems[0]!))
      : null;
  const [upgradeIntent] =
    stored?.offerTerms?.offerId === "mac_monthly_v1" &&
    incomingOffer?.offerId === "cloud_monthly_v1"
      ? await tx
          .select()
          .from(commercialOfferIntents)
          .where(
            and(
              eq(commercialOfferIntents.organizationId, organizationId),
              eq(commercialOfferIntents.fromSubscriptionId, object.id),
              eq(commercialOfferIntents.toOfferId, "cloud_monthly_v1"),
              eq(commercialOfferIntents.status, "dispatched"),
            ),
          )
          .limit(1)
      : [];
  const unpaidUpgrade =
    stored?.offerTerms?.offerId === "mac_monthly_v1" &&
    incomingOffer?.offerId === "cloud_monthly_v1" &&
    !hasPaidOfferInvoice(object, upgradeIntent);
  // Retain the already-paid tier through a failed/pending replacement. Provider
  // cancellation still revokes it below; only the capability upgrade is held.
  const providerItems = unpaidUpgrade
    ? (stored.items ?? []).map((item) => ({
        price: {
          id: item.priceId,
          unit_amount: stored.offerTerms?.unitAmount ?? null,
          currency: stored.offerTerms?.currency ?? null,
          recurring: { interval: stored.offerTerms?.interval ?? null },
        },
        quantity: item.quantity,
      }))
    : incomingItems;
  // A Stripe Customer can own subscriptions for several products. Provider
  // status alone is not Engager entitlement: this subscription must contain
  // exactly one unit of exactly one CATALOGUED offer. The only price that may
  // be honoured without being in today's catalogue is the exact one this row
  // already froze as its own offer provenance, so rotating a price env cannot
  // demote a paying customer — and no legacy alias, mixed basket or unknown
  // price can promote one (TIER-11). Unknown items are still projected for
  // status history and fail closed for access.
  const frozen = stored?.offerTerms ?? null;
  const itemProvenance = (
    item: (typeof providerItems)[number],
  ): OfferProvenance | null => {
    const quantity = item.quantity ?? 1;
    const catalogued = offerProvenanceForItem({
      priceId: item.price.id,
      quantity,
      unitAmount: item.price.unit_amount,
      currency: item.price.currency,
      interval: item.price.recurring?.interval,
    });
    if (catalogued) return catalogued;
    return frozen && frozen.priceId === item.price.id && quantity === frozen.quantity
      ? frozen
      : null;
  };
  const soleItem = providerItems.length === 1 ? providerItems[0] : undefined;
  const provenance = soleItem ? itemProvenance(soleItem) : null;
  // One greppable line for the one silent failure that would otherwise look
  // like a foreign price: the item IS the configured offer price, at quantity
  // one, but arrived without the terms provenance must freeze — so this row
  // grants nothing until an event carries them.
  if (
    !provenance &&
    soleItem &&
    (soleItem.quantity ?? 1) === 1 &&
    offerForPriceId(soleItem.price.id) &&
    (soleItem.price.unit_amount == null ||
      soleItem.price.currency == null ||
      soleItem.price.recurring?.interval == null)
  ) {
    console.error(
      JSON.stringify({
        at: "billing.webhooks",
        level: "error",
        msg: "subscription item for a configured offer price arrived without price terms; provenance is null and the row grants nothing",
      }),
    );
  }
  const priceAuthorized = provenance !== null;
  // A trial is provider-active but is only Engager access with a card on
  // file: Checkout collects one before the trial starts, so a cardless
  // `trialing` object is history or someone else's trial, never a grant.
  const paymentMethodOnFile = hasPaymentMethod(object);
  // Only the full-refund inbox sets this evidence, after a canonical read
  // confirms cancellation. Later projections never erase it.
  const confirmedRefundAt = stored?.confirmedRefundAt ?? (confirmedFullRefund ? now : null);
  const active =
    confirmedRefundAt === null &&
    providerActive &&
    priceAuthorized &&
    (object.status !== "trialing" || paymentMethodOnFile);
  const items = providerItems.map((item) => {
    // Per-item provenance is valid only when the whole one-item offer is valid.
    // Otherwise a mixed basket could be removed later and bootstrap one of its
    // formerly configured items as a grandfathered subscription.
    const itemAuthorized = priceAuthorized && item === soleItem;
    return {
      priceId: item.price.id,
      quantity: item.quantity ?? 1,
      priceAuthorized: itemAuthorized,
    };
  });

  // Keep the identity of the last funded window through dunning/lapse. An
  // unpaid renewal's new period start must not erase or replenish recovery.
  const periodStartsAt =
    (unpaidUpgrade || object.status !== "active") && stored?.paidThrough != null
      ? stored.periodStartsAt
      : secToMs(periodStartSec(object));
  const periodEndsAt = secToMs(periodEndSec(object));
  const trialEndsAt = secToMs(object.trial_end);
  const cancelAt = secToMs(object.cancel_at);
  const cancelAtPeriodEnd = object.cancel_at_period_end ?? false;
  // Checkout provenance is an immutable local authority boundary. Stripe
  // metadata is mutable and may be omitted by later API/admin updates; never
  // let provider drift erase a versioned row and make entitlement treat it as
  // a grandfathered legacy subscription. Conflicting later metadata is ignored
  // for the same reason: the authenticated Checkout landing established the
  // durable session/terms pair that activation is bound to. Nothing creates a
  // terms pair any more, so the stored one is only ever carried forward.
  const checkoutSessionId =
    stored?.checkoutSessionId ?? object.metadata?.checkoutSessionId ?? null;
  const terms = stored?.checkoutTerms ?? null;
  // Preserve an in-flight owner cancellation only while the canonical provider
  // object is still the exact armed guarded trial. A canceled or unguarded
  // canonical projection releases the fence; ambiguous provider failures never
  // reach this projection and therefore retain it for retry.
  const cancellationStillPending =
    active &&
    trialEndsAt != null &&
    cancelAt === trialEndsAt &&
    !cancelAtPeriodEnd;
  const guardedCancellationToken = cancellationStillPending
    ? (stored?.guardedCancellationToken ?? null)
    : null;
  const guardedCancellationStartedAt = cancellationStillPending
    ? (stored?.guardedCancellationStartedAt ?? null)
    : null;
  const guardedCancellationRequestedByUserId = cancellationStillPending
    ? (stored?.guardedCancellationRequestedByUserId ?? null)
    : null;

  // The service boundary. It advances on a settled `active` period — Stripe
  // reaches `active` after the first invoice is paid, so this is the
  // authenticated settled-payment evidence the projection needs — and, for a
  // card-backed trial, to the trial's last instant: the trial is real access
  // until then and funds no period beyond it. `past_due` is deliberately
  // excluded — dunning keeps whatever was already paid for and extends
  // nothing — and a canceled period never rolls the boundary back, because
  // the owner did pay for the days already bought. `Math.max` throughout, so
  // a stale trial event after the paid conversion lowers nothing.
  const paidThrough =
    !unpaidUpgrade && object.status === "active" && periodEndsAt != null
      ? Math.max(stored?.paidThrough ?? 0, periodEndsAt)
      : !unpaidUpgrade &&
          object.status === "trialing" &&
          paymentMethodOnFile &&
          trialEndsAt != null
        ? Math.max(stored?.paidThrough ?? 0, trialEndsAt)
        : (stored?.paidThrough ?? null);
  // A provider generation that ends while its paid period is still running is
  // a revocation (a refund or an immediate cancel), and it ends service now.
  // The INSTANT is recorded once — a redelivery cannot move an owner's
  // revocation forward — but the fact is derived from canonical state, so a
  // generation the provider brings back (an `unpaid` invoice that settles)
  // stops being revoked rather than staying dead on a stale stamp.
  const revoked = !providerActive && paidThrough != null && paidThrough > now;
  const revokedAt = confirmedRefundAt !== null
    ? (stored?.revokedAt ?? confirmedRefundAt)
    : revoked ? (stored?.revokedAt ?? now) : null;
  // The current failure episode (US-ONA-04). Recorded only when an
  // `invoice.payment_failed` delivery's CANONICAL subscription is still
  // failing — `past_due` with its latest invoice not paid — on a catalogued
  // offer, and only the first time: the stored instant wins over every
  // redelivery and every later failed retry, so no path moves it forward.
  // The instant is this projection's `now` (the server clock the grace
  // arithmetic runs on), never the Stripe event's `created`, which a test
  // clock skews. A stale failure delivered after the invoice settled reads
  // canonical `active` / paid here and records nothing. Settling — the
  // canonical subscription reads `active`, or its latest invoice reads
  // paid — clears the episode wherever it lands, inside the grace or after
  // the pause, so the next failure starts fresh. Anything else (an
  // ordinary subscription event, a provider end state) preserves it.
  const invoiceSettled = latestInvoiceIsPaid(object);
  const canonicalFailing =
    object.status === "past_due" && !invoiceSettled && priceAuthorized;
  const canonicalSettled = object.status === "active" || invoiceSettled;
  const paymentFailedAt = canonicalSettled
    ? null
    : event.type === "invoice.payment_failed" && canonicalFailing
      ? (stored?.paymentFailedAt ?? now)
      : (stored?.paymentFailedAt ?? null);
  const commercialGeneration = await assignCommercialGeneration(
    tx,
    organizationId,
    object.id,
  );

  await tx
    .insert(subscriptions)
    .values({
      id: object.id,
      organizationId,
      status: object.status,
      active,
      provider: "stripe",
      items,
      periodStartsAt,
      periodEndsAt,
      trialEndsAt,
      offerId: provenance?.offerId ?? null,
      offerTerms: provenance ?? frozen,
      commercialGeneration,
      paidThrough,
      revokedAt,
      confirmedRefundAt,
      paymentFailedAt,
      cancelAt,
      cancelAtPeriodEnd,
      checkoutSessionId,
      checkoutTerms: terms,
      guardedCancellationToken,
      guardedCancellationStartedAt,
      guardedCancellationRequestedByUserId,
    })
    .onConflictDoUpdate({
      target: subscriptions.id,
      set: {
        organizationId,
        status: object.status,
        active,
        items,
        periodStartsAt,
        periodEndsAt,
        trialEndsAt,
        // Provenance is frozen: a recognized catalogue item may REPLACE it (that
        // is how an accepted offer change lands), but provider drift to an
        // unknown price preserves what this generation was and stops granting.
        offerId: provenance?.offerId ?? frozen?.offerId ?? null,
        offerTerms: provenance ?? frozen,
        commercialGeneration,
        paidThrough,
        revokedAt,
        confirmedRefundAt,
        paymentFailedAt,
        cancelAt,
        cancelAtPeriodEnd,
        checkoutSessionId,
        checkoutTerms: terms,
        guardedCancellationToken,
        guardedCancellationStartedAt,
        guardedCancellationRequestedByUserId,
      },
    });

  // A downgrade the provider accepted for the period boundary settles HERE,
  // when the boundary actually lands the replacement offer — not when an owner
  // happens to ask for a reconcile. Nothing else can do it: the intent stays
  // open to hold "one change at a time", so a scheduled change that had
  // already happened would refuse every later change for the rest of the
  // account's life. The predicate is the evidence, not the elapsed time: this
  // subscription now carries exactly the offer the intent named.
  if (provenance?.offerId) {
    if (upgradeIntent && !unpaidUpgrade) {
      await tx
        .update(commercialOfferIntents)
        .set({
          status: "applied",
          appliedSubscriptionId: object.id,
          appliedGeneration: commercialGeneration,
          updatedAt: now,
        })
        .where(
          and(
            eq(commercialOfferIntents.id, upgradeIntent.id),
            eq(commercialOfferIntents.organizationId, organizationId),
            eq(commercialOfferIntents.status, "dispatched"),
          ),
        );
    }
    await tx
      .update(commercialOfferIntents)
      .set({
        status: "applied",
        appliedSubscriptionId: object.id,
        appliedGeneration: commercialGeneration,
        updatedAt: now,
      })
      .where(
        and(
          eq(commercialOfferIntents.organizationId, organizationId),
          eq(commercialOfferIntents.status, "scheduled"),
          eq(commercialOfferIntents.toOfferId, provenance.offerId),
          eq(commercialOfferIntents.fromSubscriptionId, object.id),
        ),
      );
  }

  return { ok: true, organizationId };
}

/**
 * Decide whether a canonical Stripe subscription belongs to Engager before it
 * can become billing authority. This Stripe account may serve other products,
 * and a customer id alone is not product provenance: another Checkout using
 * the same customer must not unlock Engager.
 *
 * Existing local ids remain recognizable so later status/price drift can still
 * project cancellation and revoke access. A NEW row requires a configured
 * current or explicitly grandfathered Engager Price. Customer metadata is only
 * tenant ownership, never product provenance: the same Stripe Customer may buy
 * unrelated products in this account.
 */
async function isEngagerSubscriptionProjection(
  reader: Pick<typeof db, "select"> | Tx,
  object: StripeSubscriptionLike,
): Promise<boolean> {
  const [existing] = await reader
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(eq(subscriptions.id, object.id));
  if (existing) return true;
  return (object.items?.data ?? []).some((item) =>
    isEngagerPriceId(item.price.id),
  );
}

async function projectCanonicalStripeSubscription(
  subscriptionId: string,
  eventType: string,
  loadCanonical: (subscriptionId: string) => Promise<StripeSubscriptionLike>,
): Promise<{
  canonical: StripeSubscriptionLike;
  event: StripeSubscriptionEvent;
}> {
  const canonical = await loadCanonical(subscriptionId);
  if (canonical.id !== subscriptionId) {
    throw new Error("Stripe returned a different subscription than requested");
  }
  return {
    canonical,
    event: { type: eventType, data: { object: canonical } },
  };
}

/** Provider states with nothing left to end: Stripe cannot cancel either. */
const SUBSCRIPTION_OVER = new Set(["canceled", "incomplete_expired"]);

const PROJECTION_LEASE_MS = 60_000;
const PROJECTION_HEARTBEAT_MS = 15_000;

export class StripeProjectionBusyError extends Error {
  constructor(readonly subscriptionId: string) {
    super(`Stripe subscription ${subscriptionId} is already being reconciled`);
  }
}

/** Serialize canonical provider reads without holding a transaction or pooled
 * connection open. A crashed invocation releases itself through lease expiry. */
async function withStripeProjectionLease<T>(
  subscriptionId: string,
  work: (leaseToken: string) => Promise<T>,
): Promise<T> {
  const leaseToken = randomUUID();
  const now = Date.now();
  const [claimed] = await db
    .insert(stripeProjectionLeases)
    .values({
      subscriptionId,
      leaseToken,
      leaseExpiresAt: now + PROJECTION_LEASE_MS,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: stripeProjectionLeases.subscriptionId,
      set: {
        leaseToken,
        leaseExpiresAt: now + PROJECTION_LEASE_MS,
        updatedAt: now,
      },
      setWhere: sql`${stripeProjectionLeases.leaseExpiresAt} < ${now}`,
    })
    .returning({ leaseToken: stripeProjectionLeases.leaseToken });
  if (claimed?.leaseToken !== leaseToken) {
    throw new StripeProjectionBusyError(subscriptionId);
  }
  // Stripe's SDK request timeout can exceed the base lease. Renew while provider
  // I/O is alive; if the process freezes or loses ownership, the fenced write
  // below still rejects this invocation before projection.
  const heartbeat = setInterval(() => {
    const heartbeatAt = Date.now();
    void db
      .update(stripeProjectionLeases)
      .set({
        leaseExpiresAt: heartbeatAt + PROJECTION_LEASE_MS,
        updatedAt: heartbeatAt,
      })
      .where(
        and(
          eq(stripeProjectionLeases.subscriptionId, subscriptionId),
          eq(stripeProjectionLeases.leaseToken, leaseToken),
          gt(stripeProjectionLeases.leaseExpiresAt, heartbeatAt),
        ),
      )
      .catch(() => {});
  }, PROJECTION_HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    return await work(leaseToken);
  } finally {
    clearInterval(heartbeat);
    await db
      .delete(stripeProjectionLeases)
      .where(
        and(
          eq(stripeProjectionLeases.subscriptionId, subscriptionId),
          eq(stripeProjectionLeases.leaseToken, leaseToken),
        ),
      );
  }
}

/** Fence a projection write against lease expiry/reclamation. The UPDATE both
 * proves this invocation still owns an unexpired lease and holds the lease row
 * lock until the surrounding projection transaction commits. A replacement
 * claimant therefore either wins before this check (and the stale projection
 * aborts) or waits and applies newer canonical state after this transaction. */
async function fenceStripeProjectionLease(
  tx: Tx,
  subscriptionId: string,
  leaseToken: string,
): Promise<void> {
  const now = Date.now();
  const [renewed] = await tx
    .update(stripeProjectionLeases)
    .set({
      leaseExpiresAt: now + PROJECTION_LEASE_MS,
      updatedAt: now,
    })
    .where(
      and(
        eq(stripeProjectionLeases.subscriptionId, subscriptionId),
        eq(stripeProjectionLeases.leaseToken, leaseToken),
        gt(stripeProjectionLeases.leaseExpiresAt, now),
      ),
    )
    .returning({ leaseToken: stripeProjectionLeases.leaseToken });
  if (renewed?.leaseToken !== leaseToken) {
    throw new StripeProjectionBusyError(subscriptionId);
  }
}

/**
 * Map a Stripe `customer.subscription.*` event onto the (NOT RLS-scoped)
 * `subscriptions` table. The org is resolved from `billingCustomerId` (or the
 * checkout metadata fallback). If no org owns the customer, returns `{ ok: false }`.
 *
 * - `customer.subscription.deleted` → row with `active: false`.
 * - otherwise → `active = status in (active, trialing, past_due)`, narrowed to a
 *   catalogued offer and, for `trialing`, to a card on file. `past_due` is
 *   counted active so Stripe dunning can recover a failed card before lockout;
 *   only `canceled`/`unpaid`/deleted lock the org out of the dashboard.
 */
export async function handleStripeSubscriptionEvent(
  event: StripeSubscriptionEvent,
  /** The instant a revocation is stamped at. Production omits it; a fixed-clock
   * fixture passes the same instant it will evaluate the projection at, so the
   * two cannot disagree about which side of a boundary an event landed on. */
  now?: number,
): Promise<HandleResult> {
  return db.transaction((tx) =>
    applyStripeSubscriptionEvent(tx, event, undefined, now),
  );
}

/**
 * `stripe_events` is `id, type, processed_at` and carries no org, so a
 * duplicate resolves one the only way available: `subscriptions.id` IS the
 * Stripe subscription id. The caller needs it because a redelivery is the
 * ONLY second chance a post-processing arm gets after the projection has
 * already committed.
 */
async function duplicateResult(
  reader: Pick<typeof db, "select"> | Tx,
  subscriptionId: string,
  kind: StripeWebhookKind = null,
  invoiceId: string | null = null,
): Promise<Extract<ProcessStripeSubscriptionResult, { status: "duplicate" }>> {
  const [row] = await reader
    .select({ organizationId: subscriptions.organizationId })
    .from(subscriptions)
    .where(eq(subscriptions.id, subscriptionId));
  return {
    status: "duplicate",
    organizationId: row?.organizationId ?? null,
    kind,
    subscriptionId,
    invoiceId,
  };
}

/** Whether the canonical subscription's expanded latest invoice is the named
 * one and reads paid/unpaid. `"unknown"` when the expansion carries no
 * evidence for THIS invoice (absent, an id string, or a different invoice). */
function canonicalInvoiceEvidence(
  canonical: StripeSubscriptionLike,
  invoiceId: string | null,
): "paid" | "unpaid" | "unknown" {
  const invoice = canonical.latest_invoice;
  if (!invoiceId || !invoice || typeof invoice === "string") return "unknown";
  if (invoice.id !== invoiceId) return "unknown";
  return invoice.status === "paid" && invoice.amount_remaining === 0
    ? "paid"
    : "unpaid";
}

/**
 * The typed meaning of an event, read off the CANONICAL subscription. A
 * stale delivery keeps its projection (newest provider state wins) but
 * loses its kind: a failure Stripe already recovered from must not email
 * "payment failed", and the trial's zero-amount invoice must not email a
 * receipt. Amounts come from the delivered invoice when present, else the
 * canonical expansion of that same invoice.
 */
function webhookKind(args: {
  eventType: string;
  canonical: StripeSubscriptionLike;
  invoice: StripeInvoiceLike | null;
  invoiceId: string | null;
}): StripeWebhookKind {
  const { eventType, canonical, invoice, invoiceId } = args;
  if (eventType === "customer.subscription.created") {
    return canonical.status === "trialing" ? "trial_started" : null;
  }
  if (eventType === "customer.subscription.trial_will_end") {
    return "trial_will_end";
  }
  if (eventType === "invoice.payment_failed") {
    const evidence = canonicalInvoiceEvidence(canonical, invoiceId);
    if (evidence === "paid") return null;
    if (evidence === "unpaid") return "payment_failed";
    return canonical.status === "past_due" ||
      canonical.status === "unpaid" ||
      canonical.status === "incomplete"
      ? "payment_failed"
      : null;
  }
  if (eventType === "invoice.paid") {
    if (canonicalInvoiceEvidence(canonical, invoiceId) === "unpaid") {
      return null;
    }
    const latest = canonical.latest_invoice;
    const canonicalAmount =
      latest && typeof latest !== "string" && latest.id === invoiceId
        ? latest.amount_paid
        : undefined;
    const amount = invoice?.amount_paid ?? invoice?.amount_due ?? canonicalAmount;
    return amount != null && amount > 0 ? "payment_paid" : null;
  }
  if (eventType === "charge.refunded") return "refunded";
  return null;
}

/** The kind a redelivery can still report without a provider read: the
 * stored row's status stands in for canonical state (it IS the last
 * canonical projection), which is what lets the route's post-processing arm
 * retry an email after a crash between the claim and the send. */
function storedKind(args: {
  eventType: string;
  storedStatus: string | null;
  invoice: StripeInvoiceLike | null;
}): StripeWebhookKind {
  const { eventType, storedStatus, invoice } = args;
  if (eventType === "customer.subscription.created") {
    return storedStatus === "trialing" ? "trial_started" : null;
  }
  if (eventType === "invoice.payment_failed") {
    return storedStatus === "past_due" ||
      storedStatus === "unpaid" ||
      storedStatus === "incomplete"
      ? "payment_failed"
      : null;
  }
  if (eventType === "invoice.paid") {
    const amount = invoice?.amount_paid ?? invoice?.amount_due;
    return amount != null && amount > 0 ? "payment_paid" : null;
  }
  // trial_will_end and refunded carry no canonical-state condition.
  return webhookKind({
    eventType,
    canonical: { id: "", customer: "", status: storedStatus ?? "" },
    invoice,
    invoiceId: invoice?.id ?? null,
  });
}

async function earlyDuplicateResult(args: {
  eventType: string;
  subscriptionId: string;
  invoice: StripeInvoiceLike | null;
  invoiceId: string | null;
}): Promise<Extract<ProcessStripeSubscriptionResult, { status: "duplicate" }>> {
  const [row] = await db
    .select({
      organizationId: subscriptions.organizationId,
      status: subscriptions.status,
    })
    .from(subscriptions)
    .where(eq(subscriptions.id, args.subscriptionId));
  return {
    status: "duplicate",
    organizationId: row?.organizationId ?? null,
    // No stored row means the subscription was never Engager's to project
    // (a foreign event claimed as ignored): the delivered invoice alone
    // must not manufacture a kind for it on redelivery.
    kind: row
      ? storedKind({
          eventType: args.eventType,
          storedStatus: row.status,
          invoice: args.invoice,
        })
      : null,
    subscriptionId: args.subscriptionId,
    invoiceId: args.invoiceId,
  };
}

/**
 * Durable webhook inbox for subscription changes. A recoverable lease serializes
 * canonical reads; provider I/O happens outside a transaction; event claim and
 * projection commit together in one short transaction. Any failure leaves the
 * event unclaimed so Stripe can retry.
 */
type StripeEventProcessing = {
  eventId: string;
  eventType: string;
  subscriptionId: string;
  invoice: StripeInvoiceLike | null;
  invoiceId: string | null;
  loadCanonical: (subscriptionId: string) => Promise<StripeSubscriptionLike>;
  /** The provider write that ENDS the subscription at once, for an event that
   * calls for it (a full refund). Run under the lease, only on a subscription
   * that is Engager's and not already over; its response is never state. */
  endSubscription?: (subscriptionId: string) => Promise<unknown>;
};

/**
 * The one durable-inbox flow every processed Stripe event takes, whatever
 * object it arrived on: claim the subscription's projection lease, fetch the
 * canonical subscription OUTSIDE any transaction, then claim the event and
 * project in one short transaction. The event type chooses the result's
 * `kind` only — through canonical state, in `webhookKind` — and never the
 * projected state. A foreign subscription (another product on this Stripe
 * account) is claimed and ignored. Any failure before the transaction
 * commits leaves the event unclaimed so Stripe retries.
 *
 * An event that ends the subscription (`endSubscription`) writes to the
 * provider here, under the same lease, and is then projected from a FRESH
 * canonical read in the very transaction that claims it. A redelivery after a
 * crash between the write and the claim reads the subscription already over
 * and writes nothing: reconcile by reading, never blind-retry an uncertain
 * provider write.
 */
async function processStripeEventForSubscription(
  args: StripeEventProcessing,
): Promise<ProcessStripeSubscriptionResult> {
  const { eventId, eventType, subscriptionId, invoice, invoiceId } = args;
  const [alreadyProcessed] = await db
    .select({ id: stripeEvents.id })
    .from(stripeEvents)
    .where(eq(stripeEvents.id, eventId));
  if (alreadyProcessed) {
    return earlyDuplicateResult({
      eventType,
      subscriptionId,
      invoice,
      invoiceId,
    });
  }

  return withStripeProjectionLease(subscriptionId, async (leaseToken) => {
    // Provider I/O deliberately occurs after the durable lease claim and before
    // the short event/projection transaction.
    let canonical = await projectCanonicalStripeSubscription(
      subscriptionId,
      eventType,
      args.loadCanonical,
    );
    if (args.endSubscription) {
      const items = canonical.canonical.items?.data ?? [];
      const item = items.length === 1 ? items[0] : undefined;
      const offer = item
        ? offerProvenanceForItem({
            priceId: item.price.id,
            quantity: item.quantity ?? 1,
            unitAmount: item.price.unit_amount,
            currency: item.price.currency,
            interval: item.price.recurring?.interval,
          })
        : null;
      if (!offer) {
        return claimIgnoredStripeEvent({
          eventId,
          eventType,
          subscriptionId,
          invoiceId,
        });
      }
      if (!SUBSCRIPTION_OVER.has(canonical.canonical.status)) {
        await args.endSubscription(subscriptionId);
        canonical = await projectCanonicalStripeSubscription(
          subscriptionId,
          eventType,
          args.loadCanonical,
        );
      }
      if (!SUBSCRIPTION_OVER.has(canonical.canonical.status)) {
        // A write response is not proof. Leave the event unclaimed until a
        // canonical read confirms that the refunded generation has ended.
        throw new Error("Refund cancellation is not confirmed yet");
      }
    }
    const kind = webhookKind({
      eventType,
      canonical: canonical.canonical,
      invoice,
      invoiceId,
    });
    return db.transaction(async (tx) => {
      await fenceStripeProjectionLease(tx, subscriptionId, leaseToken);
      const inserted = await tx
        .insert(stripeEvents)
        .values({ id: eventId, type: eventType })
        .onConflictDoNothing()
        .returning({ id: stripeEvents.id });
      if (inserted.length === 0) {
        return duplicateResult(tx, subscriptionId, kind, invoiceId);
      }
      if (!(await isEngagerSubscriptionProjection(tx, canonical.canonical))) {
        return {
          status: "ignored" as const,
          kind: null,
          organizationId: null,
          subscriptionId,
          invoiceId,
        };
      }
      const result = await applyStripeSubscriptionEvent(
        tx, canonical.event, undefined, Date.now(), args.endSubscription !== undefined,
      );
      if (!result.ok) {
        throw new Error("Stripe subscription ownership is not established yet");
      }
      return {
        status: "processed" as const,
        organizationId: result.organizationId,
        kind,
        subscriptionId,
        invoiceId,
      };
    });
  });
}

/** Claim an event that names no subscription before answering `ignored`,
 * in its own transaction, so a redelivery answers `duplicate` instead of
 * re-running the ignore path forever. There is nothing to project and no
 * post-processing arm could ever run for it, so the kind stays null. */
async function claimIgnoredStripeEvent(args: {
  eventId: string;
  eventType: string;
  subscriptionId: string | null;
  invoiceId: string | null;
}): Promise<ProcessStripeSubscriptionResult> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(stripeEvents)
      .values({ id: args.eventId, type: args.eventType })
      .onConflictDoNothing()
      .returning({ id: stripeEvents.id });
    if (inserted.length === 0) {
      return {
        status: "duplicate" as const,
        organizationId: null,
        kind: null,
        subscriptionId: args.subscriptionId,
        invoiceId: args.invoiceId,
      };
    }
    return {
      status: "ignored" as const,
      kind: null,
      organizationId: null,
      subscriptionId: args.subscriptionId,
      invoiceId: args.invoiceId,
    };
  });
}

export async function processStripeSubscriptionEvent(
  eventId: string,
  event: ReceivedStripeSubscriptionEvent,
  loadCanonical: (subscriptionId: string) => Promise<StripeSubscriptionLike>,
): Promise<ProcessStripeSubscriptionResult> {
  return processStripeEventForSubscription({
    eventId,
    eventType: event.type,
    subscriptionId: event.data.object.id,
    invoice: null,
    invoiceId: null,
    loadCanonical,
  });
}

/**
 * Durable inbox for `invoice.payment_failed` / `invoice.paid`. The invoice
 * names its subscription; everything after that is the subscription flow
 * above. An invoice with no subscription (a one-off invoice on this Stripe
 * account) is claimed and ignored — there is nothing to project, but the
 * claim is what makes its redelivery answer `duplicate`.
 */
export async function processStripeInvoiceEvent(
  eventId: string,
  event: ReceivedStripeInvoiceEvent,
  loadCanonical: (subscriptionId: string) => Promise<StripeSubscriptionLike>,
): Promise<ProcessStripeSubscriptionResult> {
  const invoice = event.data.object;
  const subscriptionId = stripeInvoiceSubscriptionId(invoice);
  if (!subscriptionId) {
    return claimIgnoredStripeEvent({
      eventId,
      eventType: event.type,
      subscriptionId: null,
      invoiceId: invoice.id,
    });
  }
  return processStripeEventForSubscription({
    eventId,
    eventType: event.type,
    subscriptionId,
    invoice,
    invoiceId: invoice.id,
    loadCanonical,
  });
}

/**
 * Durable inbox for `charge.refunded`. A FULL refund ends the subscription
 * at once (US-ONA-06, O-4): the charge names its invoice, an unexpanded
 * invoice id is resolved through `loadInvoice`, or a payment intent through
 * `loadPaymentInvoice` on Basil (a provider read, made before
 * the projection lease because the lease is keyed on the subscription the
 * read identifies), and `cancelSubscription` ends that subscription under the
 * lease if it is Engager's and still running. The projection then reads
 * `refunded`. A PARTIAL refund changes nothing and is claimed and ignored,
 * as is a charge with no invoice (or whose invoice names no subscription):
 * not subscription revenue. Claiming is what makes a redelivery answer
 * `duplicate` and cancel nothing twice.
 */
export async function processStripeChargeEvent(
  eventId: string,
  event: ReceivedStripeChargeEvent,
  loadCanonical: (subscriptionId: string) => Promise<StripeSubscriptionLike>,
  loadInvoice?: (invoiceId: string) => Promise<StripeInvoiceLike>,
  cancelSubscription?: (subscriptionId: string) => Promise<unknown>,
  loadPaymentInvoice?: (
    paymentIntentId: string,
  ) => Promise<StripeInvoiceLike | null>,
): Promise<ProcessStripeSubscriptionResult> {
  const charge = event.data.object;
  const paymentIntentId =
    typeof charge.payment_intent === "string"
      ? charge.payment_intent
      : charge.payment_intent?.id;
  if (charge.refunded !== true) {
    return claimIgnoredStripeEvent({
      eventId,
      eventType: event.type,
      subscriptionId: null,
      invoiceId: null,
    });
  }
  if (!cancelSubscription) {
    throw new Error("A subscription canceller is required for refunds");
  }
  // Answer a redelivery before the provider read: the claimed event needs
  // no invoice to know it was already handled.
  const [alreadyProcessed] = await db
    .select({ id: stripeEvents.id })
    .from(stripeEvents)
    .where(eq(stripeEvents.id, eventId));
  if (alreadyProcessed) {
    const expanded =
      charge.invoice && typeof charge.invoice !== "string"
        ? charge.invoice
        : null;
    const knownSubscriptionId = expanded
      ? stripeInvoiceSubscriptionId(expanded)
      : null;
    if (knownSubscriptionId) {
      return earlyDuplicateResult({
        eventType: event.type,
        subscriptionId: knownSubscriptionId,
        invoice: expanded,
        invoiceId: expanded!.id,
      });
    }
    if (!charge.invoice && !paymentIntentId) {
      return {
        status: "duplicate",
        organizationId: null,
        kind: null,
        subscriptionId: null,
        invoiceId: null,
      };
    }
    // An id-only invoice or payment still needs the provider read below to
    // name its subscription (and with it the redelivery's org and kind).
  }
  let invoice: StripeInvoiceLike | null = null;
  if (typeof charge.invoice === "string") {
    if (charge.invoice) {
      if (!loadInvoice) {
        throw new Error("A charge invoice loader is required for refunds");
      }
      invoice = await loadInvoice(charge.invoice);
    }
  } else if (charge.invoice) {
    invoice = charge.invoice;
  }
  if (!invoice && paymentIntentId) {
    if (!loadPaymentInvoice) {
      throw new Error("A payment invoice loader is required for refunds");
    }
    invoice = await loadPaymentInvoice(paymentIntentId);
  }
  const subscriptionId = invoice ? stripeInvoiceSubscriptionId(invoice) : null;
  if (!invoice || !subscriptionId) {
    return claimIgnoredStripeEvent({
      eventId,
      eventType: event.type,
      subscriptionId: null,
      invoiceId: invoice?.id ?? null,
    });
  }
  return processStripeEventForSubscription({
    eventId,
    eventType: event.type,
    subscriptionId,
    invoice,
    invoiceId: invoice.id,
    loadCanonical,
    endSubscription: cancelSubscription,
  });
}

/**
 * Idempotency gate: record a Stripe event id; returns false if it was already
 * processed. Stripe redelivers webhooks, so the route MUST skip duplicates before
 * projecting them. `stripe_events` is global (no org scope).
 */
export async function recordStripeEvent(
  eventId: string,
  type: string,
): Promise<boolean> {
  const inserted = await db
    .insert(stripeEvents)
    .values({ id: eventId, type })
    .onConflictDoNothing()
    .returning({ id: stripeEvents.id });
  return inserted.length > 0;
}

export type CanonicalSubscriptionReconciliation = {
  canonical: StripeSubscriptionLike;
  result: HandleResult;
};

/** Serialize a provider mutation with canonical refetch + fenced projection.
 * The mutation result is intentionally ignored: Stripe webhooks or customer
 * Portal actions can race the update, so only a fresh provider read made while
 * this lease is held is allowed to become the local projection. */
export async function mutateAndReconcileSubscription(opts: {
  subscriptionId: string;
  organizationId: string;
  mutate: (subscriptionId: string) => Promise<unknown>;
  loadCanonical: (subscriptionId: string) => Promise<StripeSubscriptionLike>;
}): Promise<CanonicalSubscriptionReconciliation> {
  return withStripeProjectionLease(opts.subscriptionId, async (leaseToken) => {
    await opts.mutate(opts.subscriptionId);
    const canonical = await projectCanonicalStripeSubscription(
      opts.subscriptionId,
      "customer.subscription.updated",
      opts.loadCanonical,
    );
    const result = await db.transaction(async (tx) => {
      await fenceStripeProjectionLease(tx, opts.subscriptionId, leaseToken);
      return applyStripeSubscriptionEvent(
        tx,
        canonical.event,
        opts.organizationId,
      );
    });
    return { canonical: canonical.canonical, result };
  });
}

/**
 * Refetch the canonical subscription under the same per-subscription lock as the
 * webhook and project it. This prevents a replayed Checkout success URL from
 * projecting a stale pre-cancellation object.
 */
export async function reconcileSubscription(opts: {
  subscriptionId: string;
  organizationId: string;
  loadCanonical: (subscriptionId: string) => Promise<StripeSubscriptionLike>;
}): Promise<HandleResult> {
  const { result } = await mutateAndReconcileSubscription({
    ...opts,
    mutate: async () => {},
  });
  return result;
}
