import { eq } from "drizzle-orm";
import {
  ownerInitialTrialClaims,
  subscriptions,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";

/**
 * The plan config's trial length when the selling Price carries no
 * `trial_days` metadata. This named constant is the only default; no UI,
 * request body or fixture sets the trial length (US-ONA-02).
 */
export const DEFAULT_TRIAL_DAYS = 7;

export type TrialDaysResolution = { ok: true; days: number } | { ok: false };

/**
 * Resolve the trial length a Price configures. Absent metadata is the plan
 * default; a present value must be an integer from 1 to 30 — anything else is
 * a misconfiguration the caller refuses, never a silently different trial.
 */
export function resolveTrialDays(
  metadata: string | null | undefined,
): TrialDaysResolution {
  if (metadata == null) return { ok: true, days: DEFAULT_TRIAL_DAYS };
  if (!/^\d+$/.test(metadata)) return { ok: false };
  const days = Number(metadata);
  return days >= 1 && days <= 30 ? { ok: true, days } : { ok: false };
}

export type TrialDecision =
  | { eligible: true; days: number }
  | {
      eligible: false;
      reason: "subscription_history" | "trial_claimed_elsewhere";
    };

/**
 * Whether this owner may still take the one initial trial on this
 * organization. Read-only: the Checkout reservation writes the claim rows.
 *
 * A subscriptions row of ANY generation or status ends eligibility — a
 * cancelled or refunded customer resubscribes without a trial. An owner
 * trial claim bound to THIS organization keeps the account eligible: the
 * claim is a reservation made at the first press, so an abandoned or expired
 * Checkout session may be replaced while no subscription ever existed. A
 * claim bound to a different organization means the owner's one trial is
 * spent elsewhere.
 *
 * Eligibility only ever decreases — neither rows are ever deleted — so a
 * decision read before the caller's locked reservation stays valid there.
 *
 * Reads run on the caller's transaction. `subscriptions` and
 * `owner_initial_trial_claims` are billing-global (outside tenant RLS), so
 * both predicates are explicit.
 */
export async function decideTrial(
  tx: Tx,
  input: { organizationId: string; ownerUserId: string; days?: number },
): Promise<TrialDecision> {
  const [subscription] = await tx
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(eq(subscriptions.organizationId, input.organizationId))
    .limit(1);
  if (subscription) {
    return { eligible: false, reason: "subscription_history" };
  }
  const [claim] = await tx
    .select({
      initialOrganizationId: ownerInitialTrialClaims.initialOrganizationId,
    })
    .from(ownerInitialTrialClaims)
    .where(eq(ownerInitialTrialClaims.ownerUserId, input.ownerUserId))
    .limit(1);
  if (claim && claim.initialOrganizationId !== input.organizationId) {
    return { eligible: false, reason: "trial_claimed_elsewhere" };
  }
  return { eligible: true, days: input.days ?? DEFAULT_TRIAL_DAYS };
}
