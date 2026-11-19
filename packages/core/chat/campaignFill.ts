import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpCtx } from "../mcp/context";
import { campaignFillInputSchema, type CampaignFill } from "../campaigns/fill";
import { errorResult, jsonResult } from "../mcp/tools/util";

export const PROPOSE_CAMPAIGN_FILL = "propose_campaign_fill";

/** Fills in the rest of an unsaved campaign through the chat agent. */
export type CampaignFiller = (input: unknown, signal: AbortSignal) => Promise<CampaignFill>;

/**
 * FILL IN THE REST, FROM CHAT — the judgment New campaign's button runs
 * (`proposeCampaignFill`), through this turn's own agent. It returns the
 * values and writes nothing: no campaign is created or started, and it has
 * no way to switch a step on, set a mode or change a starting point. The
 * owner takes them on New campaign, whose Create and start saves them.
 */
export function registerCampaignFillTool(server: McpServer, _ctx: McpCtx, fill: CampaignFiller) {
  server.registerTool(PROPOSE_CAMPAIGN_FILL, {
    title: "Fill in the rest of a new campaign",
    description: "For a campaign the owner is setting up and has not created: send who they want to meet, the steps switched on, what they set, and name each field they set in `kept` (step instructions in `keptInstructions`). Returns proposed values for the other fields only; nothing is saved, created or started. Tell the owner the values; they take them on New campaign and press Create and start.",
    inputSchema: campaignFillInputSchema.shape,
  }, async (input, extra) => {
    try {
      return jsonResult({ fill: await fill(input, extra.signal), saved: false });
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error), { code: "fill_failed", status: 409 });
    }
  });
}
