import { eq, sql } from "drizzle-orm";
import { leads, type Campaign, type SearchDepth } from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { openPauses, scopesOf } from "../../actions/pause";
import { readSearchDepth } from "../../strategy/searchDepth";
import { leadsEnabled } from "../../leads/gate";
import { emptyLeadCounts } from "../../leads/scout/counts";
import { planSearchMap } from "../../leads/scout/mapPlan";
import { LEAD_QUALIFY_BATCH, qualifyLeads, type QualifyResult } from "../../leads/scout/qualify";
import { judgeQueue, type QueuedPerson } from "../../leads/scout/queues";
import { serveLead } from "../../leads/scout/serve";
import { leadRunShapeFor } from "../../leads/scout/shape";
import { readFindLeadsStep, type FindLeadsStep } from "../../leads/scout/phase";
import { agentHold, wakeLeadPhase, type LeadPhasePayload } from "../../leads/scout/wake";
import { getCampaign } from "../../operations/campaigns";
import { getSystemState } from "../../ratelimit/killswitch";
import { trackSignalResearched } from "../../telemetry/leadFunnel";
import { wakeAmbassadorOnMatch } from "../../workers/matchWake";
import { leadOpenersOwed } from "../../workers/phases";
import { jobGuardedLlm } from "../providerGuard";
import { assertHostedJobSpendStillAllowed } from "../spendAccess";
import type { JobResult, SelfScopedCtx } from "../worker";

/** The judgments a person may fail before Judge sets them aside. */
export const JUDGE_TRIES = 3;

/** Why Judge set a person aside, in the owner's words. */
export const JUDGE_GAVE_UP_NOTE = `Your agent's verdict did not pass the checks in ${JUDGE_TRIES} tries.`;

/**
 * Judge's start, frozen: the people it takes, and what their judgment
 * reads off the campaign.
 */
type Frozen = {
  campaign: Campaign;
  channelId: number;
  depth: SearchDepth;
  instructions: string[];
  people: QueuedPerson[];
};

/**
 * The campaign and its Find leads step, or null where its steps may not run
 * now: the campaign gone, Paused or stopped, the kill switch or the
 * organization's pause on, leads switched off or the step missing. The window is
 * not asked: Judge reads nothing from LinkedIn.
 */
async function standing(
  tx: Tx,
  campaignId: number,
  now: number,
): Promise<{ campaign: Campaign; channelId: number; step: FindLeadsStep } | null> {
  const campaign = await getCampaign(tx, campaignId);
  if (!campaign || campaign.status !== "active" || campaign.channelId === null) return null;
  const system = await getSystemState(tx);
  if (system?.killSwitch === true) return null;
  if (system?.pausedUntil != null && system.pausedUntil > now) return null;
  const stops = await openPauses(tx, scopesOf({ channelId: campaign.channelId, campaignId, conversationId: null }));
  if (stops.length > 0 || !(await leadsEnabled(tx))) return null;
  const step = await readFindLeadsStep(tx, campaign);
  return step && { campaign, channelId: campaign.channelId, step };
}

/**
 * The people Judge takes now, or null where it takes no one: the campaign gone,
 * Paused or stopped, the kill switch or the organization's pause on, Research
 * Off, or nobody waiting.
 */
async function freeze(tx: Tx, campaignId: number, now: number): Promise<Frozen | null> {
  const held = await standing(tx, campaignId, now);
  if (!held?.step.research) return null;
  const people = await judgeQueue(tx, campaignId, LEAD_QUALIFY_BATCH, now);
  if (!people.length) return null;
  return {
    campaign: held.campaign,
    channelId: held.channelId,
    depth: await readSearchDepth(tx, held.campaign),
    instructions: held.step.instructions,
    people,
  };
}

/** Count a judgment that failed against a person, setting them aside once they
 *  have failed `JUDGE_TRIES`. Whether it did. */
async function countFailure(tx: Tx, leadId: number, now: number): Promise<boolean> {
  const [lead] = await tx
    .update(leads)
    .set({ judgeTries: sql`${leads.judgeTries} + 1`, updatedAt: now })
    .where(eq(leads.id, leadId))
    .returning({ tries: leads.judgeTries });
  if (!lead || lead.tries < JUDGE_TRIES) return false;
  await tx.update(leads).set({ pipelineHold: "unjudged", pipelineHoldNote: JUDGE_GAVE_UP_NOTE, updatedAt: now }).where(eq(leads.id, leadId));
  return true;
}

/** Judge takes the next person at once while any remain. */
async function wakeWhilePeopleRemain(tx: Tx, campaignId: number, now: number): Promise<void> {
  if ((await judgeQueue(tx, campaignId, 1, now)).length > 0) await wakeLeadPhase(tx, "judge", campaignId, now);
}

/**
 * Judge the frozen people in one qualify call at the campaign's
 * depth, which stores a verdict only as `qualifyLeads` accepts one, and a Lead
 * served for a buyer with a fit. A verdict the rules refuse counts a try against
 * the person, and at `JUDGE_TRIES` they are set aside (`pipeline_hold`) with the
 * reason. The agent being away — out of quota, signed out, not answering —
 * counts against no one: it ends with that refusal and wakes Judge again when
 * the agent may answer.
 */
