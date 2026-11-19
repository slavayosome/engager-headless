import { and, desc, eq, isNull } from "drizzle-orm";
import {
  campaignStrategies,
  campaigns,
  channels,
  type Campaign,
  type SearchDepth,
  type StoredSearchDepth,
} from "@engager/database/schema";
import { afterCommit, type Tx } from "@engager/database/tenant";
import { track } from "@engager/observability/analytics";
import { RESEARCH_OFF_NOTE } from "../leads/scout/shape";
import { recordedLiveChecks } from "../liveChecks/records";
import { readAccountDefault } from "./activate";
import { NETWORK_CATALOGS } from "./catalog";
import { holdsStep, parseStrategy, type CampaignAgentStrategy } from "./contract";
import { projectionOf, resolvedAsProjected, type ProjectionContext } from "./project";
import { awaitingStart } from "./read";
import type { ResolvedAction } from "./resolve";

/**
 * A CAMPAIGN'S SEARCH DEPTH, AND THE READ THAT IS DEEP. Deep is one read of the
 * campaign's Scout step, and that read is the one source of truth for it: Find
 * posts' Research on a campaign whose Scout finds posts, Find leads' Company
 * page read on one whose Scout finds leads. `campaigns.search_depth` stores
 * only the Quick or Standard the owner or their agent chose, and a campaign
 * whose Deep read is on reads Deep whatever is stored. So depth and that read
 * never disagree, whichever path moved it — the depth itself, the Strategy, a
 * confirmed card, an undo, a template design. Find leads' own Research is not
 * Deep: it is the owner's switch for reading a person, On at every depth, and
 * only a depth above Quick lets a run use it.
 *
 * Turning the Deep read on is a move to Deep, so it clears a stored Quick to
 * Standard — where a version's projection writes Research on
 * (`projectCampaign`, strategy/project.ts) and, for a draft that nothing
 * projects or a Company page read that no column holds, where a patch lands
 * (`settleSearchDepth`) — and turning it off afterwards reads Standard (SPEC
 * §4.1).
 */

/** Each depth as the owner reads it, on every surface that names one. */
export const SEARCH_DEPTH_LABELS: Readonly<Record<SearchDepth, string>> = {
  quick: "Quick",
  standard: "Standard",
  deep: "Deep",
};

/** The campaign fields its search depth is read from. */
export type DepthCampaign = Pick<
  Campaign,
  "id" | "status" | "channelId" | "searchDepth" | "verifyStage"
>;

/**
 * The search depth a campaign reads, from the depth stored for it and whether
 * its Deep read is on: Deep whenever it is, else the stored Quick, else
 * Standard. Pure.
 */
export function searchDepthOf(stored: StoredSearchDepth, deepOn: boolean): SearchDepth {
  if (deepOn) return "deep";
  return stored === "quick" ? "quick" : "standard";
}

/**
 * Whether a document's Deep read is on, over its actions resolved: Find leads'
 * Company page read where its Scout step is Find leads, else Find posts'
 * Research as the projection reads it (`verifyStage`). Pure.
 */
export function readsDeep(document: CampaignAgentStrategy, actions: readonly ResolvedAction[]): boolean {
  return holdsStep(document, "find_leads") &&
    actions.some((action) => action.capability === "read_company" && action.effective === "on");
}

/**
 * THE SEARCH DEPTH A CAMPAIGN READS, wherever it is read. Find posts' Research
 * is read where the runtime reads it: the `verifyStage` the version in force
 * projected. Find leads' Company page read, which no column holds, is read off
 * the version in force. On a campaign waiting for its Start, either is read
 * off the draft that Start would activate.
 */
export async function readSearchDepth(tx: Tx, campaign: DepthCampaign): Promise<SearchDepth> {
  return searchDepthOf(campaign.searchDepth, await deepRead(tx, campaign));
}

/**
 * The search depth a campaign would read with `document` in force — its Deep
 * read, account default and live checks included, over the Quick or Standard
 * stored. What a Start's card names: the depth of the document its Start
 * activates, the card's own changes applied. Pure.
 */
export function searchDepthIn(
  stored: StoredSearchDepth,
  document: CampaignAgentStrategy,
  context: ProjectionContext,
): SearchDepth {
  return searchDepthOf(stored, readsDeep(document, resolvedAsProjected(document, context)));
}

/**
 * What a campaign's depth says where it carries people no further than
 * Signal: a campaign that finds leads, at a depth above Quick, whose Research
 * is not On. Null for every other campaign and depth. Pure.
 */
export function researchOffNote(
  depth: SearchDepth,
  document: CampaignAgentStrategy | null,
  actions: readonly ResolvedAction[],
): string | null {
  if (depth === "quick" || document === null || !holdsStep(document, "find_leads")) return null;
  return actions.some((action) => action.capability === "research_lead" && action.effective === "on")
    ? null
    : RESEARCH_OFF_NOTE;
}

