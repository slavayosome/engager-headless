import { and, eq, sql } from "drizzle-orm";
import { channels, jobs } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { enqueue, retireFinishedIdempotencyKey } from "../jobs/queue";

/**
 * The one way an owner's yes reaches the dispatch gate: a `dispatch_actions`
 * job for the account, which takes its approved actions through the gate
 * oldest first (`jobs/handlers/dispatchActions.ts`). Approving enqueues it in
 * the approval's own transaction, and so does settling an uncertain send —
 * the account is free again — so a yes never waits on a scheduler that does
 * not know about it.
 *
 * One at a time per account: the key is held while a job is queued or
 * running, and a finished one's key is retired first so the next yes can
 * enqueue again (`retireFinishedIdempotencyKey`). A job already queued — one
 * a hold on another action rescheduled for later — is pulled forward to now,
 * so a yes never waits behind someone else's hold; a yes given while a drain
 * runs is picked up by that drain's own re-check before it finishes.
 */

export const dispatchActionsKey = (channelId: number) => `dispatch_actions:${channelId}`;

export async function enqueueActionDispatch(
  tx: Tx,
  channelId: number,
  at: number = Date.now(),
): Promise<void> {
  const [channel] = await tx
    .select({ organizationId: channels.organizationId })
    .from(channels)
    .where(eq(channels.id, channelId));
  if (!channel) return;
  const key = dispatchActionsKey(channelId);
  await retireFinishedIdempotencyKey(tx, channel.organizationId, key);
  await enqueue(tx, {
    type: "dispatch_actions",
    payload: { channelId },
    idempotencyKey: key,
    nextRunAt: at,
  });
  await tx
    .update(jobs)
    .set({ nextRunAt: sql`least(${jobs.nextRunAt}, ${at}::bigint)`, updatedAt: at })
    .where(
      and(
        // `jobs` is excluded from RLS, so the org predicate is explicit.
        eq(jobs.organizationId, channel.organizationId),
        eq(jobs.idempotencyKey, key),
        eq(jobs.status, "queued"),
      ),
    );
}
