import { and, desc, eq } from "drizzle-orm";
import {
  campaignStrategies,
  campaigns,
  channels,
  type Campaign,
  type CampaignStrategyRow,
  type StrategyProvenance,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { CONNECTOR_DECLARATIONS } from "../connector/capabilities";
import { recordedLiveChecks } from "../liveChecks/records";
import type { NetworkId } from "../network/registry";
import { NETWORK_CATALOGS, NO_LIVE_CHECKS } from "./catalog";
import {
  strategyIssueCode,
  parseStrategy,
  type CampaignAgentStrategy,
  type StrategyIssueCode,
} from "./contract";
import { resolveStrategy, type ResolvedAction } from "./resolve";
import { liveModes } from "./mode";
import { currentDocument } from "./upgrade";

/**
 * A campaign's strategy as the agent and the dashboard read it: the stored
 * version, the account default it inherits from, and every bound action's
 * effective mode with where it came from.
 *
 * A READ SURFACE, not a runtime path. Nothing that decides what a worker does
 * calls this: on a campaign that runs on its strategy the runtime reads the
 * columns activation projected (`project.ts`), and this resolves against the
 * channel's real connector to say why an action is what it is.
 */
export type CampaignStrategyView = {
  campaignId: number;
  channelId: number | null;
  network: NetworkId | null;
  strategy: {
    version: number;
    status: CampaignStrategyRow["status"];
    baseVersion: number | null;
    effectiveAt: number;
    provenance: StrategyProvenance;
    /** As the current schema, whichever schema the version was stored in
     *  (`upgrade.ts`). */
    document: Record<string, unknown>;
  };
  accountDefault: { version: number; document: Record<string, unknown> } | null;
  /** Empty when the campaign has no channel to resolve against, or when the
   *  stored document no longer satisfies the contract (`issues` says why). */
  actions: ResolvedAction[];
  issues: Array<{
    path: string;
    code: StrategyIssueCode | null;
    message: string;
  }>;
};

/**
 * Whether a campaign has a version in force. One created on its strategy
 * has none until its Start campaign — and a campaign that has started always
 * has one, because only a newer version ever replaces it.
 */
export async function strategyInForce(tx: Tx, campaignId: number): Promise<boolean> {
  const [row] = await tx
    .select({ id: campaignStrategies.id })
    .from(campaignStrategies)
    .where(and(eq(campaignStrategies.campaignId, campaignId), eq(campaignStrategies.status, "active")))
    .limit(1);
  return row !== undefined;
}

/**
 * Whether a campaign waits for its Start: Paused since it was created, with
 * no version in force. The one state a test before Start may read
 * (`runCampaignTestOp`); an archived campaign is not waiting for anything.
 */
export async function awaitingStart(
  tx: Tx,
  campaign: Pick<Campaign, "id" | "status">,
): Promise<boolean> {
  return campaign.status === "paused" && !(await strategyInForce(tx, campaign.id));
}

/**
 * The one owner press that may work a Paused campaign, and the campaign it is
 * for: a test before Start (`runCampaignTestOp`), or Run once on a campaign
 * paused after it started. Server-derived inside the run handler from the
 * run's own payload and trigger, never from wire input.
 */
export type PausedPress = { kind: "test" | "once"; campaignId: number };

/**
 * Whether `press` may work `campaign` though it is not Active: only the
 * campaign the press is for, and only in the state its kind names — a test on
 * one waiting for its Start, Run once on one paused after it started.
 */
export async function pausedPressAllowed(
  tx: Tx,
  campaign: Pick<Campaign, "id" | "status">,
  press: PausedPress | undefined,
): Promise<boolean> {
  if (!press || press.campaignId !== campaign.id) return false;
  if (press.kind === "test") return awaitingStart(tx, campaign);
  return campaign.status === "paused" && (await strategyInForce(tx, campaign.id));
}

/**
 * Read one campaign's strategy: the requested version, else the active one,
 * else the newest (a channel-less campaign's seed is a draft). Null when the
 * campaign has none yet.
 */
export async function readCampaignStrategy(
  tx: Tx,
  campaignId: number,
  options: { version?: number; now?: number } = {},
): Promise<CampaignStrategyView | null> {
  const [campaign] = await tx
    .select({
      id: campaigns.id,
      channelId: campaigns.channelId,
      network: channels.network,
      connector: channels.connector,
    })
    .from(campaigns)
    .leftJoin(channels, eq(channels.id, campaigns.channelId))
    .where(eq(campaigns.id, campaignId));
  if (!campaign) return null;

  const versions = await tx
    .select()
    .from(campaignStrategies)
    .where(eq(campaignStrategies.campaignId, campaignId))
    .orderBy(desc(campaignStrategies.version));
  const row =
    options.version !== undefined
      ? versions.find((candidate) => candidate.version === options.version)
      : (versions.find((candidate) => candidate.status === "active") ?? versions[0]);
  if (!row) return null;

  const [account] =
    campaign.channelId === null
      ? []
      : await tx
          .select()
          .from(campaignStrategies)
          .where(
            and(
              eq(campaignStrategies.channelId, campaign.channelId),
              eq(campaignStrategies.status, "active"),
            ),
          );

  const network = campaign.network ? NETWORK_CATALOGS[campaign.network] : null;
  const issues: CampaignStrategyView["issues"] = [];
  const parse = (document: Record<string, unknown>, scope: string) => {
    const parsed = parseStrategy(document, { network });
    if (parsed.success) return parsed.data;
    for (const issue of parsed.error.issues) {
      issues.push({
        path: [scope, ...issue.path].join("."),
        code: strategyIssueCode(issue),
        message: issue.message,
      });
    }
    return null;
  };
  const document = parse(row.document, "strategy");
  const accountDocument: CampaignAgentStrategy | null = account
    ? parse(account.document, "accountDefault")
    : null;

  let actions =
    network && campaign.connector && document && (!account || accountDocument)
      ? resolveStrategy({
          accountDefault: accountDocument,
          campaign: document,
          network,
          connector: CONNECTOR_DECLARATIONS[campaign.connector],
          liveChecks: campaign.channelId === null ? NO_LIVE_CHECKS : await recordedLiveChecks(tx, campaign.channelId),
          now: options.now,
        })
      : [];
  if (row.status === "active") {
    actions = await liveModes(tx, campaignId, options.now);
  }

  return {
    campaignId: campaign.id,
    channelId: campaign.channelId,
    network: campaign.network,
    strategy: {
      version: row.version,
      status: row.status,
      baseVersion: row.baseVersion,
      effectiveAt: row.effectiveAt,
      provenance: row.patchProvenance,
      document: currentDocument(row.document),
    },
    accountDefault: account
      ? { version: account.version, document: currentDocument(account.document) }
      : null,
    actions,
    issues,
  };
}

/** A campaign's strategy versions, newest first: number, status, base, when it
 *  took effect and its provenance (the changes and who approved them). The
 *  documents stay out; `readCampaignStrategy` carries the one in force. */
export async function listStrategyVersions(tx: Tx, campaignId: number, limit = 20) {
  return tx
    .select({
      version: campaignStrategies.version,
      status: campaignStrategies.status,
      baseVersion: campaignStrategies.baseVersion,
      effectiveAt: campaignStrategies.effectiveAt,
      createdAt: campaignStrategies.createdAt,
      provenance: campaignStrategies.patchProvenance,
    })
    .from(campaignStrategies)
    .where(eq(campaignStrategies.campaignId, campaignId))
    .orderBy(desc(campaignStrategies.version))
    .limit(limit);
}
