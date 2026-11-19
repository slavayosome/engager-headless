import { and, eq, isNull, sql } from "drizzle-orm";
import { campaigns, leadSignals, type Campaign } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { openPauses, scopesOf } from "../../actions/pause";
import { getSystemState } from "../../ratelimit/killswitch";
import { leadsEnabled } from "../gate";
import { planDue } from "./mapPlan";
import { EXPIRY_GRACE_DAYS, pipelineCounts, type PipelineCounts } from "./queues";
import { readFindLeadsStep, type FindLeadsStep } from "./phase";
import { phaseHasJob, wakeLeadPhase, type LeadPhase } from "./wake";

/**
 * THE CHECK: a Find leads phase whose queue holds work and which has no job to
 * do it is stalled, and the check wakes it. A crash, a quit or a sleep leaves
 * exactly that: the words and the people are rows, the job that was to take them
 * is gone. It runs on the scheduler's tick and once as the runtime starts, wakes
 * only phases with work, and writes nothing for a campaign whose queues are
 * empty.
 *
 * The check also expires the words that waited for the screen past the age the
 * campaign reads (`expireWords`), so nothing goes stale without being counted.
 * Judge also tunes the campaign's search map, which the check cannot do
 * itself: it runs in the scheduler's transaction, and no transaction is held
 * across a model call. So where a plan is due (`planDue`) and Find is On, it
 * wakes Judge for it.
 *
 * It wakes nothing for a campaign that is paused or stopped, nor under the kill
 * switch; the tick after the owner resumes wakes what waited. It asks one count
 * of each campaign (`pipelineCounts`) and reads nothing from LinkedIn.
 */

const DAY = 86_400_000;

/**
 * Expire the campaign's pending words that aged out before the screen took
 * them: a post or comment older than the post age the campaign reads, and
 * `EXPIRY_GRACE_DAYS` more, which the sweep would have skipped (`maxPostAgeDays`
 * 0 reads any age, so nothing expires). The screen never takes one, and
 * `pipelineCounts` counts it as gone stale. Only words are touched: whoever
 * else the person said stands as it was.
 */
async function expireWords(tx: Tx, campaign: Pick<Campaign, "id" | "maxPostAgeDays">, now: number): Promise<void> {
  if (campaign.maxPostAgeDays <= 0) return;
  const cutoff = now - (campaign.maxPostAgeDays + EXPIRY_GRACE_DAYS) * DAY;
  await tx
    .update(leadSignals)
    .set({ verdict: "expired", expiredAt: now })
    .where(
      and(
        eq(leadSignals.campaignId, campaign.id),
        eq(leadSignals.verdict, "pending"),
        sql`coalesce(${leadSignals.saidAt}, ${leadSignals.seenAt}) < ${cutoff}`,
      ),
    );
}

/** A phase the check woke, for the campaign whose queue held work. */
export type WokenPhase = { campaignId: number; phase: LeadPhase };

/**
 * Wake each phase of the campaign whose queue holds work and which has no job to
 * do it, and say which. Screen wakes where the campaign's Find is On, and Read
 * profiles and Judge where its Research is On, as the run reads them. It asks
 * nothing of a pause or a stop: the caller has.
 */
export async function wakePhasesWithWork(
  tx: Tx,
  campaign: Pick<Campaign, "id" | "organizationId">,
  step: FindLeadsStep,
  counts: PipelineCounts,
  now: number = Date.now(),
  planning: boolean = false,
): Promise<LeadPhase[]> {
  const waiting: ReadonlyArray<readonly [LeadPhase, number]> = [
    ["screen", step.find ? counts.toScreen : 0],
    ["read", step.research ? counts.waitingForRead : 0],
    // Judge also tunes the map, so a plan that is due wakes it with nobody to judge.
    ["judge", (step.research ? counts.toJudge : 0) + (planning ? 1 : 0)],
  ];
  const woken: LeadPhase[] = [];
  for (const [name, work] of waiting) {
    if (work === 0 || (await phaseHasJob(tx, campaign.organizationId, name, campaign.id))) continue;
    await wakeLeadPhase(tx, name, campaign.id, now);
    woken.push(name);
  }
  return woken;
}

/**
 * Wake every stalled phase of the organization's Find leads campaigns, each as
 * the campaign's Find and Research switches read it (`FindLeadsStep`).
 */
export async function wakeStalledPhases(tx: Tx, now: number = Date.now()): Promise<WokenPhase[]> {
  const standing = await tx
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.status, "active"), isNull(campaigns.deletedAt)));
  if (standing.length === 0) return [];
  if ((await getSystemState(tx))?.killSwitch === true) return [];
  if (!(await leadsEnabled(tx))) return [];

  const woken: WokenPhase[] = [];
  for (const campaign of standing) {
    // A Screen call freezes pending words before inference. Do not expire that
    // frozen batch while its answer is in flight.
    if (!(await phaseHasJob(tx, campaign.organizationId, "screen", campaign.id))) await expireWords(tx, campaign, now);
    if (campaign.channelId === null) continue;
    const step = await readFindLeadsStep(tx, campaign);
    if (!step || (!step.find && !step.research)) continue;
    const stops = await openPauses(tx, scopesOf({ channelId: campaign.channelId, campaignId: campaign.id, conversationId: null }));
    if (stops.length > 0) continue;

    const counts = await pipelineCounts(tx, campaign.id, now);
    const planning = step.find && (await planDue(tx, campaign.id, now));
    for (const name of await wakePhasesWithWork(tx, campaign, step, counts, now, planning)) woken.push({ campaignId: campaign.id, phase: name });
  }
  return woken;
}
