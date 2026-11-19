import Stripe from "stripe";
import { isEngagerPriceId } from "./plans";

export const GUARDED_TRIAL_CHECKOUT_FLOW = "guarded_trial_v1";

export type CheckoutPriceTerms = {
  priceId: string;
  unitAmount: number;
  currency: string;
  interval: "month" | "year";
  /** The Price's raw `trial_days` metadata, exactly as Stripe reported it
   * (`null` when the key is absent). Kept raw so the one resolver
   * (`resolveTrialDays`) can tell absent from present-but-invalid. */
  trialDaysMetadata?: string | null;
};

/**
 * Thin runtime wrapper around the Stripe SDK. Imported only by code paths that
 * actually talk to Stripe; SDK-free projection logic lives in `./webhooks`.
 */
let stripe: Stripe | undefined;
export const STRIPE_REQUEST_TIMEOUT_MS = 10_000;
export const STRIPE_MAX_NETWORK_RETRIES = 0;

export function getStripe(): Stripe {
  if (!stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
    if (
      process.env.ENGAGER_DEPLOYMENT_ENV === "prod" &&
      !/^(sk|rk)_live_/.test(key)
    ) {
      throw new Error("Production billing requires a live Stripe API key");
    }
    if (
      process.env.ENGAGER_DEPLOYMENT_ENV === "dev" &&
      !/^(sk|rk)_test_/.test(key)
    ) {
      throw new Error("Development billing requires a test Stripe API key");
    }
    // Jobs own durable retries. Keep each provider call bounded so a sequence of
    // guarded-renewal requests cannot outlive the 45s serverless job budget and
    // leave Stripe mutated while local projection is killed.
    stripe = new Stripe(key, {
      timeout: STRIPE_REQUEST_TIMEOUT_MS,
      maxNetworkRetries: STRIPE_MAX_NETWORK_RETRIES,
    });
  }
  return stripe;
}

type ExpandableId = string | { id?: string } | null | undefined;

function expandableId(value: ExpandableId): string | null {
  if (typeof value === "string") return value || null;
  return value?.id || null;
}

export function stripeCustomerId(
  customer: string | { id?: string } | null | undefined,
): string | null {
  return expandableId(customer);
}

export type CreateCustomerOptions = {
  organizationId: string;
  name?: string;
  email?: string;
  /** Stable per-org key so concurrent first-checkout requests reuse one customer. */
  idempotencyKey?: string;
  /** Stripe test clock to attach (US-ONA-09 rehearsal tooling). Honoured
   * only in dev: a test clock cannot exist in live mode, so any other
   * deployment silently creates an ordinary customer. */
  testClockId?: string;
};

export function customerCreateParams(
  opts: CreateCustomerOptions,
): Stripe.CustomerCreateParams {
  return {
    name: opts.name,
    email: opts.email,
    metadata: { organizationId: opts.organizationId },
    ...(opts.testClockId && process.env.ENGAGER_DEPLOYMENT_ENV === "dev"
      ? { test_clock: opts.testClockId }
      : {}),
  };
}

/** Create a Stripe customer for an org. Returns the new customer id. */
export async function createCustomer(
  opts: CreateCustomerOptions,
  deps: {
    createCustomer?: (
      params: Stripe.CustomerCreateParams,
      options?: { idempotencyKey?: string },
    ) => Promise<{ id: string }>;
  } = {},
): Promise<string> {
  const create =
    deps.createCustomer ??
    ((params: Stripe.CustomerCreateParams, options?: { idempotencyKey?: string }) =>
      getStripe().customers.create(params, options));
  const customer = await create(
    customerCreateParams(opts),
    opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : undefined,
  );
  return customer.id;
}

/** Verify + parse a raw webhook payload into a typed Stripe event. */
export function verifyWebhook(
  rawBody: string | Buffer,
  signature: string,
): Stripe.Event {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not set");
  const event = getStripe().webhooks.constructEvent(rawBody, signature, secret);
  if (process.env.ENGAGER_DEPLOYMENT_ENV === "prod" && !event.livemode) {
    throw new Error("Production billing rejects Stripe test events");
  }
  if (process.env.ENGAGER_DEPLOYMENT_ENV === "dev" && event.livemode !== false) {
    throw new Error("Development billing rejects Stripe live events");
  }
  return event;
}

