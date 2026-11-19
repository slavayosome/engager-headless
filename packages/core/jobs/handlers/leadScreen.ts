import { withOrg } from "@engager/database/tenant";
import { openPauses, scopesOf } from "../../actions/pause";
import { readSearchDepth } from "../../strategy/searchDepth";
import { leadsEnabled } from "../../leads/gate";
import { emptyLeadCounts } from "../../leads/scout/counts";
import { mergeSignals } from "../../leads/scout/merge";
import { judgeQueue, readQueue, screenQueue } from "../../leads/scout/queues";
import { screenNextBatch, type Judged } from "../../leads/scout/screen";
import { readFindLeadsStep } from "../../leads/scout/phase";
import { agentHold, wakeLeadPhase, type LeadPhasePayload } from "../../leads/scout/wake";
import { getCampaign } from "../../operations/campaigns";
import { leadScreenRuleOn } from "../../operations/orgSettings";
import { getSystemState } from "../../ratelimit/killswitch";
import { jobGuardedLlm } from "../providerGuard";
import { assertHostedJobSpendStillAllowed } from "../spendAccess";
import type { JobResult, SelfScopedCtx } from "../worker";

/**
 * Worker handler for `lead_screen`: the Screen of one campaign's Find leads
 * (`screenQueue`, `leads/scout/queues.ts`). One job screens one batch of the
 * campaign's newest words with one call to the owner's agent, merges the people
 * who passed into Signals, then wakes what they are owed: Read profiles where
 * the depth reads them, Judge for anyone who already holds a read, and itself
 * while words remain. Where the org's screen
 * rule is on, the words it drops are dropped before the call and never reach it.
 * It holds no channel lease and never calls the LinkedIn driver, and the active
 * window does not stop it: it reads only what is stored. A campaign that is
 * paused or stopped, or the kill switch, ends it before any call. It refuses at
 * start where a hosted tenant's spend is no longer allowed, as every job that
 * calls the owner's agent does. A word the call gave no accepted verdict is a try
 * against it, and the third sets it aside; an agent that cannot answer (out of
 * quota, signed out, timed out) counts no try and holds the step until it may.
 *
 * SELF_SCOPED because the call is the owner's agent: every DB touch is its own
 * short transaction, and none is held across it.
 */
export async function handleLeadScreen(ctx: SelfScopedCtx, payload: LeadPhasePayload): Promise<JobResult> {
  await assertHostedJobSpendStillAllowed(ctx);
  const org = ctx.organizationId;
  const { campaignId } = payload;
  const setup = await withOrg(org, async (tx) => {
    const campaign = await getCampaign(tx, campaignId);
    if (!campaign || campaign.channelId === null || campaign.status !== "active") return null;
    const system = await getSystemState(tx);
    if (system?.killSwitch === true || (system?.pausedUntil != null && system.pausedUntil > Date.now()) || !(await leadsEnabled(tx))) return null;
    const stops = await openPauses(tx, scopesOf({ channelId: campaign.channelId, campaignId, conversationId: null }));
    if (stops.length > 0) return null;
    const step = await readFindLeadsStep(tx, campaign);
    return step?.find ? { campaign, step, depth: await readSearchDepth(tx, campaign), rule: await leadScreenRuleOn(tx) } : null;
  });
  if (!setup) return {};
  const { campaign, step, depth, rule } = setup;

  let written: Judged[];
  try {
    written = await screenNextBatch({
      organizationId: org,
      campaign,
      instructions: step.instructions,
      llm: jobGuardedLlm(ctx),
      rule,
    });
  } catch (error) {
    // The agent being away is no fault of the words: no try is counted, and the
    // step asks again when the agent may answer.
    const hold = agentHold(error);
    if (!hold) throw error;
    await withOrg(org, (tx) => wakeLeadPhase(tx, "screen", campaignId, hold.retryAt));
    return { refusal: hold };
  }
  // The people who passed, and any a job that ended before it merged left.
  await mergeSignals({
    organizationId: org,
    campaign,
    depth,
    counts: emptyLeadCounts(),
    report: async () => {},
    continueRun: async () => !ctx.signal?.aborted,
  });

  await withOrg(org, async (tx) => {
    // Quick reads and judges nobody: its queues are empty. A person who holds a
    // read inside its window needs no read, so Judge takes them directly.
    if (step.research && (await readQueue(tx, campaignId, 1)).length > 0) await wakeLeadPhase(tx, "read", campaignId);
    if (step.research && (await judgeQueue(tx, campaignId, 1)).length > 0) await wakeLeadPhase(tx, "judge", campaignId);
    if ((await screenQueue(tx, campaignId, 1)).length > 0) await wakeLeadPhase(tx, "screen", campaignId);
  });
  return { screened: written.length, passed: written.filter((verdict) => verdict.verdict === "passed").length };
}
