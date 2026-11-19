import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withOrg } from "@engager/database/tenant";
import { AUDIENCE_UPDATE, audienceChangeParts, changedAudience } from "../audience/change";
import { audienceProfile } from "../audience/model";
import { getCampaign } from "../operations/campaigns";
import type { McpCtx } from "../mcp/context";
import { UnknownCampaignError } from "./campaignFacts";
import { proposalResult, recordProposal, refusalResult, type ProposalContext } from "./proposals";

export const PROPOSE_AUDIENCE_PROFILE = "propose_audience_profile";

export function registerAudienceProfileTool(server: McpServer, ctx: McpCtx, chat: ProposalContext) {
  server.registerTool(PROPOSE_AUDIENCE_PROFILE, {
    title: "Propose a change to the campaign's Audience",
    description: "Propose Who, pains or Not them; each supplied part replaces it. Nothing changes until the owner presses Apply.",
    inputSchema: { campaignId: z.number().int().positive(), ...audienceChangeParts },
  }, async ({ campaignId, ...parts }) => {
    try {
      return await withOrg(ctx.organizationId, async (tx) => {
        const campaign = await getCampaign(tx, campaignId);
        if (!campaign) throw new UnknownCampaignError(campaignId);
        const change = { kind: AUDIENCE_UPDATE, campaignId, ...parts } as const;
        const next = changedAudience(audienceProfile(campaign), change);
        // Persist generated pain identities in the payload so a later read of
        // the card and its Apply describe the same new pains.
        return proposalResult(await recordProposal(tx, ctx.organizationId, {
          ...change, ...(parts.pains === undefined ? {} : { pains: next.pains.map(({ id, text, phrases }) => ({ id, text, phrases })) }),
        }, chat));
      });
    } catch (error) { return refusalResult(error); }
  });
}