export async function retrieveCheckoutPriceTerms(
  priceId: string,
): Promise<CheckoutPriceTerms> {
  const price = await getStripe().prices.retrieve(priceId);
  return checkoutPriceTermsFromPrice(price);
}

/** Stripe answered, but the configured Price is not one this deployment may
 * sell. Distinct from an unreachable Stripe: callers refuse the sale as
 * `offer_price_invalid` instead of serving a cached amount. */
export class CheckoutPriceInvalidError extends Error {
  readonly code = "offer_price_invalid" as const;
  constructor(message: string) {
    super(message);
    this.name = "CheckoutPriceInvalidError";
  }
}

/** Accept only a fixed, licensed, one-unit recurring price for this consent
 * flow. Any currency Stripe reports is accepted — the Price's own currency
 * is what every screen shows. */
export function checkoutPriceTermsFromPrice(
  price: Stripe.Price,
): CheckoutPriceTerms {
  const interval = price.recurring?.interval;
  if (
    !price.active ||
    price.type !== "recurring" ||
    (interval !== "month" && interval !== "year") ||
    price.recurring?.interval_count !== 1 ||
    price.recurring?.usage_type !== "licensed" ||
    price.billing_scheme !== "per_unit" ||
    price.tiers_mode != null ||
    price.transform_quantity != null ||
    !Number.isSafeInteger(price.unit_amount) ||
    (price.unit_amount ?? 0) <= 0 ||
    !price.currency
  ) {
    throw new CheckoutPriceInvalidError(
      "Configured Stripe Price is not an active fixed recurring price",
    );
  }
  return {
    priceId: price.id,
    unitAmount: price.unit_amount!,
    currency: price.currency.toLowerCase(),
    interval,
    trialDaysMetadata: price.metadata?.trial_days ?? null,
  };
}

export type CancelUnusedGuardedTrialOperations = {
  retrieveSubscription: (
    subscriptionId: string,
  ) => Promise<Stripe.Subscription>;
  cancelSubscription: (subscriptionId: string) => Promise<Stripe.Subscription>;
};

/**
 * Stripe was reachable and returned the exact Engager-owned generation, but its
 * current state is no longer the untouched guard this narrow restart may cancel.
 * Callers may safely refetch and project that canonical state; opaque provider
 * failures remain ordinary errors and must keep the local cancellation fence.
 */
export class GuardedTrialCancellationStateError extends Error {
  readonly name = "GuardedTrialCancellationStateError";

  constructor(readonly subscription: Stripe.Subscription) {
    super("Guarded trial is not safe to cancel for setup restart");
  }
}

const cancelUnusedGuardedTrialOperations: CancelUnusedGuardedTrialOperations = {
  retrieveSubscription(subscriptionId) {
    return getStripe().subscriptions.retrieve(subscriptionId);
  },
  cancelSubscription(subscriptionId) {
    return getStripe().subscriptions.cancel(subscriptionId);
  },
};

/**
 * Cancel an unused, provider-guarded activation period before rebuilding setup.
 *
 * This is intentionally stricter than a general subscription cancellation:
 * only the exact canonical Engager generation named by `subscriptionId` may be
 * canceled, and only while its untouched trial-end guard is still armed. A
 * canceled exact generation is returned idempotently. Provider failures are
 * allowed to escape so callers never mistake an ambiguous cancellation for a
 * safe local restart.
 */
