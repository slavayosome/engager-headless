import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpCtx } from "../mcp/context";
import { attributeUsage } from "../mcp/attributeUsage";
import { registerV2Tools, V2_TOOLS } from "../mcp/v2";
import { assertHostedMcpExternalPhase } from "../mcp/tools/hostedSpend";
import { errorResult } from "../mcp/tools/util";
import { withExternalJudgment } from "../tasks/judgment";
import { PROPOSE_SEARCHES_FROM_POST, registerLookalikeProposalTool } from "./lookalikeProposal";
import { CHAT_STRATEGY_WRITERS, registerChatStrategyTools } from "./campaignStrategy";
import { PROPOSE_CAMPAIGN_FACTS, registerCampaignFactsTool } from "./campaignFacts";
import { PROPOSE_AUDIENCE_PROFILE, registerAudienceProfileTool } from "./audienceProfile";
import { PROPOSE_CAMPAIGN_FILL, registerCampaignFillTool, type CampaignFiller } from "./campaignFill";
import { modelSchema } from "../mcp/v2/advertisedSchema";
import { DRAFT_COMMENT, DRAFT_IN_BOX, DRAFT_MESSAGE, registerDraftCommentTool, registerDraftInBoxTool, registerDraftMessageTool, type BoxDrafter, type CommentDrafter, type MessageDrafter } from "./draftCommentTool";
import { RESEARCH_WEB, registerWebResearchTool, type WebResearcher } from "./webResearch";
import { PROPOSE_CHANGE, registerProposalTools, withChatProposalOrigin, type ProposalContext } from "./proposals";

export const DENIED_TOOLS: ReadonlySet<string> = new Set(["import_data", "list_skills", "get_skill_file"]);
export const READ_TOOLS = new Set(V2_TOOLS.filter(tool => tool.kind === "read" && !DENIED_TOOLS.has(tool.name)).map(tool => tool.name));
export const WRITE_TOOLS = new Set([
  ...V2_TOOLS.filter(tool => tool.kind !== "read" && !DENIED_TOOLS.has(tool.name)).map(tool => tool.name),
  PROPOSE_CHANGE, PROPOSE_CAMPAIGN_FACTS, PROPOSE_AUDIENCE_PROFILE,
  PROPOSE_SEARCHES_FROM_POST, ...CHAT_STRATEGY_WRITERS,
]);

/** The tools that plan, write and judge words through the owner's agent:
 *  several model calls in a row, so they get most of the turn's five minutes
 *  rather than the client's one. */
const DRAFTING: ReadonlySet<string> = new Set([DRAFT_COMMENT, DRAFT_MESSAGE, DRAFT_IN_BOX, PROPOSE_CAMPAIGN_FILL, RESEARCH_WEB]);
const DRAFT_TIMEOUT_MS = 240_000;

export function brokerScopeFor(name: string, _args: Record<string, unknown>): "feed:read" | "messages:write" {
  return READ_TOOLS.has(name) && !(name === "get_channel" && (_args.probe === true || (Array.isArray(_args.include) && _args.include.includes("own_posts")))) ? "feed:read" : "messages:write";
}

export const MAX_READ_RESULT_BYTES = 128 * 1024;

/** And the most every read TOGETHER may put into one turn. A per-call cap is
 *  no budget: three reads at the cap and the turn is at 384 KiB, eight and it
 *  passes the 1 MiB history ceiling and dies `broker_context_full` — a failure
 *  the owner sees as the conversation ending, with nothing said about why.
 *  Three full-size reads is already more than any page needs, so the budget is
 *  set there and the read that would cross it is told to narrow instead. */
export const MAX_TURN_READ_BYTES = 3 * MAX_READ_RESULT_BYTES;

/** The registry's descriptions end by naming the skill that holds a tool's
 *  playbook. Chat cannot open a skill (`DENIED_TOOLS`), so there the name is
 *  weight on every step and nothing else. */
const SKILL_POINTER = / See engager-[\w-]+[^.]*\./g;

