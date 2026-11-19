import { and, eq } from "drizzle-orm";
import {
  billingCheckoutClaims,
  memberships,
  organizations,
  subscriptions,
  users,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { deviceIdForKey } from "./claims";
import {
  retrieveCheckoutSessionStatus,
  retrieveDefaultCard,
  retrieveLatestFailedInvoice,
  type CheckoutSessionStatus,
} from "./client";
import type { OfferId, PlanPrice } from "./offer";
import { readOfferPrice, type OfferPrice } from "./offerPrice";
import {
  commercialProjection,
  type CommercialState,
} from "./projection";
import { listSeats } from "./seats";
import { decideTrial } from "./trialEligibility";

/**
 * The ONE plan read (US-ONA-07). The app (through the cloud licence route)
 * and the web (server-side, no HTTP hop) both ask this function about an
 * account's plan, trial, card and Mac, and both render the words
 * `./planWords` derives from the answer — so the two surfaces can never
 * disagree because each re-derived the plan its own way.
 *
 * Read-only. It never mints or touches a seat, never decides eligibility on
 * a client's say-so (the caller passes the AUTHENTICATED owner's identity,
 * never a request field), and logs nothing: no email, no card digits, no
 * Stripe ids. Every amount comes from Stripe (the configured Price, the
 * failed invoice, the default payment method); none is a constant.
 *
 * Cost bound: the app polls every 5 seconds, so Stripe is read through a
 * one-minute cache with in-flight dedup — within one server process, 12
 * polls in a minute fetch the Price, the card and the failed invoice at
 * most once each. The cloud runs serverless, so the bound is per warm
 * instance (a cold instance re-reads once, then serves from cache); the
 * reads are cheap single-object GETs and the poll itself never fans out.
 * An organization with no subscription makes no per-account Stripe call
 * at all (the offer Price is a shared, offer-level cached read), with one
 * exception: while a Checkout claim holds a session and no active
 * subscription row exists, that session's status is read for
 * `activating` — at most once per 5 seconds per (organization, session)
 * on a warm instance, so the 5-second poll costs at most one extra GET
 * per poll and only during the brief activating window. Callers that
 * already read the Price outside the transaction simply warm that cache;
 * the read here then costs nothing.
 */

export type PlanState =
  | "none"
  | "trialing"
  | "active"
  | "past_due"
  | "paused"
  | "cancelled"
  | "expired";

export type PlanCard = {
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
};

export type PlanSeatState =
  | "this_mac"
  | "free"
  | "other_mac"
  | "removed"
  | "unknown";

export type PlanCheck = {
  plan: { state: PlanState; cancelAtPeriodEnd: boolean };
  trial: {
    eligible: boolean;
    /** The configured trial length, when a trial is on offer or running. */
    days: number | null;
    /** The running trial's last instant. Null when a trial is not running. */
    endsAt: number | null;
    /** Whole days remaining, rounded up: the last day reads 1, never 0
     * while access is granted. Null when a trial is not running. */
    daysLeft: number | null;
  };
  /** The offer's price exactly as Stripe reported it, or null when Stripe
   * could not be read — never an invented amount. */
  price: PlanPrice | null;
  /** The trial's first charge, or the next renewal while active and not
   * cancelling. Null at every other time. */
  nextCharge: { at: number; amount: number; currency: string } | null;
  /** The charge that failed, while the account is past due or paused. */
  failedCharge: {
    at: number;
    amount: number;
    currency: string;
    graceEndsAt: number | null;
  } | null;
  /** True exactly while the org's claimed Checkout Session reads
   * `complete` at Stripe and its subscription has not projected into a
   * local row yet (US-ONA-08) — the webhook-lag window. False before the
   * session completes and from the same read that first sees the row. */
  activating: boolean;
  seat: {
    state: PlanSeatState;
    /** The account's one active seat, whatever device key was supplied. */
    active: {
      label: string | null;
      assignedAt: number;
      lastSeenAt: number | null;
    } | null;
  };
  card: PlanCard | null;
  /** The authenticated owner's email, as passed by the caller. */
  email: string;
  /** The effective service end, capped by an earlier revocation. The
   * projection retains the original funded period for accounting. The
   * cancelled/expired card words ("Works until…", "Ended on…") name it. */
  paidThrough: number | null;
  offerId: OfferId | null;
};

/** The projection's states in the plan read's smaller vocabulary. */
export function planStateFor(state: CommercialState): PlanState {
  switch (state) {
    case "no_account":
      return "none";
    case "trialing":
    case "active":
    case "past_due":
    case "paused":
      return state;
    case "cancel_at_period_end":
      return "cancelled";
    case "expired":
    case "refunded":
    case "cancellation_pending":
      return "expired";
  }
}

export type FailedInvoice = { at: number; amount: number; currency: string };

/** Stripe reads, injectable so tests count calls with fakes only. */
export type PlanCheckStripeOps = {
  readPrice?: (offerId: OfferId) => Promise<OfferPrice | null>;
  readCard?: (customerId: string, subscriptionId?: string) => Promise<PlanCard | null>;
  readFailedInvoice?: (customerId: string) => Promise<FailedInvoice | null>;
  readCheckoutSession?: (sessionId: string) => Promise<CheckoutSessionStatus>;
};

const STRIPE_CACHE_TTL_MS = 60_000;
/** The poll's own cadence: a session status may go stale by one poll,
 * never by a minute (US-ONA-08's 5-second cost bound). */
const CHECKOUT_SESSION_CACHE_TTL_MS = 5_000;
const priceCache = new Map<string, { value: OfferPrice | null; at: number }>();
const cardCache = new Map<string, { value: PlanCard | null; at: number }>();
const invoiceCache = new Map<
  string,
  { value: FailedInvoice | null; at: number }
>();
const checkoutSessionCache = new Map<
  string,
  { value: CheckoutSessionStatus | null; at: number }
>();
const inFlight = new Map<string, Promise<unknown>>();

export function clearPlanCheckCacheForTests(): void {
  priceCache.clear();
  cardCache.clear();
  invoiceCache.clear();
  checkoutSessionCache.clear();
  inFlight.clear();
}

/** Short TTL plus in-flight dedup: concurrent polls for the same key
 * share a single provider read instead of stampeding it. */
async function cachedRead<T>(
  cache: Map<string, { value: T | null; at: number }>,
  key: string,
  now: number,
  read: () => Promise<T | null>,
  ttlMs: number = STRIPE_CACHE_TTL_MS,
): Promise<T | null> {
  const hit = cache.get(key);
  if (hit && now - hit.at < ttlMs) return hit.value;
  const pending = inFlight.get(key) as Promise<T | null> | undefined;
  if (pending) return pending;
  const promise = read()
    .catch(() => null)
    .then((value) => {
      cache.set(key, { value, at: now });
      return value;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

async function cachedPrice(
  offerId: OfferId,
  now: number,
  ops: PlanCheckStripeOps,
): Promise<OfferPrice | null> {
  const read =
    ops.readPrice ??
    ((id: OfferId) => readOfferPrice(id, { now }).catch(() => null));
  return cachedRead(priceCache, `price:${offerId}`, now, () => read(offerId));
}

async function cachedCard(
  customerId: string,
  subscriptionId: string,
  now: number,
  ops: PlanCheckStripeOps,
): Promise<PlanCard | null> {
  return cachedRead(cardCache, `card:${customerId}:${subscriptionId}`, now, () =>
    (ops.readCard ?? retrieveDefaultCard)(customerId, subscriptionId),
  );
}

async function cachedFailedInvoice(
  customerId: string,
  now: number,
  ops: PlanCheckStripeOps,
): Promise<FailedInvoice | null> {
  return cachedRead(invoiceCache, `invoice:${customerId}`, now, () =>
    (ops.readFailedInvoice ?? retrieveLatestFailedInvoice)(customerId),
  );
}

async function cachedCheckoutSession(
  organizationId: string,
  sessionId: string,
  now: number,
  ops: PlanCheckStripeOps,
): Promise<CheckoutSessionStatus | null> {
  return cachedRead(
    checkoutSessionCache,
    `checkoutSession:${organizationId}:${sessionId}`,
    now,
    () => (ops.readCheckoutSession ?? retrieveCheckoutSessionStatus)(sessionId),
    CHECKOUT_SESSION_CACHE_TTL_MS,
  );
}

export type PlanCheckInput = {
  organizationId: string;
  /** The AUTHENTICATED owner's email (session/refresh-token proven by the
   * caller). Echoed back as `email`; also resolves the owner when
   * `ownerUserId` is not supplied. */
  userEmail: string;
  /** The authenticated owner's user id, when the caller has it. */
  ownerUserId?: string;
  /** This Mac's seat key, when the caller is the app. Absent on the web. */
  deviceKey?: string;
  now?: number;
};

export async function planCheck(
  tx: Tx,
  input: PlanCheckInput,
  ops: PlanCheckStripeOps = {},
): Promise<PlanCheck> {
  const now = input.now ?? Date.now();
  const { organizationId } = input;

  const projection = await commercialProjection(tx, organizationId, { now });
  const state = planStateFor(projection.state);
  const offerId: OfferId = projection.offerId ?? "mac_monthly_v1";

  const [org] = await tx
    .select({ billingCustomerId: organizations.billingCustomerId })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  // Seat: read-only. `active` is the account's one active seat whatever
  // key was supplied; `state` says how the supplied key stands to it.
  const seats = await listSeats(tx, organizationId);
  const activeSeat = seats.find((seat) => seat.revokedAt == null) ?? null;
  let seatState: PlanSeatState = "unknown";
  if (input.deviceKey != null) {
    const mine = seats.find(
      (seat) => seat.deviceId === deviceIdForKey(input.deviceKey!),
    );
    seatState =
      mine != null
        ? mine.revokedAt != null
          ? "removed"
          : "this_mac"
        : activeSeat != null
          ? "other_mac"
          : "free";
  }

  const offerPrice = await cachedPrice(offerId, now, ops);
  const price: PlanPrice | null = offerPrice
    ? {
        amount: offerPrice.amount,
        currency: offerPrice.currency,
        interval: offerPrice.interval,
      }
    : null;

  // Trial eligibility is the server's decision (US-ONA-02), keyed on the
  // authenticated owner — resolved from the caller's proven identity,
  // never from anything a client asserted about itself.
  let ownerUserId = input.ownerUserId;
  if (ownerUserId == null && input.userEmail) {
    const [owner] = await tx
      .select({ userId: users.id })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.organizationId, organizationId),
          eq(memberships.isOwner, true),
          eq(users.email, input.userEmail),
        ),
      )
      .limit(1);
    ownerUserId = owner?.userId;
  }
  const decision =
    ownerUserId != null
      ? await decideTrial(tx, {
          organizationId,
          ownerUserId,
          ...(offerPrice ? { days: offerPrice.trialDays } : {}),
        })
      : ({ eligible: false } as const);
  const trialing = state === "trialing";
  const trialEndsAt = trialing ? projection.paidThrough : null;
  const trial = {
    eligible: decision.eligible,
    days: decision.eligible
      ? decision.days
      : trialing
        ? (offerPrice?.trialDays ?? null)
        : null,
    endsAt: trialEndsAt,
    daysLeft:
      trialEndsAt != null
        ? Math.max(1, Math.ceil((trialEndsAt - now) / 86_400_000))
        : null,
  };

  // Per-account Stripe reads only ever happen for an account that has a
  // subscription (and therefore a Stripe customer).
  const customerId =
    projection.subscriptionId != null
      ? (org?.billingCustomerId ?? null)
      : null;
  const card = customerId && projection.subscriptionId
    ? await cachedCard(customerId, projection.subscriptionId, now, ops) : null;
  let failedCharge: PlanCheck["failedCharge"] = null;
  if (customerId && (state === "past_due" || state === "paused")) {
    const failed = await cachedFailedInvoice(customerId, now, ops);
    // The amount is the failed invoice's amount due, or nothing: when the
    // invoice cannot be read the charge stays unnamed (the words degrade
    // to a sentence without an amount) rather than borrowing the offer
    // price, which may not be what this invoice tried to collect.
    if (failed) {
      failedCharge = { ...failed, graceEndsAt: projection.graceEndsAt };
    }
  }

  const nextCharge: PlanCheck["nextCharge"] =
    price != null && projection.paidThrough != null &&
    (trialing || (state === "active" && !projection.cancelAtPeriodEnd))
      ? {
          at: projection.paidThrough,
          amount: price.amount,
          currency: price.currency,
        }
      : null;

  // Activating (US-ONA-08): Stripe has taken the payment but the webhook
  // has not projected the subscription yet. The claim is the only local
  // trace of that window, and Stripe is asked only while it can be open —
  // a claim holding a session and no active row; with either missing the
  // answer is false without a provider call. The projected-row check runs
  // AFTER the Stripe read, so a webhook landing mid-read already answers
  // false in this same read rather than one poll later.
  let activating = false;
  const [claim] = await tx
    .select({ checkoutSessionId: billingCheckoutClaims.checkoutSessionId })
    .from(billingCheckoutClaims)
    .where(eq(billingCheckoutClaims.organizationId, organizationId))
    .limit(1);
  if (claim?.checkoutSessionId) {
    const [activeRow] = await tx
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.organizationId, organizationId),
          eq(subscriptions.active, true),
        ),
      )
      .limit(1);
    if (!activeRow) {
      const session = await cachedCheckoutSession(
        organizationId,
        claim.checkoutSessionId,
        now,
        ops,
      );
      // A failed read says nothing about whether payment completed. Let the
      // caller return unavailable rather than restore a purchase action.
      if (!session || !["open", "complete", "expired"].includes(session.status ?? "")) {
        throw new Error("Checkout status is unavailable");
      }
      if (session.status === "complete") {
        let projected = false;
        if (session.subscriptionId) {
          const [row] = await tx
            .select({ id: subscriptions.id })
            .from(subscriptions)
            .where(
              and(
                eq(subscriptions.id, session.subscriptionId),
                eq(subscriptions.organizationId, organizationId),
              ),
            )
            .limit(1);
          projected = row != null;
        }
        activating = !projected;
      }
    }
  }

  return {
    plan: { state, cancelAtPeriodEnd: projection.cancelAtPeriodEnd },
    trial,
    price,
    nextCharge,
    failedCharge,
    activating,
    seat: {
      state: seatState,
      active: activeSeat
        ? {
            label: activeSeat.label,
            assignedAt: activeSeat.assignedAt,
            lastSeenAt: activeSeat.lastSeenAt,
          }
        : null,
    },
    card,
    email: input.userEmail,
    paidThrough: projection.revokedAt == null
      ? projection.paidThrough
      : Math.min(projection.paidThrough ?? projection.revokedAt, projection.revokedAt),
    offerId: projection.offerId,
  };
}