/** `researchOffNote` for a campaign at the `depth` it reads, off the version
 *  it reads that from, as `readSearchDepth` does. */
export async function readResearchOffNote(tx: Tx, campaign: DepthCampaign, depth: SearchDepth): Promise<string | null> {
  if (depth === "quick") return null;
  const waiting = campaign.channelId !== null && (await awaitingStart(tx, campaign));
  const inForce = await documentInForce(tx, campaign, waiting ? "draft" : "active");
  return inForce === null || inForce === "unreadable"
    ? null
    : researchOffNote(depth, inForce.document, inForce.actions);
}

/** `readSearchDepth` by id: Standard for a campaign that no longer stands,
 *  which reads nothing. */
export async function currentSearchDepth(tx: Tx, campaignId: number): Promise<SearchDepth> {
  const campaign = await depthCampaign(tx, campaignId);
  return campaign ? readSearchDepth(tx, campaign) : "standard";
}

async function depthCampaign(tx: Tx, campaignId: number): Promise<DepthCampaign | undefined> {
  const [campaign] = await tx
    .select({
      id: campaigns.id,
      status: campaigns.status,
      channelId: campaigns.channelId,
      searchDepth: campaigns.searchDepth,
      verifyStage: campaigns.verifyStage,
    })
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), isNull(campaigns.deletedAt)));
  return campaign;
}

/**
 * Whether the campaign's Deep read is on now: its version in force. One
 * waiting for its Start reads its
 * newest draft as the Start would project it — false for a draft the contract
 * no longer reads, which starts nothing — and the column where there is no
 * draft, or no channel, to read.
 */
async function deepRead(tx: Tx, campaign: DepthCampaign): Promise<boolean> {
  const waiting = campaign.channelId !== null && (await awaitingStart(tx, campaign));
  const inForce = await documentInForce(tx, campaign, waiting ? "draft" : "active");
  if (inForce === null) return waiting && campaign.verifyStage;
  return inForce !== "unreadable" && readsDeep(inForce.document, inForce.actions);
}

/** The newest version of the campaign in `status`, parsed and resolved as
 *  activation projects it; null where there is none, or no channel, and
 *  `unreadable` where the contract no longer reads it. */
async function documentInForce(
  tx: Tx,
  campaign: DepthCampaign,
  status: "draft" | "active",
): Promise<{ document: CampaignAgentStrategy; actions: ResolvedAction[] } | "unreadable" | null> {
  if (campaign.channelId === null) return null;
  const [channel] = await tx
    .select({ network: channels.network })
    .from(channels)
    .where(eq(channels.id, campaign.channelId));
  const [row] = await tx
    .select({ document: campaignStrategies.document })
    .from(campaignStrategies)
    .where(and(eq(campaignStrategies.campaignId, campaign.id), eq(campaignStrategies.status, status)))
    .orderBy(desc(campaignStrategies.version))
    .limit(1);
  if (!channel || !row) return null;
  const network = NETWORK_CATALOGS[channel.network];
  const parsed = parseStrategy(row.document, { network });
  if (!parsed.success) return "unreadable";
  const accountDefault = await readAccountDefault(tx, campaign.channelId, { network });
  return {
    document: parsed.data,
    actions: resolvedAsProjected(parsed.data, {
      accountDefault: accountDefault?.document ?? null,
      network,
      liveChecks: await recordedLiveChecks(tx, campaign.channelId),
    }),
  };
}

/** Who a change was made by, for `campaign_depth_set`: a call over MCP signs
 *  itself `mcp:<key>` (`mcpOperationActor`) and is the owner's agent; every
 *  other approver is the owner's own press or yes. */
export function depthActor(approver: string | null): "owner" | "agent" {
  return approver?.startsWith("mcp:") ? "agent" : "owner";
}

/**
 * What a landed change did to the campaign's search depth, settled in its
 * transaction: a Deep it now reads clears a stored Quick to Standard — a
 * version in force had it cleared by its projection already, so this is a
 * draft's — and a depth that moved is told as `campaign_depth_set` once the
 * change commits. `from` is the depth it read before, or the one its create
 * already told. Returns the depth it reads now.
 */
export async function settleSearchDepth(
  tx: Tx,
  campaignId: number,
  from: SearchDepth,
  by: "owner" | "agent",
): Promise<SearchDepth> {
  const campaign = await depthCampaign(tx, campaignId);
  if (!campaign) return from;
  const depth = await readSearchDepth(tx, campaign);
  if (depth === "deep" && campaign.searchDepth === "quick") {
    await tx.update(campaigns).set({ searchDepth: "standard" }).where(eq(campaigns.id, campaignId));
  }
  if (depth !== from) {
    afterCommit(tx, () => track("campaign_depth_set", { depth, source: "change", by }));
  }
  return depth;
}
