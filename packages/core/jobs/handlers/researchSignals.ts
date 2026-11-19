import { and, eq, inArray } from "drizzle-orm";
import { leads } from "@engager/database/schema";
import { withOrg } from "@engager/database/tenant";
import { isGrant } from "../../connector/resolve";
import { readLeadCompanies } from "../../leads/scout/companyRead";
import { emptyLeadCounts } from "../../leads/scout/counts";
import { PRESS_WAIT_MS, researchRefusal } from "../../leads/scout/press";
import { LEAD_QUALIFY_BATCH, qualifyLeads } from "../../leads/scout/qualify";
import { readQueue } from "../../leads/scout/queues";
import { OUT_OF_REACH_NOTE, readLeadProfile, setAsideUnread } from "../../leads/scout/research";
import { serveLead } from "../../leads/scout/serve";
import { leadRunShapeFor } from "../../leads/scout/shape";
import { readFindLeadsStep } from "../../leads/scout/phase";
import { wakeLeadPhase } from "../../leads/scout/wake";
import { readAsked, type AskedReadPayload } from "../../people/askedRead";
import { readSearchDepth } from "../../strategy/searchDepth";
import { getCampaign } from "../../operations/campaigns";
import { claimExclusiveRun, releaseExclusiveRun, renewExclusiveRun } from "../../pacing";
import { channelCeilings } from "../../ratelimit/ledger";
import { capabilityGrant, grantFor } from "../context";
import { jobGuardedLlm } from "../providerGuard";
import { RescheduleError } from "../queue";
import { trackSignalResearched } from "../../telemetry/leadFunnel";
import { assertHostedJobSpendStillAllowed, assertHostedJobSpendStillAllowedInTx } from "../spendAccess";
import type { JobResult, SelfScopedCtx } from "../worker";

const MINUTE = 60_000;
/** The account's run lease, renewed before each person. */
const LEASE_MS = 5 * MINUTE;
/** The people one Read profiles job reads. */
const STEP_READS = 5;

/** The owner's press, frozen: these leads, in this order (`researchSignals`),
 *  and whether they named them (`press`) or took the newest few (`batch`). A
 *  payload queued before it said is a press. */
export type ResearchPressPayload = {
  campaignId: number;
  leadIds: number[];
  requestedAt: number;
  trigger?: "press" | "batch";
};

/** Read profiles waking for a campaign (`leads/scout/wake.ts`), which names no
 *  leads: it takes them from the campaign's queue. */
export type ResearchStepPayload = { campaignId: number; trigger: "step" };

export type ResearchSignalsPayload = ResearchPressPayload | ResearchStepPayload | AskedReadPayload;

/**
 * Worker handler for `research_signals`: the owner's Research on the Signals
 * a press froze (`leads/scout/press.ts`), or Read profiles for a campaign
 * where the payload says `step` (`readProfiles`, below). A press holds the
 * account's run lease, as a run does, and waits while a run or another read
 * holds it. For each person in order: their profile, from the read they have
 * or one new read through the account's daily reads (`readLeadProfile`), then
 * the one qualify call, then serve, which makes a Buyer with a fit a Lead in
 * place; any other verdict is stored as qualify stores it. A refusal stops the
 * press — the daily reads
 * spent, the window, a pause, the stop or reads turned off — and so does a
 * model that cannot answer, whose person keeps the read for a later judgment.
 * A read the connector fails leaves that person a Signal and goes on. Whoever
 * it does not reach stays a Signal, and every "Researching…" it set comes off,
 * done or not. It judges at the campaign's depth (Quick's as Standard's): at
 * Deep it hands the call the product facts and holds a Strong fit to one, and
 * uses a company page already read. It runs no sweep, opens no thread, reads no
 * new company page, and sends and drafts nothing.
 */
