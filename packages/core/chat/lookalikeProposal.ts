import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AppError } from "@engager/common/errors";
import { LOOKALIKE_READ_FAILED } from "../discovery/lookalike";
import type { McpCtx } from "../mcp/context";
import { hostedMcpAccessErrorResult, withHostedMcpScope } from "../mcp/tools/hostedSpend";
import { PROPOSE_SEARCHES_FROM_POST, requestAndWaitLookalike } from "../mcp/tools/lookalike";
import { jsonResult } from "../mcp/tools/util";
import { proposalResult, recordProposal, refusalResult, type ProposalContext } from "./proposals";

export { PROPOSE_SEARCHES_FROM_POST };

/** Chat can request a read and draw a card. Only its owner's selected
 * checkbox indices reach the canonical Add operation through the card. */
export function registerLookalikeProposalTool(server: McpServer, ctx: McpCtx, chat: ProposalContext) {
  server.registerTool(PROPOSE_SEARCHES_FROM_POST, {
    title: "Suggest searches from a post",
    description: "For a post the owner shares whose comments hold their audience: read its room and show a card of search suggestions. One post read; nothing is added until the owner adds them. Repeat the call to fetch a saved result.",
    inputSchema: { campaignId: z.number().int().positive(), url: z.string().min(1).max(3000) },
  }, async (input, extra) => {
    try {
      const row = await requestAndWaitLookalike(ctx, extra.signal, input);
      if (row.status === "reading") return jsonResult({ status: "reading", lookalikeId: row.id,
        message: "Still reading this room. No searches have been added. Ask for this same post again to check the saved result." });
      if (row.status === "failed") throw new AppError(row.failure ?? "read_failed", LOOKALIKE_READ_FAILED +
        (row.refusalReason ? ` ${row.refusalReason.replaceAll("_", " ")}.` : ""), 409);
      if (row.stale || !row.proposals.some((proposal) => proposal.state === "open")) throw new AppError("no_search_suggestions",
        row.stale ? "This result no longer matches the current Audience or account. Read the room again." :
          `No open searches were suggested from this sample: ${row.fits} of ${row.judged} reviewed people fit. Nothing was added.`, 409);
      const change = { kind: "searches.from_post", campaignId: input.campaignId, lookalikeId: row.id } as const;
      return await withHostedMcpScope(ctx, extra.signal, "messages:write", async (tx) => proposalResult(await recordProposal(tx,
        ctx.organizationId, change, chat)));
    } catch (error) { return hostedMcpAccessErrorResult(error) ?? refusalResult(error); }
  });
}
