import { and, eq, inArray } from "drizzle-orm";
import { actions, stepRuns } from "@engager/database/schema";
import { QUEUED_STATUSES } from "../../actions/pause";
import { consumeWait, unconsumed, wakeAmbassador } from "../../agentStep/wait";
import type { HandlerCtx } from "../context";
import { RescheduleError } from "../queue";
import type { JobResult } from "../worker";

/** How long a wait on an invitation's answer is put off, and looked at
 *  again, while the invitation it waits on has not gone out. */
const UNSENT_INVITE_RETRY_MS = 24 * 60 * 60_000;

export type AgentStepTimeoutPayload = { stepRunId: number };

/**
 * A step's wait expired before the event it waited for. Consumes the wait —
 * unless the event already did, when this is the job that lost the race and
 * does nothing — and does what the wait said: `wake` hands the conversation back
 * to the Ambassador's next wake, `escalate` ends the step for a person to
 * look at. Pure DB work, one org-scoped transaction.
 *
 * A wait on an invitation's answer does not run out while the invitation has
 * not gone: held for the owner's review, the account's hours or its caps, or
 * unsettled, it has no answer to wait for yet, and the step would wake into
 * "no answer" about an invitation nobody received. The check is put off a
 * day; the send itself starts the wait afresh (`settleInvitation`).
 */
export async function handleAgentStepTimeout(
  ctx: HandlerCtx,
  payload: AgentStepTimeoutPayload,
): Promise<JobResult> {
  const now = Date.now();
  const [checkpoint] = await ctx.db
    .select()
    .from(stepRuns)
    .where(eq(stepRuns.id, payload.stepRunId))
    .for("update");
  if (!checkpoint || !unconsumed(checkpoint)) return { superseded: 1 };
  if (checkpoint.wait!.event === "invitation_status") {
    const [unsent] = await ctx.db
      .select({ id: actions.id })
      .from(actions)
      .where(
        and(
          eq(actions.stepRunId, checkpoint.id),
          eq(actions.kind, "invite"),
          inArray(actions.status, [...QUEUED_STATUSES, "dispatching", "uncertain"]),
        ),
      )
      .limit(1);
    if (unsent) throw new RescheduleError("invitation_not_sent", now + UNSENT_INVITE_RETRY_MS);
  }
  await consumeWait(ctx.db, checkpoint, "timeout", now);
  if (checkpoint.wait!.onTimeout === "escalate") {
    await ctx.db
      .update(stepRuns)
      .set({ status: "needs_approval", blockedReason: "wait_expired", updatedAt: now })
      .where(eq(stepRuns.id, checkpoint.id));
    return { escalated: 1 };
  }
  const wake = await wakeAmbassador(
    ctx.db,
    checkpoint.campaignId,
    `agent_step_timeout:${checkpoint.id}:wake`,
  );
  return wake === null ? { unwoken: 1 } : { woke: 1 };
}
