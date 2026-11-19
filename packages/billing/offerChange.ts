import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { commercialOfferIntents, subscriptions } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { ENGAGER_OFFERS, offerPriceId, type OfferId } from "./offer";
import { commercialProjection, type CommercialProjection } from "./projection";
import {
  hasPaidOfferInvoice,
  periodEndSec,
  type StripeSubscriptionLike,
} from "./webhooks";

/**
 * Changing which offer an account is on is a durable saga, not a second
 * Checkout (ADR-05). One owner has exactly one recurring Engager offer, so an
 * upgrade or downgrade CHANGES the existing provider subscription item under a
 * recorded intent; it never creates a second recurring subscription and never
 * provisions a second tenant.
 *
 * The intent is written BEFORE any provider call, carrying the exact quote the
 * owner accepted and the exact subscription revision it was computed against.
 * That makes a lost provider response reconcilable: the retry finds the intent,
 * refetches canonical provider state, and decides — it never repeats a mutation
 * blindly. No proration is invented here; an unvalidated quote refuses the
 * change before anything is charged.
 */
export type OfferQuote = {
  toOfferId: OfferId;
  /** The immediate amount the PROVIDER computed, in minor units. */
  unitAmount: number;
  currency: string;
  /** Unused-time credit the provider computed, in minor units, when any. */
  creditAmount: number | null;
  expiresAt: number;
  /** The provider revision this quote was computed on. */
  subscriptionRevision: string;
};

export type OfferChangeIntent = typeof commercialOfferIntents.$inferSelect;

export type RecordIntentResult =
  | { status: "recorded" | "resumable"; intent: OfferChangeIntent }
  | {
      status:
        | "no_active_offer"
        | "already_on_offer"
        | "quote_stale"
        | "quote_not_validated"
        | "change_in_progress"
        | "change_scheduled";
      reason: string;
    };

/**
 * A local fingerprint of everything about a provider subscription that a quote
 * depends on. Recomputed at apply time; any drift invalidates the quote before
 * the provider is touched, which is what "reject stale quotes" means in code.
 */
export function subscriptionRevisionFingerprint(input: {
  subscriptionId: string;
  status: string;
  items: readonly { priceId: string; quantity: number }[];
  periodEndsAt: number | null;
  cancelAtPeriodEnd: boolean;
  commercialGeneration: number;
}): string {
  return createHash("sha256")
    .update(
      [
        input.subscriptionId,
        input.status,
        [...input.items]
          .map((item) => `${item.priceId}:${item.quantity}`)
          .sort()
          .join(","),
        String(input.periodEndsAt ?? ""),
        String(input.cancelAtPeriodEnd),
        String(input.commercialGeneration),
      ].join("\n"),
    )
    .digest("hex")
    .slice(0, 32);
}

async function currentRevision(
  tx: Tx,
  subscriptionId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({
      id: subscriptions.id,
      status: subscriptions.status,
      items: subscriptions.items,
      periodEndsAt: subscriptions.periodEndsAt,
      cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
      commercialGeneration: subscriptions.commercialGeneration,
    })
    .from(subscriptions)
    .where(eq(subscriptions.id, subscriptionId));
  if (!row) return null;
  return subscriptionRevisionFingerprint({
    subscriptionId: row.id,
    status: row.status,
    items: (row.items ?? []).map((item) => ({
      priceId: item.priceId,
      quantity: item.quantity,
    })),
    periodEndsAt: row.periodEndsAt,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    commercialGeneration: row.commercialGeneration,
  });
}

/** Upgrades take effect immediately once payment is authoritative; downgrades
 * are scheduled for the paid period end, so Mac service continues under the
 * current cloud capability until the replacement period starts. An upgrade is
 * the move to the offer whose capabilities strictly include the current
 * offer's — capability order, never a price comparison: money lives on the
 * Stripe Price, not in this catalogue. */
export function offerChangeTiming(
  from: OfferId,
  to: OfferId,
): "immediate" | "period_end" {
  const held = ENGAGER_OFFERS[from].capabilities;
  const next = ENGAGER_OFFERS[to].capabilities;
  const upgrade =
    next.length > held.length &&
    held.every((capability) => next.includes(capability));
  return upgrade ? "immediate" : "period_end";
}