export async function cancelUnusedGuardedTrial(
  subscriptionId: string,
  organizationId: string,
  operations: CancelUnusedGuardedTrialOperations = cancelUnusedGuardedTrialOperations,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<Stripe.Subscription> {
  const current = await operations.retrieveSubscription(subscriptionId);
  const generation = current.metadata.subscriptionGeneration;
  if (
    current.id !== subscriptionId ||
    current.metadata.organizationId !== organizationId ||
    current.metadata.checkoutFlow !== GUARDED_TRIAL_CHECKOUT_FLOW ||
    !generation ||
    !/^[a-f0-9]{20}$/.test(generation)
  ) {
    throw new Error(
      "Stripe subscription does not match the guarded Engager generation",
    );
  }
  if (current.status === "canceled") return current;

  if (
    current.status !== "trialing" ||
    current.cancel_at_period_end !== false ||
    current.trial_end == null ||
    current.cancel_at !== current.trial_end ||
    current.trial_end <= nowSeconds
  ) {
    throw new GuardedTrialCancellationStateError(current);
  }

  const canceled = await operations.cancelSubscription(subscriptionId);
  if (
    canceled.id !== subscriptionId ||
    canceled.status !== "canceled" ||
    canceled.metadata.organizationId !== organizationId ||
    canceled.metadata.checkoutFlow !== GUARDED_TRIAL_CHECKOUT_FLOW ||
    canceled.metadata.subscriptionGeneration !== generation
  ) {
    throw new Error(
      "Stripe did not return the exact canceled guarded generation",
    );
  }
  return canceled;
}

/** Retrieve Stripe's current authoritative subscription projection. */
export async function fetchSubscription(
  subscriptionId: string,
): Promise<Stripe.Subscription> {
  return getStripe().subscriptions.retrieve(subscriptionId, {
    expand: ["customer", "latest_invoice", "schedule"],
  });
}

/**
 * End a subscription at once because one of its charges was fully refunded
 * (US-ONA-06, O-4). The key is the refunded charge's, so a retry of an
 * uncertain cancel replays the same request; the caller still reads the
 * canonical subscription before and after, and never takes this response
 * for state. No proration: the refund already returned the money.
 */
export async function cancelSubscriptionForRefund(
  subscriptionId: string,
  chargeId: string,
): Promise<void> {
  await getStripe().subscriptions.cancel(
    subscriptionId,
    { prorate: false },
    { idempotencyKey: `engager:refund-cancel:v1:${chargeId}` },
  );
}

/** Remove the provider guard only after durable subscription-scoped authority. */
export async function clearTrialRenewalGuard(
  subscriptionId: string,
): Promise<Stripe.Subscription> {
  const current = await getStripe().subscriptions.retrieve(subscriptionId);
  // An exact trial-end cancel_at is Engager's guard. Any period-end or different
  // cancellation belongs to the customer/provider and must win permanently.
  if (
    current.cancel_at_period_end ||
    current.cancel_at == null ||
    current.cancel_at !== current.trial_end
  ) {
    return current;
  }
  const subscription = await getStripe().subscriptions.update(
    subscriptionId,
    { cancel_at: "" },
    { idempotencyKey: `engager:renewal-enable:v2:${subscriptionId}` },
  );
  if (subscription.cancel_at !== null && !subscription.cancel_at_period_end) {
    throw new Error("Stripe trial renewal guard was not cleared");
  }
  return subscription;
}

export function billingPortalConfigured(
  configured = process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID,
): boolean {
  return Boolean(configured?.trim());
}

export function billingPortalConfigurationId(
  configured = process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID,
): string {
  const id = configured?.trim();
  if (!id) {
    throw new Error("STRIPE_BILLING_PORTAL_CONFIGURATION_ID is not set");
  }
  return id;
}

/**
 * The Portal may manage payment details and cancellation, but it must never become
 * an alternate price-selection path. Checkout is the only place that binds the
 * approved Engager offer and immutable consent evidence.
 */
export function assertSafeBillingPortalConfiguration(
  configuration: Stripe.BillingPortal.Configuration,
): void {
  if (
    !configuration.active ||
    configuration.features.subscription_update.enabled ||
    !configuration.features.subscription_cancel.enabled ||
    configuration.features.subscription_cancel.mode !== "at_period_end" ||
    !configuration.features.payment_method_update.enabled
  ) {
    throw new Error(
      "Stripe Billing Portal must be active, disable plan changes, allow at-period-end cancellation, and allow payment-method updates",
    );
  }
}

export type BillingPortalProviderOperations = {
  retrieveConfiguration: (
    id: string,
  ) => Promise<Stripe.BillingPortal.Configuration>;
  createSession: (
    params: Stripe.BillingPortal.SessionCreateParams,
  ) => Promise<Stripe.BillingPortal.Session>;
};

/** Create a Billing Portal session using a verified, no-plan-switch configuration. */
export async function createBillingPortalSession(
  opts: {
    customerId: string;
    returnUrl: string;
  },
  operations?: BillingPortalProviderOperations,
): Promise<string> {
  const configurationId = billingPortalConfigurationId();
  const provider = operations ?? {
    retrieveConfiguration: (id: string) =>
      getStripe().billingPortal.configurations.retrieve(id),
    createSession: (params: Stripe.BillingPortal.SessionCreateParams) =>
      getStripe().billingPortal.sessions.create(params),
  };
  const configuration = await provider.retrieveConfiguration(configurationId);
  assertSafeBillingPortalConfiguration(configuration);
  const session = await provider.createSession({
    customer: opts.customerId,
    return_url: opts.returnUrl,
    configuration: configurationId,
  });
  return session.url;
}

export type StripeCardSummary = {
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
};

function cardSummary(
  paymentMethod: Stripe.PaymentMethod | null | undefined,
): StripeCardSummary | null {
  const card = paymentMethod?.card;
  if (!card) return null;
  return {
    brand: card.brand ?? null,
    last4: card.last4 ?? null,
    expMonth: card.exp_month ?? null,
    expYear: card.exp_year ?? null,
  };
}

function sourceCardSummary(source: Stripe.CustomerSource): StripeCardSummary | null {
  const card = source.object === "card" ? source
    : source.object === "source" && source.type === "card" ? source.card : null;
  if (!card) return null;
  return {
    brand: card.brand ?? null,
    last4: card.last4 ?? null,
    expMonth: card.exp_month ?? null,
    expYear: card.exp_year ?? null,
  };
}

const DEFAULT_CARD_EXPAND = [
  "default_payment_method", "default_source",
  "customer.invoice_settings.default_payment_method", "customer.default_source",
];

/** Resolve Stripe's charging precedence from an already-read subscription. */
async function readDefaultCard(
  stripe: Stripe,
  customerId: string,
  subscription?: Stripe.Subscription,
): Promise<StripeCardSummary | null> {
  const fromMethod = async (method: string | Stripe.PaymentMethod) =>
    cardSummary(typeof method === "string" ? await stripe.paymentMethods.retrieve(method) : method);
  const fromSource = async (source: string | Stripe.CustomerSource) =>
    sourceCardSummary(typeof source === "string" ? await stripe.customers.retrieveSource(customerId, source) : source);
  let customer: string | Stripe.Customer | Stripe.DeletedCustomer = customerId;
  if (subscription) {
    if (stripeCustomerId(subscription.customer) !== customerId) return null;
    customer = subscription.customer;
    // Checkout can set only the subscription's default. It overrides the
    // customer's default, including when the selected method is not a card.
    const method = subscription.default_payment_method;
    if (method != null) return fromMethod(method);
    if (subscription.default_source != null) return fromSource(subscription.default_source);
  }
  if (typeof customer === "string") customer = await stripe.customers.retrieve(customerId, {
    expand: ["invoice_settings.default_payment_method", "default_source"],
  });
  if ("deleted" in customer && customer.deleted) return null;
  // The DEFAULT payment method only (US-ONA-07 AC3): an unexpanded id is
  // retrieved by id, and a customer with no default reads as no card —
  // never "some card on file" from a list.
  const expanded = customer.invoice_settings?.default_payment_method;
  if (expanded != null) return fromMethod(expanded);
  return customer.default_source != null ? fromSource(customer.default_source) : null;
}

/**
 * The default card used by the subscription (or customer), read from Stripe for display
 * (US-ONA-07). Only brand/last4/expiry ever leave this function; the card
 * is never stored, logged or sent to telemetry.
 */
export async function retrieveDefaultCard(
  customerId: string,
  subscriptionId?: string,
): Promise<StripeCardSummary | null> {
  const stripe = getStripe();
  const subscription = subscriptionId
    ? await stripe.subscriptions.retrieve(subscriptionId, { expand: DEFAULT_CARD_EXPAND })
    : undefined;
  return readDefaultCard(stripe, customerId, subscription);
}

export type CheckoutSessionStatus = {
  status: "open" | "complete" | "expired" | null;
  subscriptionId: string | null;
};

/**
 * One Checkout Session's lifecycle status, read live from Stripe for the
 * plan check's `activating` answer (US-ONA-08). Only the status and the
 * attached subscription's id leave this function; callers compare the id
 * against the projected rows and surface a boolean — it never reaches a
 * client or a log line.
 */
export async function retrieveCheckoutSessionStatus(
  sessionId: string,
): Promise<CheckoutSessionStatus> {
  const session = await getStripe().checkout.sessions.retrieve(sessionId);
  return {
    status: session.status,
    subscriptionId:
      typeof session.subscription === "string"
        ? session.subscription
        : (session.subscription?.id ?? null),
  };
}

/**
 * The newest still-open invoice Stripe is trying to collect — the failed
 * charge a past-due account owes (US-ONA-07). Amount and currency are the
 * invoice's own; nothing is derived from a constant.
 */
export async function retrieveLatestFailedInvoice(
  customerId: string,
): Promise<{ at: number; amount: number; currency: string } | null> {
  const invoices = await getStripe().invoices.list({
    customer: customerId,
    status: "open",
    limit: 5,
  });
  const invoice = invoices.data.find((row) => row.amount_due > 0);
  if (!invoice) return null;
  return {
    at: invoice.created * 1000,
    amount: invoice.amount_due,
    currency: invoice.currency,
  };
}

/** Everything the trial-started receipt prints (US-ONI-02), as Stripe
 * reports it: minor-unit amounts with their own currencies, `trial_end` in
 * epoch ms, and the card's brand/last4. No Stripe id ever leaves here. */
export type TrialReceipt = {
  chargedTodayAmount: number;
  chargedTodayCurrency: string;
  trialEndsAt: number;
  firstChargeAmount: number;
  firstChargeCurrency: string;
  priceAmount: number;
  priceCurrency: string;
  priceInterval: string;
  cardBrand: string;
  cardLast4: string;
  receiptNumber: string;
};

/** A still-trialing subscription on a catalogued Engager Price with a card on
 * file, as the trial emails read it. */
type TrialingSubscription = {
  subscription: Stripe.Subscription;
  /** Stripe's `trial_end`, epoch seconds. */
  trialEnd: number;
  price: { amount: number; currency: string; interval: string };
  card: { brand: string; last4: string };
};

/**
 * The canonical subscription behind a trial email (US-ONI-02, US-ONI-03). A
 * deliberate non-send answers `null` — not trialing (a cancelled or expired
 * subscription), an uncatalogued Price, or no payment method on file (such a
 * trial grants nothing, SPEC §5.7); provider failures propagate. The card is
 * the subscription's own default payment method, falling back to the
 * customer's default (`retrieveDefaultCard`) — the two places Stripe charges
 * from.
 */
async function readTrialingSubscription(
  subscriptionId: string,
): Promise<TrialingSubscription | null> {
  const stripe = getStripe();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: DEFAULT_CARD_EXPAND,
  });
  if (subscription.status !== "trialing") return null;
  const trialEnd = subscription.trial_end;
  if (trialEnd == null) return null;
  const items = subscription.items.data;
  if (items.length !== 1) return null;
  const price = items[0]!.price;
  const interval = price.recurring?.interval;
  if (
    !isEngagerPriceId(price.id) ||
    price.unit_amount == null ||
    !price.currency ||
    !interval
  ) {
    return null;
  }

  const customerId = stripeCustomerId(subscription.customer);
  if (!customerId) return null;
  const card = await readDefaultCard(stripe, customerId, subscription);
  if (!card?.brand || !card.last4) return null;
  return {
    subscription,
    trialEnd,
    price: {
      amount: price.unit_amount,
      currency: price.currency,
      interval,
    },
    card: { brand: card.brand, last4: card.last4 },
  };
}

