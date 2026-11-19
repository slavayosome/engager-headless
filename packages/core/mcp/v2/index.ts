import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpCtx } from "../context";
import { statusTools } from "./status/status";
import { catalogTools } from "./campaigns/catalog";
import { campaignCrudTools } from "./campaigns/crud";
import { runTools } from "./campaigns/run";
import { peopleTools } from "./people/people";
import { decisionTools } from "./activity/decisions";
import { draftTools } from "./writing/drafts";
import { channelTools } from "./channel/channel";
import { voiceBrainTools } from "./knowledge/voiceBrain";
import { taskTools } from "./tasks/tasks";
import { strategyTools } from "./campaigns/strategy";
import { productTools } from "./products/products";
import { pressTools } from "./writing/press";
import { activityListTools } from "./activity/list";
import { registerV2Tool, type V2Tool } from "./define";
import { skillTools } from "./skills";

/** Each story owns one module; parallel waves leave this index alone.
 * MCP-02: status/status.ts
 * MCP-03: campaigns/catalog.ts
 * MCP-04: campaigns/crud.ts
 * MCP-05: campaigns/run.ts
 * MCP-06: people/people.ts
 * MCP-07: activity/decisions.ts
 * MCP-08: writing/drafts.ts
 * MCP-09: channel/channel.ts
 * MCP-10: knowledge/voiceBrain.ts
 * MCP-11: tasks/tasks.ts
 * MCP-14: campaigns/strategy.ts
 * MCP-15: products/products.ts
 * MCP-16: writing/press.ts
 * MCP-18: activity/list.ts
 */
export const V2_TOOLS: readonly V2Tool[] = [
  ...statusTools,
  ...catalogTools,
  ...campaignCrudTools,
  ...runTools,
  ...peopleTools,
  ...decisionTools,
  ...draftTools,
  ...channelTools,
  ...voiceBrainTools,
  ...taskTools,
  ...strategyTools,
  ...productTools,
  ...pressTools,
  ...activityListTools,
  ...skillTools,
];

/** Register the v2 surface on `server`, after its `registerTool` carries the
 *  usage wrapper so every handler is attributed. `tools` is a seam for a test
 *  that registers a bad tool and expects the build to throw. */
export function registerV2Tools(
  server: McpServer,
  ctx: McpCtx,
  tools: readonly V2Tool[] = V2_TOOLS,
): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) throw new Error(`v2 tool "${tool.name}": registered twice`);
    seen.add(tool.name);
    registerV2Tool(server, ctx, tool);
  }
}