export async function recordOfferChangeIntent(
  tx: Tx,
  input: {
    organizationId: string;
    quote: OfferQuote;
    now: number;
  },
): Promise<RecordIntentResult> {
  const projection = await commercialProjection(tx, input.organizationId, {
    now: input.now,
    lock: true,
  });
  if (!projection.offerId || !projection.subscriptionId) {
    return {
      status: "no_active_offer",
      reason:
        "There is no recurring Engager offer to change. Start one instead of replacing nothing.",
    };
  }
  if (projection.offerId === input.quote.toOfferId) {
    return {
      status: "already_on_offer",
      reason: `This account is already on ${ENGAGER_OFFERS[projection.offerId].name}.`,
    };
  }
  if (!offerPriceId(input.quote.toOfferId)) {
    return {
      status: "quote_not_validated",
      reason: "The requested offer has no configured provider price.",
    };
  }
  if (input.quote.expiresAt <= input.now) {
    return { status: "quote_stale", reason: "This quote has expired." };
  }
  const revision = await currentRevision(tx, projection.subscriptionId);
  if (revision === null || revision !== input.quote.subscriptionRevision) {
    return {
      status: "quote_stale",
      reason:
        "The subscription changed after this quote was computed. Request a fresh price before changing.",
    };
  }

  // One open intent per organization is a unique index, not a check here: two
  // concurrent requests must not both believe they own the change.
  const existing = await openOfferChangeIntent(tx, input.organizationId);
  if (existing) {
    // An accepted schedule is settled work waiting for a date, so retrying it
    // is not a resumable dispatch: say when it starts rather than mutating the
    // provider again.
    if (existing.status === "scheduled") {
      // Say what happens next rather than naming an action no surface offers:
      // the provider landing the replacement offer is what settles this, and
      // the projection that lands it does exactly that (`webhooks.ts`).
      return {
        status: "change_scheduled",
        reason: `${ENGAGER_OFFERS[existing.toOfferId].name} already starts at the end of the current paid period. It settles by itself at that boundary; another change can be started once it has.`,
      };
    }
    // A retry of the SAME change resumes its intent and its provider operation
    // id; a different target while one change is open is refused outright.
    return existing.toOfferId === input.quote.toOfferId
      ? { status: "resumable", intent: existing }
      : {
          status: "change_in_progress",
          reason:
            "Another offer change is still reconciling. Resolve it before starting a different one.",
        };
  }

  const [intent] = await tx
    .insert(commercialOfferIntents)
    .values({
      organizationId: input.organizationId,
      fromSubscriptionId: projection.subscriptionId,
      fromOfferId: projection.offerId,
      toOfferId: input.quote.toOfferId,
      quoteUnitAmount: input.quote.unitAmount,
      quoteCurrency: input.quote.currency.toLowerCase(),
      quoteCreditAmount: input.quote.creditAmount,
      quoteExpiresAt: input.quote.expiresAt,
      quoteSubscriptionRevision: input.quote.subscriptionRevision,
      effectiveAt:
        offerChangeTiming(projection.offerId, input.quote.toOfferId) ===
        "period_end"
          ? projection.paidThrough
          : null,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();
  return { status: "recorded", intent: intent! };
}

export type OfferChangePorts = {
  /** Change the EXISTING subscription item, or schedule that change for the
   * next period. Carries the intent's stable operation id as the provider
   * idempotency key, so a retried dispatch is one provider mutation, and the
   * catalogue's exact quantity rather than the provider's default. */
  changeSubscriptionOffer(input: {
    subscriptionId: string;
    priceId: string;
    quantity: number;
    timing: "immediate" | "period_end";
    idempotencyKey: string;
    scheduleId?: string | null;
    effectiveAt?: number | null;
    checkpointSchedule?: (scheduleId: string) => Promise<void>;
    acceptedQuote?: {
      unitAmount: number;
      currency: string;
      creditAmount: number | null;
      prorationDate: number;
    };
  }): Promise<void>;
  loadCanonical(subscriptionId: string): Promise<StripeSubscriptionLike>;
};

export type ApplyIntentResult =
  | {
      status: "applied";
      intent: OfferChangeIntent;
      projection: CommercialProjection;
    }
  | { status: "already_applied"; intent: OfferChangeIntent }
  | {
      status: "quote_stale" | "needs_reconciliation" | "unknown_intent";
      reason: string;
    };

/** Whether canonical provider state already carries the requested offer. This is
 * what a lost response is reconciled against — never a repeated mutation. */
export function canonicalCarriesOffer(
  canonical: StripeSubscriptionLike,
  offerId: OfferId,
): boolean {
  const priceId = offerPriceId(offerId);
  const items = canonical.items?.data ?? [];
  return (
    priceId != null &&
    items.length === 1 &&
    items[0]!.price.id === priceId &&
    (items[0]!.quantity ?? 1) === ENGAGER_OFFERS[offerId].quantity
  );
}

export type CanonicalChangeOutcome =
  | { outcome: "applied" }
  /** The provider holds a schedule; the current offer runs to `effectiveAt`. */
  | { outcome: "scheduled"; effectiveAt: number }
  | { outcome: "pending" }
  | { outcome: "not_applied" };

/**
 * What canonical provider state MEANS for one dispatched change.
 *
 * The distinction this function exists for: a downgrade is scheduled for the
 * paid period end (PRODUCT.md), so the provider legitimately still reports the
 * CURRENT offer afterwards. Reading that as "the change did not land" would
 * settle a correct change as failed and — worse — invite a second mutation to
 * strip a capability the owner has already paid for. A schedule against the
 * period boundary is the evidence; an unchanged subscription with no schedule
 * at all is a genuine failure and still says so.
 */
export function classifyCanonicalChange(input: {
  intent: OfferChangeIntent;
  canonical: StripeSubscriptionLike;
  timing: "immediate" | "period_end";
}): CanonicalChangeOutcome {
  if (canonicalCarriesOffer(input.canonical, input.intent.toOfferId)) {
    if (
      input.timing === "immediate" &&
      !hasPaidOfferInvoice(input.canonical, input.intent)
    ) {
      return { outcome: "pending" };
    }
    return { outcome: "applied" };
  }
  if (input.timing === "immediate" && input.canonical.pending_update)
    return { outcome: "pending" };
  const schedule =
    typeof input.canonical.schedule === "object"
      ? input.canonical.schedule
      : null;
  const periodEnd = periodEndSec(input.canonical);
  const subscription = schedule?.subscription;
  const future = schedule?.phases?.filter(
    (phase) => phase.start_date === periodEnd,
  );
  const target = future?.length === 1 ? future[0] : null;
  if (
    input.timing === "period_end" &&
    schedule?.status === "active" &&
    (typeof subscription === "string" ? subscription : subscription?.id) ===
      input.canonical.id &&
    target != null &&
    target.end_date > target.start_date &&
    target.items.length === 1 &&
    (typeof target.items[0]!.price === "string"
      ? target.items[0]!.price
      : target.items[0]!.price.id) === offerPriceId(input.intent.toOfferId) &&
    (target.items[0]!.quantity ?? 1) ===
      ENGAGER_OFFERS[input.intent.toOfferId].quantity &&
    input.intent.effectiveAt === (periodEnd ?? 0) * 1000 &&
    // The offer being replaced must still be the one running: a schedule over
    // some third price is not this change.
    input.intent.fromOfferId != null &&
    canonicalCarriesOffer(input.canonical, input.intent.fromOfferId) &&
    typeof periodEnd === "number"
  ) {
    return { outcome: "scheduled", effectiveAt: periodEnd * 1000 };
  }
  if (input.timing === "period_end" && input.canonical.schedule)
    return { outcome: "pending" };
  return { outcome: "not_applied" };
}

/** Move the intent to `dispatched` before provider I/O, inside the caller's
 * transaction. A crash after this leaves a durable record to reconcile.
 *
 * Deliberately not every open status: a `scheduled` change has already been
 * accepted by the provider, and re-dispatching it would be a second mutation
 * against a change that is only waiting for a date. */
export async function markIntentDispatched(
  tx: Tx,
  intentId: string,
  now: number,
): Promise<OfferChangeIntent | undefined> {
  const [row] = await tx
    .update(commercialOfferIntents)
    .set({ status: "dispatched", updatedAt: now })
    .where(
      and(
        eq(commercialOfferIntents.id, intentId),
        inArray(commercialOfferIntents.status, ["recorded", "dispatched"]),
      ),
    )
    .returning();
  return row;
}

export async function settleIntent(
  tx: Tx,
  input: {
    intentId: string;
    status: "scheduled" | "applied" | "failed" | "abandoned";
    appliedSubscriptionId?: string | null;
    appliedGeneration?: number | null;
    /** When a scheduled change starts. Omitted rather than nulled by the
     * settle that later lands it, so the boundary stays in the audit trail. */
    effectiveAt?: number | null;
    lastError?: string | null;
    now: number;
  },
): Promise<OfferChangeIntent | undefined> {
  const [row] = await tx
    .update(commercialOfferIntents)
    .set({
      status: input.status,
      appliedSubscriptionId: input.appliedSubscriptionId ?? null,
      appliedGeneration: input.appliedGeneration ?? null,
      ...(input.effectiveAt === undefined
        ? {}
        : { effectiveAt: input.effectiveAt }),
      lastError: input.lastError ?? null,
      updatedAt: input.now,
    })
    .where(eq(commercialOfferIntents.id, input.intentId))
    .returning();
  return row;
}

/** Every status that is not a resolved end state, including `scheduled`: a
 * change waiting for the paid period boundary is still this organization's one
 * open change, and reconciliation must be able to find it there. */
const OPEN_STATUSES = ["recorded", "dispatched", "scheduled"] as const;

export async function openOfferChangeIntent(
  tx: Tx,
  organizationId: string,
): Promise<OfferChangeIntent | undefined> {
  const [row] = await tx
    .select()
    .from(commercialOfferIntents)
    .where(
      and(
        eq(commercialOfferIntents.organizationId, organizationId),
        inArray(commercialOfferIntents.status, [...OPEN_STATUSES]),
      ),
    );
  return row;
}

/** Re-validate a recorded intent immediately before the provider mutation. The
 * quote is bound to the subscription revision AND the wall clock; either moving
 * refuses the change rather than charging against a stale price. */
export async function intentStillValid(
  tx: Tx,
  intent: OfferChangeIntent,
  now: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (intent.quoteExpiresAt <= now) {
    return { ok: false, reason: "This quote has expired." };
  }
  if (!intent.fromSubscriptionId) {
    return { ok: false, reason: "This intent names no subscription to change." };
  }
  const revision = await currentRevision(tx, intent.fromSubscriptionId);
  if (revision === null || revision !== intent.quoteSubscriptionRevision) {
    return {
      ok: false,
      reason:
        "The subscription changed after this quote was computed. Request a fresh price before changing.",
    };
  }
  return { ok: true };
}
