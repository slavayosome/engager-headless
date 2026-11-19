import { and, eq, isNull, sql } from "drizzle-orm";
import { campaigns, jobs, workers } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { modeFor } from "../strategy/mode";
import { getSystemState } from "../ratelimit/killswitch";
import { plannedHandOn, type LoadedStrategy } from "./select";
import { wakeAmbassador } from "./wait";

/**
 * AN ACHIEVED STEP HANDS ITS CONVERSATION ON NOW, not at the Ambassador's next
 * wake.
 *
 * The planner hands a conversation on to the step that requires the one it
 * achieved (`select.ts` `handedOn`, `stepAfter`) only when a wake plans, at
 * the start of a run, and nothing woke one when a step achieved. On
 * 2026-10-19 at 20:25 an event wake ran Reply when they answer on conversation 26 to
 * achieved — "Handing off to the invitation path" — and Connect, which
 * requires it, waited for the scheduled wake at 22:36. Now the checkpoint
 * that achieves enqueues the Ambassador's event wake for the hand-on in the
 * same transaction, keyed on the checkpoint, so one achievement wakes it at
 * most once.
 *
 * A new run, not more of this one: a wake's conversation work is chosen
 * under the lease before any model call and frozen on its row (INV-3), and
 * the woken run re-reads every gate under its own lease — the kill switch,
 * the action target, the Stops, the conversation, the owner — as any event wake does. It
 * takes the account when this run lets go of it.
 *
 * It wakes only for work that wake would plan: the campaign Active, the org
 * neither stopped nor paused, a hand-on {@link plannedHandOn} would serve —
 * no Stop on the account, the campaign or the conversation, the conversation open,
 * runnable and not the owner's to answer, the next step not already done on
 * that exchange — and a next step the owner left an action on. A wake of the
 * Ambassador already waiting in the queue plans every hand-on there is, so
 * none is added beside it; a scheduled run that plans this one first leaves
 * the wake nothing to do, which it records like any event wake.
 *
 * Null when nothing was enqueued.
 */
export async function wakeOnHandOn(
  tx: Tx,
  input: { campaignId: number; conversationId: number; stepRunId: number; now: number },
): Promise<number | null> {
  const [campaign] = await tx
    .select({
      id: campaigns.id,
      status: campaigns.status,
      channelId: campaigns.channelId,
    })
    .from(campaigns)
    .where(and(eq(campaigns.id, input.campaignId), isNull(campaigns.deletedAt)));
  if (campaign?.status !== "active") return null;
  const system = await getSystemState(tx);
  if (system?.killSwitch === true) return null;
  if (system?.pausedUntil != null && system.pausedUntil > input.now) return null;

  const handOn = await plannedHandOn(tx, campaign, input.conversationId);
  if (!handOn || !await stepOn(tx, campaign.id, handOn.strategy, handOn.item.stepId)) return null;
  if (await wakeWaiting(tx, campaign.id)) return null;
  return wakeAmbassador(tx, campaign.id, `handed_on:${input.stepRunId}`);
}

/** Whether the owner left the step an action that is not Off. */
async function stepOn(tx: Tx, campaignId: number, strategy: LoadedStrategy, stepId: string): Promise<boolean> {
  for (const binding of strategy.document.action_bindings ?? []) {
    if (binding.owner_step_id !== stepId) continue;
    const mode = (await modeFor(tx, { campaignId, actionBindingId: binding.action_binding_id })).effective;
    if (mode && mode !== "off") return true;
  }
  return false;
}

/** Whether an event or match wake of the campaign's Ambassador is queued:
 *  either waits out the account's lease rather than skipping, and plans its
 *  conversation work after this run lets go. A schedule's run or a press may
 *  skip on the lease instead, so neither counts. */
async function wakeWaiting(tx: Tx, campaignId: number): Promise<boolean> {
  const [waiting] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .innerJoin(workers, sql`${jobs.payload}->>'workerId' = ${workers.id}::text`)
    .where(
      and(
        // `jobs` is outside RLS, so the org predicate is explicit: the
        // transaction's own.
        sql`${jobs.organizationId} = nullif(current_setting('app.current_org', true), '')::uuid`,
        eq(jobs.type, "worker_run"),
        eq(jobs.status, "queued"),
        sql`${jobs.payload}->>'trigger' in ('event', 'match')`,
        eq(workers.campaignId, campaignId),
        eq(workers.type, "ambassador"),
      ),
    )
    .limit(1);
  return waiting !== undefined;
}
