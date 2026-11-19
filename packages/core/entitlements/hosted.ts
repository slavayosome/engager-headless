import {
  runtimeEntitlement,
  type RuntimeEntitlement,
} from "./entitlement";
import type { Job } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { ownsCurrentJobLease } from "../jobs/lease";

export type HostedSpendAccess =
  | {
      allowed: true;
      source: Extract<RuntimeEntitlement, { allowed: true }>["source"];
    }
  | {
      allowed: false;
      reason: "subscription_inactive" | "job_lease_lost";
    };

/**
 * May this job spend Engager-paid hosted inference?
 *
 * One question, one answer: the organization holds the cloud capability, or it
 * does not. P4 removed the owner-global setup-lane allowance and the
 * pre-Checkout grandfather that used to say yes before any payment — both were
 * pre-checkout paid-use exceptions, and the new tiers create none (TIER-11).
 * Free interactive setup runs on the owner's own agent (`ai/agentCli`), which
 * costs Engager nothing and therefore asks nothing here.
 *
 * The trial-claim ledger those grants wrote, `owner_initial_trial_claims`, is
 * untouched and still readable. Removing eligibility is not removing history.
 */
export async function hostedJobSpendAccess(
  tx: Tx,
  organizationId: string,
  jobType: Job["type"],
  opts: {
    currentJobId?: number;
    currentJobLeaseToken?: string;
  } = {},
): Promise<HostedSpendAccess> {
  if (opts.currentJobId != null) {
    // A mid-run recheck authorizes THIS queue execution, not merely this durable
    // row. After a timeout/reap the same id can be re-claimed with a new token;
    // the old process must then stop instead of borrowing the new worker's
    // active subscription and spending twice.
    if (!opts.currentJobLeaseToken) {
      return { allowed: false, reason: "job_lease_lost" };
    }
    const owned = await ownsCurrentJobLease(tx, {
      organizationId,
      jobId: opts.currentJobId,
      jobType,
      jobLeaseToken: opts.currentJobLeaseToken,
    });
    if (!owned) return { allowed: false, reason: "job_lease_lost" };
  }

  // Enqueue and worker claim/run decisions are mutations. Keep the shared
  // subscription lock until their surrounding transaction commits so a
  // concurrent cancellation has a single, deterministic winner.
  return runtimeEntitlement(tx, organizationId, { lock: true });
}