/**
 * Read-only Stripe reads behind the trial-started receipt: the trialing
 * subscription (`readTrialingSubscription`, whose `null` is a deliberate
 * non-send), its first invoice and its upcoming invoice. A read that Stripe
 * could not answer yet (no finalized first invoice) throws, so the webhook
 * arm answers 503 and Stripe retries; provider failures propagate the same
 * way.
 */
export async function retrieveTrialReceipt(
  subscriptionId: string,
): Promise<TrialReceipt | null> {
  const trialing = await readTrialingSubscription(subscriptionId);
  if (!trialing) return null;
  const { trialEnd, price, card } = trialing;
  const stripe = getStripe();
  const invoices = await stripe.invoices.list({
    subscription: subscriptionId,
    limit: 100,
  });
  const firstInvoice = invoices.data.reduce<Stripe.Invoice | undefined>(
    (earliest, invoice) =>
      !earliest || invoice.created < earliest.created ? invoice : earliest,
    undefined,
  );
  if (!firstInvoice || !firstInvoice.number || !firstInvoice.currency) {
    throw new Error("trial receipt invoice is not available yet");
  }
  const upcoming = await stripe.invoices.createPreview({
    subscription: subscriptionId,
  });
  if (!upcoming.currency) {
    throw new Error("trial receipt upcoming invoice is not available yet");
  }
  return {
    chargedTodayAmount: firstInvoice.total,
    chargedTodayCurrency: firstInvoice.currency,
    trialEndsAt: trialEnd * 1000,
    firstChargeAmount: upcoming.amount_due,
    firstChargeCurrency: upcoming.currency,
    priceAmount: price.amount,
    priceCurrency: price.currency,
    priceInterval: price.interval,
    cardBrand: card.brand,
    cardLast4: card.last4,
    receiptNumber: firstInvoice.number,
  };
}

