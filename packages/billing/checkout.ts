import { eq } from "drizzle-orm";
import { organizations } from "@engager/database/schema";
import { withOrg } from "@engager/database/tenant";
import { createBillingPortalSession } from "./client";
import { getSubscriptionRenewalState } from "./activation";

/**
 * What is left of the guarded-trial era: the Billing Portal link, and the fence
 * that keeps the Portal from being an alternate way around a cancellation.
 *
 * New purchases go through `apps/cloud/lib/checkout.ts`. The monthly Mac
 * offer may start with one trial per account: payment method at the start,
 * duration from plan configuration, access until trial end. A trial without
 * a payment method grants nothing; previously subscribed accounts get the
 * ordinary paid offer. Cloud provisioning stays closed to new sales.
 *
 * The historical rows those flows wrote — `owner_initial_trial_claims`,
 * `subscriptions.trial_ends_at`, `subscriptions.checkout_terms` — are untouched
 * and still readable. Removing eligibility is not removing history.
 */
type BillingPortalOperations = {
  createBillingPortalSession: typeof createBillingPortalSession;
};

const billingPortalOperations: BillingPortalOperations = {
  createBillingPortalSession,
};

/**
 * Mint a Stripe Billing Portal link (manage/cancel/update payment) for an org
 * that already has a Stripe customer. Stripe calls run OUTSIDE the transaction;
 * the DB touch is one short `withOrg` scope.
 */
export async function billingPortalForOrg(
  opts: {
    organizationId: string;
    appUrl: string;
    /** Closed server-selected destination; never accepts a caller URL. */
    returnTo?: "billing" | "app";
    appReturnQuery?: string;
  },
  operations: BillingPortalOperations = billingPortalOperations,
): Promise<
  | { status: "ok"; url: string }
  | { status: "no_customer" }
  | { status: "activation_required" }
> {
  const billing = await withOrg(opts.organizationId, async (tx) => {
    const [row] = await tx
      .select({ billingCustomerId: organizations.billingCustomerId })
      .from(organizations)
      .where(eq(organizations.id, opts.organizationId));
    return {
      customerId: row?.billingCustomerId ?? null,
      renewal: await getSubscriptionRenewalState(tx, {
        organizationId: opts.organizationId,
      }),
    };
  });
  if (!billing.customerId) return { status: "no_customer" };
  // A historical guarded generation still reconciling keeps its provider fence.
  // Removing the obsolete grant policy must not remove the cancellation fence
  // that stops the Portal from clearing a cancel-at-trial-end guard.
  if (
    billing.renewal.state === "guarded" ||
    billing.renewal.state === "activation_pending" ||
    (billing.renewal.state === "invalid" &&
      !billing.renewal.activationId &&
      (billing.renewal.guardArmed || billing.renewal.cancellationPending))
  ) {
    return { status: "activation_required" };
  }
  const url = await operations.createBillingPortalSession({
    customerId: billing.customerId,
    returnUrl: opts.returnTo === "app"
      ? `${opts.appUrl}/app/billing/return${opts.appReturnQuery ?? ""}`
      : `${opts.appUrl}/account`,
  });
  return { status: "ok", url };
}
