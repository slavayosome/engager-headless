import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AppError } from "@engager/common/errors";
import { withOrg, type Tx } from "@engager/database/tenant";
import type { McpCtx } from "../mcp/context";
import {
  CAMPAIGN_FACTS,
  campaignFactsPatchSchema,
  readCampaignFactsBase,
  type CampaignFactsChange,
  type CampaignFactsPatch,
} from "../operations/campaignFacts";
import { proposalResult, recordProposal, refusalResult, type ProposalContext } from "./proposals";

/**
 * WHAT A CAMPAIGN IS FOR, CHANGED FROM CHAT — its name, its goal, its
 * audience. Chat reads third-party text, so it gets no setter for them: its
 * one tool draws a card (`campaign_facts.update`, `proposalKinds.ts`) that
 * waits for the owner's yes on the campaign's Strategy, where the goal and
 * the audience change, and in the conversation. What the three fields say now
 * is the card's `before`, read by the server, so Strategy can say which of
 * them moved before the owner answers, and a yes in chat after one moved is
 * refused.
 *
 * Chat's own, mounted only where there is a conversation to propose into
 * (`tools.ts`). The owner's own agent over MCP keeps `save_campaign`, which
 * writes these directly as the owner's word.
 */

export const PROPOSE_CAMPAIGN_FACTS = "propose_campaign_facts";

/** A call that names none of the three fields. */
export class NoCampaignFactError extends AppError {
  readonly recovery = "Nothing was proposed. Send the name, objective or audience the owner asked for.";

  constructor() {
    super("invalid_proposal", "a change to what a campaign is for names its name, objective or audience", 400);
  }
}

/** A campaign this organization does not hold, or no longer does. */
export class UnknownCampaignError extends AppError {
  readonly recovery =
    "Nothing was proposed. Read the campaigns with list_campaigns and use one of their ids.";

  constructor(campaignId: number) {
    super("campaign_not_found", `campaign ${campaignId} not found`, 404);
  }
}

/** The change `patch` makes to one campaign this organization holds. */
async function campaignFactsChange(
  tx: Tx,
  campaignId: number,
  patch: CampaignFactsPatch,
): Promise<CampaignFactsChange> {
  if (Object.keys(patch).length === 0) throw new NoCampaignFactError();
  if (!(await readCampaignFactsBase(tx, campaignId))) throw new UnknownCampaignError(campaignId);
  return { kind: CAMPAIGN_FACTS, campaignId, patch };
}

export function registerCampaignFactsTool(server: McpServer, ctx: McpCtx, chat: ProposalContext): void {
  server.registerTool(
    PROPOSE_CAMPAIGN_FACTS,
    {
      title: "Propose a new name, goal or audience for a campaign",
      description:
        "Propose a campaign's new name, goal (`objective`) or audience as a card; it writes nothing. Send only what changes.",
      inputSchema: { campaignId: z.number().int().positive(), ...campaignFactsPatchSchema.shape },
    },
    async ({ campaignId, ...patch }) => {
      try {
        return await withOrg(ctx.organizationId, async (tx) =>
          proposalResult(
            await recordProposal(tx, ctx.organizationId, await campaignFactsChange(tx, campaignId, patch), chat),
          ),
        );
      } catch (error) {
        return refusalResult(error);
      }
    },
  );
}