export async function handleResearchSignals(ctx: SelfScopedCtx, payload: ResearchSignalsPayload): Promise<JobResult> {
  if (payload.trigger === "step") return readProfiles(ctx, payload.campaignId);
  if (payload.trigger === "ask") return readOnAsk(ctx, payload);
  const org = ctx.organizationId;
  const { campaignId, leadIds, requestedAt } = payload;
  const trigger = payload.trigger ?? "press";
  const now = Date.now();
  /** The press is done with these: researched, refused or never reached. */
  const settle = async (ids: readonly number[]) => {
    if (ids.length === 0) return;
    await withOrg(org, (tx) =>
      tx
        .update(leads)
        .set({ researchRequestedAt: null, updatedAt: Date.now() })
        .where(and(inArray(leads.id, [...ids]), eq(leads.researchRequestedAt, requestedAt))),
    );
  };
  if (now >= requestedAt + PRESS_WAIT_MS) {
    await settle(leadIds);
    return { expired: leadIds.length };
  }

  let reached = 0;
  let lease: { key: string; expiry: number } | null = null;
  // A job that will run again keeps its people waiting; any other end clears them.
  let retrying = false;
  try {
    const setup = await withOrg(org, async (tx) => {
      await assertHostedJobSpendStillAllowedInTx(tx, ctx);
      const campaign = await getCampaign(tx, campaignId);
      if (!campaign || campaign.channelId === null) return null;
      return {
        channelId: campaign.channelId,
        depth: await readSearchDepth(tx, campaign),
        instructions: (await readFindLeadsStep(tx, campaign))?.instructions ?? [],
        grant: await grantFor(ctx, tx, "profile_read"),
      };
    });
    if (!setup || !isGrant(setup.grant)) return { unreachable: leadIds.length };
    const driver = setup.grant.use;
    await assertHostedJobSpendStillAllowed(ctx);
    const key = `worker-run:${setup.channelId}`;
    const claimed = await withOrg(org, (tx) => claimExclusiveRun(tx, key, LEASE_MS, now));
    if (!claimed.claimed) throw new RescheduleError("lease_held", Math.min(now + 5 * MINUTE, requestedAt + PRESS_WAIT_MS));
    lease = { key, expiry: claimed.expiresAt };
    const held = lease;
    const continueRun = async () => {
      if (ctx.signal?.aborted) return false;
      const renewed = await withOrg(org, (tx) => renewExclusiveRun(tx, held.key, LEASE_MS, Date.now(), held.expiry));
      if (renewed === null) return false;
      held.expiry = renewed;
      return true;
    };
    const llm = jobGuardedLlm(ctx);
    // The press counts nothing on a run row; these are only what the stages need.
    const counts = emptyLeadCounts();
    const report = async () => {};

    const done = { researched: 0, served: 0, failed: 0 };
    const ready: number[] = [];
    for (const leadId of leadIds) {
      if (!(await continueRun())) break;
      const read = await readLeadProfile({ organizationId: org, campaignId, leadId, now: Date.now(), driver, role: leadRunShapeFor(setup.depth).companyPage, counts, report });
      if (read.status === "stopped") {
        trackSignalResearched({ trigger, outcome: "refused" });
        break;
      }
      if (read.status === "failed") {
        done.failed += 1;
        trackSignalResearched({ trigger, outcome: "failed" });
      }
      if (read.status === "read" || read.status === "cached") {
        done.researched += 1;
        ready.push(leadId);
      }
      reached += 1;
    }
    // A batch is judged and its buyers served before the next, so a failure
    // later leaves no stored verdict unserved.
    for (let offset = 0; offset < ready.length; offset += LEAD_QUALIFY_BATCH) {
      const judged = await qualifyLeads({
        organizationId: org,
        campaign: { id: campaignId },
        shape: leadRunShapeFor(setup.depth === "quick" ? "standard" : setup.depth),
        instructions: setup.instructions,
        leadIds: ready.slice(offset, offset + LEAD_QUALIFY_BATCH),
        llm,
        now: Date.now(),
        counts,
        report,
        continueRun,
      });
      for (const verdict of judged.qualified) {
        const served = await withOrg(org, (tx) => serveLead(tx, { campaignId, leadId: verdict.leadId, depth: setup.depth, now: Date.now() }));
        if (served) done.served += 1;
        trackSignalResearched({ trigger, outcome: served ? "lead" : "not_a_buyer" });
      }
      done.failed += judged.rejected.length;
    }
    await settle(leadIds.slice(0, reached));
    return { ...done, unreached: leadIds.length - reached };
  } catch (error) {
    retrying = error instanceof RescheduleError;
    throw error;
  } finally {
    if (!retrying) await settle(leadIds);
    if (lease) {
      const { key, expiry } = lease;
      await withOrg(org, (tx) => releaseExclusiveRun(tx, key, expiry, Date.now()));
    }
  }
}

/**
 * Read profiles (`trigger: "step"`): the next people in the campaign's read
 * queue (`readQueue`), up to five, read under the account's run lease as the
 * press reads them. Each profile is read through the account's daily reads
 * (`readLeadProfile`) and stored on the person, and at Deep so is the page of
 * the company they work at (`readLeadCompanies`). It judges and serves no one:
 * it wakes Judge, and wakes itself while people wait. A refusal ends the reads
 * — the day's reads spent or the window shut wake it for when they free, while
 * a pause, a Stop, the kill switch or reads turned off wake nothing, which the
 * 5-minute check takes up once they end. A read the connector fails leaves that
 * person in the queue until it has failed three times (`readLeadProfile`), and a
 * person the owner's rules put out of reach is set aside at once. It sends,
 * likes and follows no one.
 */
