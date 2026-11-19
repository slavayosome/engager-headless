import { and, desc, eq } from "drizzle-orm";
import { campaignStrategies, channels, type Campaign } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { recordedLiveChecks } from "../../liveChecks/records";
import { readAccountDefault } from "../../strategy/activate";
import { NETWORK_CATALOGS } from "../../strategy/catalog";
import { parseStrategy } from "../../strategy/contract";
import { awaitingStart } from "../../strategy/read";
import { previewModes } from "../../strategy/preview";
import { modeFor } from "../../strategy/mode";

/**
 * WHAT A CAMPAIGN'S FIND LEADS STEP SAYS: the two reads it has On, and the
 * owner's words for it. The worker run reads this once, under the lease, to
 * decide whether the run is Find leads' (`runFindLeads`) or Find posts', as it
 * reads the search depth.
 */
export type FindLeadsStep = {
  /** Find is On: the sweep, the screen and the merge. */
  find: boolean;
  /** Research is On: the profile read, qualify and serve. */
  research: boolean;
  /** The step's objective and the owner's Instructions for it, which narrow
   *  the screen and never widen it. */
  instructions: string[];
};

/**
 * The Find leads step of the version in force, or of the draft a campaign
 * waiting for its Start would start from; null when the campaign has not been
 * switched or its document holds no such step. Each read is resolved the way
 * activation projects it (`projectDocument`): the document's own authority,
 * the account default included, no connector.
 */
export async function readFindLeadsStep(
  tx: Tx,
  campaign: Pick<Campaign, "id" | "status" | "channelId">,
): Promise<FindLeadsStep | null> {
  if (campaign.channelId === null) return null;
  const [channel] = await tx
    .select({ network: channels.network })
    .from(channels)
    .where(eq(channels.id, campaign.channelId));
  if (!channel) return null;
  const network = NETWORK_CATALOGS[channel.network];
  const waiting = await awaitingStart(tx, campaign);
  const [row] = await tx
    .select({ document: campaignStrategies.document })
    .from(campaignStrategies)
    .where(
      and(
        eq(campaignStrategies.campaignId, campaign.id),
        eq(campaignStrategies.status, waiting ? "draft" : "active"),
      ),
    )
    .orderBy(desc(campaignStrategies.version))
    .limit(1);
  const parsed = row ? parseStrategy(row.document, { network }) : null;
  if (!parsed?.success) return null;
  const document = parsed.data;
  const step = (document.steps ?? []).find((candidate) => candidate.catalog_step === "find_leads");
  if (!step) return null;
  const actions = waiting ? previewModes({
    accountDefault: (await readAccountDefault(tx, campaign.channelId, { network }))?.document ?? null,
    campaign: document,
    network,
    connector: null,
    liveChecks: await recordedLiveChecks(tx, campaign.channelId),
  }) : [];
  const on = async (capability: "find_leads" | "research_lead") => waiting
    ? actions.some((action) => action.capability === capability && action.effective === "on")
    : (await modeFor(tx, { campaignId: campaign.id, capability, stepId: step.step_id })).effective === "on";
  return {
    find: await on("find_leads"),
    research: await on("research_lead"),
    instructions: [step.objective, step.instructions].filter((text) => text.trim().length > 0),
  };
}