async function judgePerson(ctx: SelfScopedCtx, campaignId: number, frozen: Frozen): Promise<JobResult> {
  const org = ctx.organizationId;
  const { campaign, channelId, depth, instructions, people } = frozen;

  let judged: QualifyResult;
  try {
    judged = await qualifyLeads({
      organizationId: org,
      campaign: { id: campaignId },
      shape: leadRunShapeFor(depth),
      instructions,
      leadIds: people.map((person) => person.id),
      llm: jobGuardedLlm(ctx),
      now: Date.now(),
      // One person's outcome, which the job's result reports; no run row holds it.
      counts: emptyLeadCounts(),
      report: async () => {},
      continueRun: async () => ctx.signal?.aborted !== true,
    });
  } catch (error) {
    const hold = agentHold(error);
    if (!hold) throw error;
    await withOrg(org, (tx) => wakeLeadPhase(tx, "judge", campaignId, hold.retryAt));
    return { refusal: hold };
  }

  if (ctx.signal?.aborted) return {};
  for (const note of judged.notes) {
    // eslint-disable-next-line no-console
    console.warn(`[lead_judge] campaign ${campaignId}: ${note}`);
  }
  let servedCount = 0;
  let setAside = 0;
  // Each person lands in a transaction of their own: one that fails leaves the
  // verdicts already stored for the others served.
  for (const id of new Set([...judged.rejected, ...judged.unanswered])) {
    if (await withOrg(org, (tx) => countFailure(tx, id, Date.now()))) setAside++;
  }
  for (const verdict of judged.qualified) {
    try {
      const served = await withOrg(org, async (tx) => {
        const now = Date.now();
        const lead = verdict.outcome === "buyer" ? await serveLead(tx, { campaignId, leadId: verdict.leadId, depth, now }) : null;
        // A wake follows only where the Ambassador can draft this lead's opener.
        if (lead && (await leadOpenersOwed(tx, campaign, now)).some((opener) => opener.leadId === verdict.leadId)) {
          await wakeAmbassadorOnMatch(tx, { organizationId: org, campaignId, channelId, servedEventId: lead.eventId, now });
        }
        trackSignalResearched({ trigger: "step", outcome: verdict.outcome === "buyer" ? "lead" : "not_a_buyer" }, tx);
        return lead;
      });
      if (served) servedCount++;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(`[lead_judge] campaign ${campaignId}: serving lead ${verdict.leadId} failed:`, error instanceof Error ? error.message : error);
    }
  }
  return withOrg(org, async (tx) => {
    // Skips the tries bound (`unanswered`) do not stop the chain; a stop or a vanished person does.
    if (judged.skipped.every((id) => judged.unanswered.includes(id))) await wakeWhilePeopleRemain(tx, campaignId, Date.now());
    const failures = judged.notes.filter((note) => note.startsWith("Judging a batch failed")).length;
    const result: JobResult = {};
    if (judged.qualified.length) Object.assign(result, { judged: judged.qualified.length, served: servedCount });
    if (judged.rejected.length) Object.assign(result, { rejected: judged.rejected.length, setAside });
    if (failures && !judged.qualified.length && !judged.rejected.length) Object.assign(result, { batchFailures: failures });
    return result;
  });
}

/**
 * Tune the campaign's search map where a plan is due (`planSearchMap`):
 * the person just judged was the last of a Read posts pass, or a day has gone
 * by and the 5-minute check woke Judge for it. A campaign whose Find is Off
 * has no map of the Scout's to tune.
 */
async function tuneMap(ctx: SelfScopedCtx, campaignId: number): Promise<void> {
  const org = ctx.organizationId;
  const now = Date.now();
  const step = await withOrg(org, async (tx) => (await standing(tx, campaignId, now))?.step);
  if (!step?.find) return;
  await planSearchMap({
    organizationId: org,
    campaign: { id: campaignId },
    now,
    instructions: step.instructions,
    llm: jobGuardedLlm(ctx),
    continueRun: async () => ctx.signal?.aborted !== true,
  });
}

/**
 * Worker handler for `lead_judge`: the Judge of one campaign's Find leads. It
 * freezes a batch at the head of the campaign's judge queue
 * (`judgeQueue`, `leads/scout/queues.ts`), judges them (`judgePerson`) and wakes
 * itself while people remain; a buyer served wakes the Ambassador as a Scout
 * run's served leads did. After the judgment it tunes the campaign's search
 * map where a plan is due, which the 5-minute check wakes it for when no one is
 * waiting to be judged.
 *
 * No channel lease and no LinkedIn: it reads the profile and words already
 * stored, so the window does not hold it, and it never sends, likes or invites.
 * A Pause, a Stop and the kill switch hold it before the call. It refuses at
 * start where a hosted tenant's spend is no longer allowed, as every job that
 * calls the owner's agent does. No transaction is held across a model call.
 */
export async function handleLeadJudge(ctx: SelfScopedCtx, payload: LeadPhasePayload): Promise<JobResult> {
  await assertHostedJobSpendStillAllowed(ctx);
  const { campaignId } = payload;
  const frozen = await withOrg(ctx.organizationId, (tx) => freeze(tx, campaignId, Date.now()));
  const result: JobResult = frozen ? await judgePerson(ctx, campaignId, frozen) : {};
  // An agent that is away holds the plan as it holds the judgment.
  if (!("refusal" in result) && !("batchFailures" in result) && ctx.signal?.aborted !== true) await tuneMap(ctx, campaignId);
  return result;
}