export async function openBrokerTools(ctx: McpCtx, chat?: ProposalContext, drafters: { comment?: CommentDrafter; message?: MessageDrafter; box?: BoxDrafter; fill?: CampaignFiller; web?: WebResearcher } = {}) {
  const server = new McpServer({ name: "engager-broker", version: "1" });
  attributeUsage(server, ctx);
  registerV2Tools(server, ctx, V2_TOOLS.filter((tool) => !DENIED_TOOLS.has(tool.name)));
  if (drafters.comment) registerDraftCommentTool(server, ctx, drafters.comment);
  if (drafters.message) registerDraftMessageTool(server, ctx, drafters.message);
  if (drafters.box) registerDraftInBoxTool(server, ctx, drafters.box);
  if (drafters.fill) registerCampaignFillTool(server, ctx, drafters.fill);
  if (drafters.web) registerWebResearchTool(server, ctx, drafters.web);
  // And the proposal, only where there is a conversation to propose INTO. A
  // pending change is scoped to the session that made it and is inert
  // anywhere else, so a caller with no session has nothing to write — opening
  // the tool for one would be offering a card that could never be answered.
  if (chat) {
    registerProposalTools(server, ctx, chat);
    registerCampaignFactsTool(server, ctx, chat);
    registerAudienceProfileTool(server, ctx, chat);
    registerLookalikeProposalTool(server, ctx, chat);
    registerChatStrategyTools(server, ctx, chat);
  }
  const client = new Client({ name: "engager-broker", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  /** What every READ of this turn has already put into history. The broker
   *  opens one of these per turn, so the counter's life is the turn's. */
  let spentBytes = 0;
  const listed = (await client.listTools()).tools.filter((tool) => !DENIED_TOOLS.has(tool.name));
  /** Gate one call before dispatch. */
  const validate = async (
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> => {
    const tool = listed.find((tool) => tool.name === name);
    if (!tool) throw new Error("broker_tool_denied");
    if (
      Object.keys(args).some(
        (key) => !Object.hasOwn(tool.inputSchema.properties ?? {}, key),
      )
    )
      throw new Error("broker_arguments_invalid");
    await assertHostedMcpExternalPhase(
      ctx,
      signal,
      brokerScopeFor(name, args),
    );
    if (name === "act" && args.kind === "reply" && typeof args.ref === "string" && args.ref.startsWith("member:"))
      throw new Error("owner_surface_required");
    return args;
  };
  return {
    definitions: listed.map(({ name, description, inputSchema }) => ({
      name,
      description: description?.replace(SKILL_POINTER, ""),
      inputSchema: modelSchema(inputSchema),
    })),
    validate,
    async call(
      name: string,
      args: Record<string, unknown>,
      signal: AbortSignal,
    ) {
      const dispatched = await validate(name, args, signal);
      const result = (
        await withChatProposalOrigin(chat, () => withExternalJudgment(() =>
          client.callTool({ name, arguments: dispatched }, undefined, {
            signal,
            ...(name === PROPOSE_SEARCHES_FROM_POST ? { timeout: 110_000 } : DRAFTING.has(name) ? { timeout: DRAFT_TIMEOUT_MS } : {}),
          }),
        ))
      ).result;
      if (brokerScopeFor(name, args) === "messages:write") return result;
      // A read that came back too big is answered, not thrown: the model is
      // told to narrow it and the turn carries on, where a thrown failure
      // would end a conversation over a page size. A WRITE result is a receipt
      // the owner is owed whatever its size, so both caps are the read lane's.
      const bytes = Buffer.byteLength(JSON.stringify(result));
      const owed = name === "get_status" || name === "get_campaign";
      if (
        bytes > MAX_READ_RESULT_BYTES ||
        (!owed && spentBytes + bytes > MAX_TURN_READ_BYTES)
      ) {
        return errorResult(
          `${name} returned more than this chat turn can carry`,
          {
            code: "broker_result_too_large",
            status: 413,
            recovery:
              "Ask for less and try again: a smaller `limit`, a `status` or `campaignId` filter, a shorter `windowHours`, or one id instead of a list.",
          },
        );
      }
      spentBytes += bytes;
      return result;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}
