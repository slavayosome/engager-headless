import {
  getSubscriptionRenewalState,
  type SubscriptionRenewalState,
} from "@engager/billing/activation";
import {
  clearTrialRenewalGuard,
  fetchSubscription,
} from "@engager/billing/client";
import {
  mutateAndReconcileSubscription,
  type HandleResult,
  type StripeSubscriptionLike,
} from "@engager/billing/webhooks";
import { withOrg } from "@engager/database/tenant";
import type { SelfScopedCtx } from "../worker";

export type RenewalOperations = {
  snapshot: () => Promise<SubscriptionRenewalState>;
  clearAndProject: (
    subscriptionId: string,
    organizationId: string,
  ) => Promise<{
    canonical: StripeSubscriptionLike;
    result: HandleResult;
  }>;
};

const providerOperations: Omit<RenewalOperations, "snapshot"> = {
  clearAndProject: (subscriptionId, organizationId) =>
    mutateAndReconcileSubscription({
      subscriptionId,
      organizationId,
      mutate: clearTrialRenewalGuard,
      loadCanonical: async (id) =>
        (await fetchSubscription(id)) as unknown as StripeSubscriptionLike,
    }),
};

function assertActivation(
  state: SubscriptionRenewalState,
  organizationId: string,
  subscriptionId: string,
): "done" | "clear" {
  if (state.state === "missing") {
    throw new Error(
      `subscription ${subscriptionId} is not owned by org ${organizationId}`,
    );
  }
  if (state.subscriptionId !== subscriptionId) {
    throw new Error("renewal snapshot returned a different subscription");
  }
  if (state.state === "enabled" && state.renewalEnabled) return "done";
  if (
    state.state !== "activation_pending" ||
    !state.activationId ||
    !state.source ||
    !state.guardArmed
  ) {
    throw new Error(
      `subscription ${subscriptionId} has no immutable activation authorizing renewal`,
    );
  }
  return "clear";
}

/**
 * Release a guarded trial only after immutable subscription-scoped authority
 * exists. This is SELF_SCOPED so the Stripe update happens between two short DB
 * scopes: no network request is ever made while an org transaction is held.
 * Provider success + projection failure is retry-safe; clearing `cancel_at` is
 * idempotent and the activation/job rows remain durable.
 */
export async function handleReconcileTrialRenewal(
  ctx: SelfScopedCtx,
  payload: { subscriptionId?: unknown },
  injected: Omit<RenewalOperations, "snapshot"> = providerOperations,
): Promise<void> {
  const subscriptionId =
    typeof payload.subscriptionId === "string"
      ? payload.subscriptionId.trim()
      : "";
  if (!subscriptionId) throw new Error("subscriptionId is required");

  await reconcileTrialRenewal(
    {
      organizationId: ctx.organizationId,
      subscriptionId,
      signal: ctx.signal,
    },
    {
      snapshot: () =>
        withOrg(ctx.organizationId, (tx) =>
          getSubscriptionRenewalState(tx, {
            organizationId: ctx.organizationId,
            subscriptionId,
          }),
        ),
      ...injected,
    },
  );
}

/** Pure orchestration seam used by focused tests. Production supplies short
 * `withOrg` snapshots while the provider operations remain outside them. */
export async function reconcileTrialRenewal(
  input: {
    organizationId: string;
    subscriptionId: string;
    signal?: AbortSignal;
  },
  injected: RenewalOperations,
): Promise<void> {
  const { organizationId, subscriptionId } = input;

  // Phase 1: durable authority snapshot, then release the connection.
  const before = await injected.snapshot();
  if (assertActivation(before, organizationId, subscriptionId) === "done") {
    return;
  }
  if (input.signal?.aborted) throw new Error("renewal reconciliation aborted");

  // Phase 2: provider mutation, canonical refetch, and fenced local projection
  // with no org transaction or pooled connection held. The stale mutation
  // response is never projected; a concurrent customer cancellation wins.
  const { canonical, result: projected } = await injected.clearAndProject(
    subscriptionId,
    organizationId,
  );
  if (canonical.id !== subscriptionId) {
    throw new Error("Stripe returned a different subscription than requested");
  }
  if (input.signal?.aborted) throw new Error("renewal reconciliation aborted");

  const customerCancellation =
    canonical.cancel_at_period_end === true ||
    (canonical.cancel_at != null &&
      canonical.cancel_at !== canonical.trial_end);

  if (!projected.ok || projected.organizationId !== organizationId) {
    throw new Error(
      "Stripe subscription ownership changed during reconciliation",
    );
  }
  // A Portal/API cancellation that races the activation always wins. The
  // actually projected canonical provider state is terminal rather than a
  // retry loop that could later undo the customer's intent.
  if (customerCancellation) return;
  const after = await injected.snapshot();
  if (assertActivation(after, organizationId, subscriptionId) !== "done") {
    throw new Error("Stripe renewal guard remains armed after reconciliation");
  }
}
