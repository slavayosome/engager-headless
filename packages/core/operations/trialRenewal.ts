import { and, eq } from "drizzle-orm";
import { getSubscriptionRenewalState } from "@engager/billing/activation";
import { jobs } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { enqueue } from "../jobs/queue";

function reconcileKey(subscriptionId: string, activationId: string): string {
  // Authority, not org, is the immutable generation. A replacement subscription
  // or activation gets a new job identity and can never inherit old proof.
  return `reconcile_trial_renewal:${subscriptionId}:${activationId}`;
}

/**
 * Ensure an immutable activation has a live reconciliation attempt. Normal
 * runner retries are handled by the queue. If all attempts dead-letter while
 * Stripe is unavailable, an explicit setup/finish retry reopens this same row
 * (same activation-scoped key) instead of being blocked forever by the unique
 * idempotency key. Provider clearing is itself idempotent.
 */
export async function ensureTrialRenewalReconcile(
  tx: Tx,
  input: {
    organizationId: string;
    subscriptionId: string;
    activationId: string;
    now?: number;
  },
): Promise<{ jobId: number | null; requeued: boolean }> {
  const now = input.now ?? Date.now();
  const renewal = await getSubscriptionRenewalState(tx, {
    organizationId: input.organizationId,
    subscriptionId: input.subscriptionId,
  });
  if (renewal.state === "enabled") return { jobId: null, requeued: false };
  if (
    renewal.state !== "activation_pending" ||
    renewal.activationId !== input.activationId
  ) {
    throw new Error(
      "trial renewal reconciliation requires the current immutable activation",
    );
  }

  const idempotencyKey = reconcileKey(input.subscriptionId, input.activationId);
  const [existing] = await tx
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.organizationId, input.organizationId),
        eq(jobs.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1)
    .for("update");
  if (!existing) {
    const jobId = await enqueue(tx, {
      type: "reconcile_trial_renewal",
      payload: { subscriptionId: input.subscriptionId },
      idempotencyKey,
      maxAttempts: 8,
    });
    return { jobId, requeued: false };
  }
  const payload = existing.payload as { subscriptionId?: unknown } | null;
  if (
    existing.type !== "reconcile_trial_renewal" ||
    payload?.subscriptionId !== input.subscriptionId
  ) {
    throw new Error("renewal reconciliation idempotency key is corrupted");
  }
  if (
    existing.status !== "dead" &&
    existing.status !== "failed" &&
    existing.status !== "done"
  ) {
    return { jobId: existing.id, requeued: false };
  }
  const [requeued] = await tx
    .update(jobs)
    .set({
      status: "queued",
      attempts: 0,
      nextRunAt: now,
      lockedAt: null,
      leaseToken: null,
      lastError: null,
      updatedAt: now,
    })
    .where(eq(jobs.id, existing.id))
    .returning({ id: jobs.id });
  if (!requeued) throw new Error("renewal reconciliation job disappeared");
  return { jobId: requeued.id, requeued: true };
}