async function readProfiles(ctx: SelfScopedCtx, campaignId: number): Promise<JobResult> {
  const org = ctx.organizationId;
  const allowedIn = async (tx: Parameters<typeof getCampaign>[0]) => {
    const campaign = await getCampaign(tx, campaignId);
    if (!campaign || campaign.channelId === null || campaign.status !== "active") return false;
    const step = await readFindLeadsStep(tx, campaign);
    return step?.research === true && (await researchRefusal(tx, { id: campaign.id, channelId: campaign.channelId }, Date.now())) === null;
  };
  const allowed = () => withOrg(org, allowedIn);
  const setup = await withOrg(org, async (tx) => {
    await assertHostedJobSpendStillAllowedInTx(tx, ctx);
    const campaign = await getCampaign(tx, campaignId);
    if (!campaign || campaign.channelId === null || campaign.status !== "active") return null;
    const step = await readFindLeadsStep(tx, campaign);
    if (!step?.research) return null;
    if ((await researchRefusal(tx, { id: campaign.id, channelId: campaign.channelId }, Date.now())) !== null) return null;
    return {
      channelId: campaign.channelId,
      depth: await readSearchDepth(tx, campaign),
      grant: await grantFor(ctx, tx, "profile_read"),
    };
  });
  if (!setup || !isGrant(setup.grant)) return {};
  const driver = setup.grant.use;
  await assertHostedJobSpendStillAllowed(ctx);
  const key = `worker-run:${setup.channelId}`;
  const claimed = await withOrg(org, (tx) => claimExclusiveRun(tx, key, LEASE_MS, Date.now()));
  if (!claimed.claimed) throw new RescheduleError("lease_held", Date.now() + 5 * MINUTE);
  const lease = { key, expiry: claimed.expiresAt };
  const continueRun = async () => {
    if (ctx.signal?.aborted) return false;
    if (!(await allowed())) return false;
    const renewed = await withOrg(org, (tx) => renewExclusiveRun(tx, lease.key, LEASE_MS, Date.now(), lease.expiry));
    if (renewed === null) return false;
    lease.expiry = renewed;
    return true;
  };
  // Nothing is counted on a run row; these are only what the reads need.
  const counts = emptyLeadCounts();
  const report = async () => {};

  const done = { researched: 0, failed: 0 };
  let refused: { retryAt?: number } | null = null;
  try {
    const people = await withOrg(org, (tx) => readQueue(tx, campaignId, STEP_READS));
    for (const { id: leadId } of people) {
      if (!(await continueRun())) break;
      const read = await readLeadProfile({ organizationId: org, campaignId, leadId, now: Date.now(), driver, role: leadRunShapeFor(setup.depth).companyPage, counts, report });
      if (read.status === "stopped") {
        refused = read;
        break;
      }
      if (read.status === "failed") done.failed += 1;
      // Left in the queue, they would be taken first every time.
      if (read.status === "gone") await withOrg(org, (tx) => setAsideUnread(tx, leadId, OUT_OF_REACH_NOTE));
      if (read.status === "read" || read.status === "cached") {
        done.researched += 1;
        if (leadRunShapeFor(setup.depth).companyPage) {
          await readLeadCompanies({
            organizationId: org,
            campaign: { id: campaignId },
            leadIds: [leadId],
            now: Date.now(),
            grant: capabilityGrant(ctx),
            counts,
            report,
            continueRun,
          });
        }
      }
    }
  } finally {
    await withOrg(org, (tx) => releaseExclusiveRun(tx, lease.key, lease.expiry, Date.now()));
  }
  await withOrg(org, async (tx) => {
    if (!(await allowedIn(tx))) return;
    if (done.researched > 0) await wakeLeadPhase(tx, "judge", campaignId);
    if (refused === null) {
      if ((await readQueue(tx, campaignId, 1)).length > 0) await wakeLeadPhase(tx, "read", campaignId);
    } else if (refused.retryAt !== undefined) {
      await wakeLeadPhase(tx, "read", campaignId, refused.retryAt);
    }
  });
  return done;
}

/**
 * The owner's asked read (`trigger: "ask"`, `people/askedRead.ts`): one
 * person's profile and their company's page, under the account's run lease as
 * every other read here. It waits behind a run for as long as a press does,
 * then gives up. It judges and serves no one.
 */
async function readOnAsk(ctx: SelfScopedCtx, payload: AskedReadPayload): Promise<JobResult> {
  const org = ctx.organizationId;
  const now = Date.now();
  if (now >= payload.requestedAt + PRESS_WAIT_MS) return { expired: 1 };
  const setup = await withOrg(org, async (tx) => {
    await assertHostedJobSpendStillAllowedInTx(tx, ctx);
    return { channel: await channelCeilings(tx), grant: await grantFor(ctx, tx, "profile_read") };
  });
  if (!setup.channel || !isGrant(setup.grant)) return { unreachable: 1 };
  await assertHostedJobSpendStillAllowed(ctx);
  const key = `worker-run:${setup.channel.id}`;
  const claimed = await withOrg(org, (tx) => claimExclusiveRun(tx, key, LEASE_MS, now));
  if (!claimed.claimed) throw new RescheduleError("lease_held", Math.min(now + MINUTE, payload.requestedAt + PRESS_WAIT_MS));
  try {
    const asked = await readAsked({ organizationId: org, profileId: payload.profileId, campaignId: payload.campaignId, driver: setup.grant.use });
    // A job's result is counts: how many of the two pages came to each end.
    const done: Record<string, number> = {};
    for (const page of [asked.profile, asked.company]) done[page] = (done[page] ?? 0) + 1;
    return done;
  } finally {
    await withOrg(org, (tx) => releaseExclusiveRun(tx, key, claimed.expiresAt, Date.now()));
  }
}
