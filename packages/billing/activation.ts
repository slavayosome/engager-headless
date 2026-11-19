import { and, desc, eq, sql } from "drizzle-orm";
import {
  memberships,
  subscriptionActivations,
  subscriptions,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";

export type SubscriptionRenewalState =
  | { state: "missing" }
  | {
      state:
        | "legacy"
        | "guarded"
        | "activation_pending"
        | "enabled"
        | "invalid";
      subscriptionId: string;
      activationId: string | null;
      source: "interactive" | null;
      active: boolean;
      cancellationPending: boolean;
      guardArmed: boolean;
      renewalEnabled: boolean;
      trialEndsAt: number | null;
      checkoutTerms: (typeof subscriptions.$inferSelect)["checkoutTerms"];
    };

export type RecordedSubscriptionActivation = {
  subscriptionId: string;
  activationId: string;
  inserted: boolean;
  /** The immutable authority which won this subscription generation. Callers
   * must not project a different operating mode when a concurrent path already
   * recorded the opposite source. */
  source: "interactive";
};

type ActivationTarget = {
  id: string;
  organizationId: string;
  active: boolean;
  provider: string;
  trialEndsAt: number | null;
  cancelAt: number | null;
  cancelAtPeriodEnd: boolean;
  checkoutSessionId: string | null;
  checkoutTerms: (typeof subscriptions.$inferSelect)["checkoutTerms"];
  guardedCancellationToken: string | null;
};

async function activationTarget(
  tx: Tx,
  input: {
    organizationId: string;
    subscriptionId?: string;
    /** Serialize charge-authority insertion against owner cancellation claim. */
    lock?: boolean;
  },
): Promise<ActivationTarget | null> {
  const conditions = [
    eq(subscriptions.organizationId, input.organizationId),
    sql`${subscriptions.organizationId} = nullif(current_setting('app.current_org', true), '')::uuid`,
  ];
  if (input.subscriptionId) {
    conditions.push(eq(subscriptions.id, input.subscriptionId));
  } else {
    conditions.push(eq(subscriptions.active, true));
  }
  const query = tx
    .select({
      id: subscriptions.id,
      organizationId: subscriptions.organizationId,
      active: subscriptions.active,
      provider: subscriptions.provider,
      trialEndsAt: subscriptions.trialEndsAt,
      cancelAt: subscriptions.cancelAt,
      cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
      checkoutSessionId: subscriptions.checkoutSessionId,
      checkoutTerms: subscriptions.checkoutTerms,
      guardedCancellationToken: subscriptions.guardedCancellationToken,
    })
    .from(subscriptions)
    .where(and(...conditions))
    .orderBy(desc(subscriptions.createdAt))
    .limit(2);
  const rows = input.lock ? await query.for("update") : await query;
  if (rows.length > 1) {
    throw new Error(
      "Multiple active subscriptions require explicit resolution",
    );
  }
  return rows[0] ?? null;
}

export async function getSubscriptionRenewalState(
  tx: Tx,
  input: { organizationId: string; subscriptionId?: string },
): Promise<SubscriptionRenewalState> {
  const target = await activationTarget(tx, input);
  if (!target) return { state: "missing" };
  const [activation] = await tx
    .select({
      id: subscriptionActivations.id,
      source: subscriptionActivations.source,
    })
    .from(subscriptionActivations)
    .where(
      and(
        eq(subscriptionActivations.organizationId, input.organizationId),
        eq(subscriptionActivations.subscriptionId, target.id),
      ),
    );
  const guardArmed =
    target.trialEndsAt != null &&
    target.cancelAt === target.trialEndsAt &&
    !target.cancelAtPeriodEnd;
  const renewalEnabled =
    activation != null && target.cancelAt == null && !target.cancelAtPeriodEnd;
  const common = {
    subscriptionId: target.id,
    activationId: activation?.id ?? null,
    source: activation?.source ?? null,
    active: target.active,
    cancellationPending: target.guardedCancellationToken != null,
    guardArmed,
    renewalEnabled,
    trialEndsAt: target.trialEndsAt,
    checkoutTerms: target.checkoutTerms,
  };
  if (
    target.provider !== "stripe" ||
    !target.checkoutSessionId ||
    !target.trialEndsAt ||
    !target.checkoutTerms
  ) {
    return { state: "legacy", ...common };
  }
  if (!target.active) return { state: "invalid", ...common };
  // An owner-confirmed unused-trial cancellation is a durable cross-system
  // fence. Never mint activation authority while Stripe cancellation or its
  // canonical projection is incomplete.
  if (target.guardedCancellationToken) {
    return { state: "invalid", ...common };
  }
  if (renewalEnabled) return { state: "enabled", ...common };
  if (activation && guardArmed)
    return { state: "activation_pending", ...common };
  if (!activation && guardArmed) return { state: "guarded", ...common };
  return { state: "invalid", ...common };
}

/**
 * Decide whether the current subscription may finish setup without creating any
 * new billing authority. `customer_canceled` preserves a customer's later
 * cancellation even though Engager still has immutable evidence of the earlier
 * opt-in. `legacy_active` grandfathers an already-active subscription whose
 * pre-cutover row has no versioned Checkout terms; it never reinterprets that
 * historical row as consent to a new renewal.
 */
export type SubscriptionSetupCompletionMode =
  | "renewal_enabled"
  | "customer_canceled"
  | "legacy_active";

export function subscriptionSetupCompletionMode(
  renewal: SubscriptionRenewalState,
): SubscriptionSetupCompletionMode | null {
  if (renewal.state === "missing" || !renewal.active) return null;
  if (renewal.state === "enabled" && renewal.renewalEnabled) {
    return "renewal_enabled";
  }
  if (renewal.state === "legacy") return "legacy_active";
  if (
    renewal.state === "invalid" &&
    renewal.activationId != null &&
    renewal.source != null &&
    !renewal.guardArmed &&
    !renewal.renewalEnabled
  ) {
    return "customer_canceled";
  }
  return null;
}

async function existingActivation(
  tx: Tx,
  organizationId: string,
  subscriptionId: string,
): Promise<{ id: string; source: "interactive" } | null> {
  const [row] = await tx
    .select({
      id: subscriptionActivations.id,
      source: subscriptionActivations.source,
    })
    .from(subscriptionActivations)
    .where(
      and(
        eq(subscriptionActivations.organizationId, organizationId),
        eq(subscriptionActivations.subscriptionId, subscriptionId),
      ),
    );
  return row ?? null;
}

async function recordActivation(
  tx: Tx,
  input: {
    organizationId: string;
    subscriptionId?: string;
    source: "interactive";
    approvedByUserId?: string;
    now?: number;
  },
): Promise<RecordedSubscriptionActivation | null> {
  const target = await activationTarget(tx, { ...input, lock: true });
  if (!target) return null;
  const now = input.now ?? Date.now();
  // Activation is authority for a future off-session charge. Never mint or
  // report it from a canceled/historical subscription or after the guarded
  // renewal boundary has already passed.
  if (
    !target.active ||
    target.guardedCancellationToken != null ||
    target.trialEndsAt == null ||
    target.trialEndsAt <= now
  ) {
    return null;
  }
  const existing = await existingActivation(
    tx,
    input.organizationId,
    target.id,
  );
  const state = await getSubscriptionRenewalState(tx, {
    organizationId: input.organizationId,
    subscriptionId: target.id,
  });
  if (existing) {
    return state.state === "activation_pending" || state.state === "enabled"
      ? {
          subscriptionId: target.id,
          activationId: existing.id,
          inserted: false,
          source: existing.source,
        }
      : null;
  }
  if (state.state !== "guarded") return null;
  const [inserted] = await tx
    .insert(subscriptionActivations)
    .values({
      organizationId: input.organizationId,
      subscriptionId: target.id,
      source: input.source,
      approvedByUserId: input.approvedByUserId,
      createdAt: now,
    })
    .onConflictDoNothing({ target: subscriptionActivations.subscriptionId })
    .returning({ id: subscriptionActivations.id });
  if (inserted) {
    return {
      subscriptionId: target.id,
      activationId: inserted.id,
      inserted: true,
      source: input.source,
    };
  }
  const winner = await existingActivation(tx, input.organizationId, target.id);
  if (!winner)
    throw new Error("Subscription activation conflict has no winner");
  return {
    subscriptionId: target.id,
    activationId: winner.id,
    inserted: false,
    source: winner.source,
  };
}

export async function recordInteractiveActivation(
  tx: Tx,
  input: {
    organizationId: string;
    approvedByUserId: string;
    subscriptionId?: string;
    now?: number;
  },
): Promise<RecordedSubscriptionActivation | null> {
  const [owner] = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.organizationId, input.organizationId),
        sql`${memberships.organizationId} = nullif(current_setting('app.current_org', true), '')::uuid`,
        eq(memberships.userId, input.approvedByUserId),
        eq(memberships.isOwner, true),
      ),
    )
    .limit(1)
    .for("share");
  if (!owner)
    throw new Error("Interactive renewal activation requires an owner");
  return recordActivation(tx, {
    ...input,
    source: "interactive",
  });
}
