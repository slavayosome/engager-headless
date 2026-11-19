import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { discoveredPosts } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";

/**
 * One lock namespace and one lock order for every consumer of an agent-authored
 * comment draft: campaign advisory lock first, then candidate rows by id.
 */
export async function lockCommentDraftIntake(
  tx: Tx,
  campaignId: number,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('client-draft-intake:' || coalesce(current_setting('app.current_org', true), '') || ':' || ${campaignId}::text))`,
  );
}

export async function lockCommentDraftCandidateRows(
  tx: Tx,
  campaignId: number,
  discoveredPostIds: readonly number[],
): Promise<void> {
  const ids = [...new Set(discoveredPostIds)].sort((a, b) => a - b);
  if (ids.length === 0) return;
  await tx
    .select({ id: discoveredPosts.id })
    .from(discoveredPosts)
    .where(
      and(
        eq(discoveredPosts.campaignId, campaignId),
        inArray(discoveredPosts.id, ids),
      ),
    )
    .orderBy(asc(discoveredPosts.id))
    .for("update");
}

