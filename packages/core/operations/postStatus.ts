import { inArray, sql, type SQL } from "drizzle-orm";
import { discoveredPosts, type DiscoveredPost } from "@engager/database/schema";
import { LEAD_OPENER_POST } from "../candidates/status";

type CandidateStatus = DiscoveredPost["status"];

/** Every Candidate status the schema knows, for surfaces (public API filters,
 * validators) that must accept the full lifecycle without keeping their own
 * drifting copy. */
export const CANDIDATE_STATUSES = discoveredPosts.status
  .enumValues satisfies readonly CandidateStatus[];

/** The only statuses that remain in the fresh Candidate pool. `held` is a
 * deferred-but-live row, never a terminal rejection. */
export const ACTIONABLE_CANDIDATE_STATUSES = [
  "new",
  "held",
] as const satisfies readonly CandidateStatus[];

/** SQL predicate for the actionable pool, composable inside larger `sql`
 * templates (e.g. `count(*) filter (where …)`). Always prefer this over a raw
 * `status in ('new', 'held')` literal so the pool strategy has one home. */
export function actionableCandidateStatusesSql(): SQL<unknown> {
  return inArray(discoveredPosts.status, [...ACTIONABLE_CANDIDATE_STATUSES]);
}

/** SQL predicate for the rows a Find posts sweep found: every post but a
 * lead's opener's. Most rows hold no filter reason, so it compares with
 * `is distinct from`. */
export function notLeadOpenerSql(): SQL<unknown> {
  return sql`${discoveredPosts.filterReason} is distinct from ${LEAD_OPENER_POST}`;
}

export function isActionableCandidateStatus(
  status: CandidateStatus,
): status is (typeof ACTIONABLE_CANDIDATE_STATUSES)[number] {
  return (ACTIONABLE_CANDIDATE_STATUSES as readonly CandidateStatus[]).includes(
    status,
  );
}

