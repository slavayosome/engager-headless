import { and, eq, inArray, isNull } from "drizzle-orm";
import { actionApprovals, actions } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { lockPauses, QUEUED_STATUSES } from "../actions/pause";
import { endLiveCheckWrites } from "../liveChecks/records";

/**
 * WHAT A WORD OF THEIRS CANCELS (spec §10 R07, §11 R08).
 *
 * Whether and when to follow up is the Ambassador's step's own decision: it
 * waits on the conversation, wakes at a time it chose or the person named,
 * reads the thread afresh and decides again (`agentStep/wait.ts`), inside the
 * bounds `actions/dm.ts` `decideFollowup` holds it to. No timer here decides
 * a nudge.
 *
 * What stays here is what an inbound message does to what is already queued,
 * in the transaction that records it: a follow-up still waiting for a yes is
 * cancelled — "any inbound message cancels" — and a DM queued before their
 * latest words is cancelled too, since it answers a conversation that has
 * moved on. The message itself wakes the step, which answers the
 * conversation as it now stands.
 */

/**
 * Cancel a follow-up the wake queued that still waits for a yes, in the
 * transaction that records an inbound message (R07). Returns how many.
 */
export async function cancelFollowup(tx: Tx, conversationId: number, now: number): Promise<number> {
  return cancelQueued(tx, conversationId, ["followup"], "superseded:inbound_message", now);
}

/**
 * A DM the wake queued before the person's latest message answers words they
 * have since added to: it is cancelled where it waits — the next wake answers
 * the conversation as it stands — and a DM already past the click is left to
 * its settlement. Returns how many.
 */
export async function supersedeQueuedDms(tx: Tx, conversationId: number, now: number): Promise<number> {
  return cancelQueued(tx, conversationId, ["dm"], "superseded:inbound_message", now);
}

async function cancelQueued(
  tx: Tx,
  conversationId: number,
  kinds: Array<"dm" | "followup">,
  reason: string,
  now: number,
): Promise<number> {
  // The pause lock before any action row, in the order every writer takes them.
  await lockPauses(tx);
  const cancelled = await tx
    .update(actions)
    .set({ status: "cancelled", statusReason: reason, settledAt: now, updatedAt: now })
    .where(
      and(
        eq(actions.conversationId, conversationId),
        inArray(actions.kind, kinds),
        inArray(actions.status, QUEUED_STATUSES),
      ),
    )
    .returning({ id: actions.id });
  await endLiveCheckWrites(
    tx,
    cancelled.map((row) => row.id),
    "cancelled",
    now,
  );
  if (cancelled.length > 0) {
    await tx
      .update(actionApprovals)
      .set({ invalidatedAt: now, invalidatedReason: reason })
      .where(
        and(
          inArray(
            actionApprovals.actionExecutionId,
            cancelled.map((row) => row.id),
          ),
          isNull(actionApprovals.usedAt),
          isNull(actionApprovals.invalidatedAt),
        ),
      );
  }
  return cancelled.length;
}