/** What the trial-ending reminder prints (US-ONI-03), as Stripe reports it.
 * No Stripe id ever leaves here. */
export type TrialEnding = {
  /** The trial's end, epoch ms: when the first charge lands. */
  trialEndsAt: number;
  /** Rounded up from the same clock that decided the trial is still running. */
  daysLeft: number;
  /** The upcoming invoice's amount due (tax included) and its currency. */
  chargeAmount: number;
  chargeCurrency: string;
  priceAmount: number;
  priceCurrency: string;
  priceInterval: string;
  cardBrand: string;
  cardLast4: string;
};

/**
 * Read-only Stripe reads behind the trial-ending reminder: the trialing
 * subscription and the invoice Stripe will charge at its end. Every case
 * where no charge is coming answers `null` — the trial reads cancelled
 * (cancel at period end, or a `cancel_at` on or before the trial's end), is
 * already over, or is one of `readTrialingSubscription`'s non-sends — so no
 * reminder promises a charge that will not happen. The amount is the
 * upcoming invoice's `amount_due`, never derived from the Price. A failed
 * read propagates, so the webhook arm answers 503 and Stripe retries.
 */
export async function retrieveTrialEnding(
  subscriptionId: string,
  now = Date.now(),
): Promise<TrialEnding | null> {
  const trialing = await readTrialingSubscription(subscriptionId);
  if (!trialing) return null;
  const { subscription, trialEnd, price, card } = trialing;
  if (
    subscription.cancel_at_period_end ||
    (subscription.cancel_at != null && subscription.cancel_at <= trialEnd)
  ) {
    return null;
  }
  // Rehearsal clocks change only this reminder's time, never the projection's
  // server-time payment grace. Read the canonical clock even if it was expanded;
  // an advance still in flight must retry rather than mail an old countdown.
  let reminderNow = now;
  if (process.env.ENGAGER_DEPLOYMENT_ENV === "dev" && subscription.test_clock) {
    if (subscription.livemode !== false) {
      throw new Error("Development billing reminder requires a test subscription");
    }
    const clock = await getStripe().testHelpers.testClocks.retrieve(
      expandableId(subscription.test_clock)!,
    );
    if (
      clock.livemode !== false ||
      clock.status !== "ready" ||
      !Number.isSafeInteger(clock.frozen_time) ||
      clock.frozen_time < 0
    ) {
      throw new Error("Development billing reminder clock is not ready");
    }
    reminderNow = clock.frozen_time * 1000;
  }
  if (trialEnd * 1000 <= reminderNow) return null;
  const upcoming = await getStripe().invoices.createPreview({
    subscription: subscriptionId,
  });
  if (!upcoming.currency) {
    throw new Error("trial ending upcoming invoice is not available yet");
  }
  return {
    trialEndsAt: trialEnd * 1000,
    daysLeft: Math.ceil((trialEnd * 1000 - reminderNow) / 86_400_000),
    chargeAmount: upcoming.amount_due,
    chargeCurrency: upcoming.currency,
    priceAmount: price.amount,
    priceCurrency: price.currency,
    priceInterval: price.interval,
    cardBrand: card.brand,
    cardLast4: card.last4,
  };
}
