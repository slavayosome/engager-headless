import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { boundaryModelScopeFor } from "../ai/modelFor";
import { withUsageContext } from "../ai/usage";
import type { McpCtx } from "./context";

/**
 * Attribute every tool's AI spend to this org. Wrap each registered handler once
 * (source "mcp", stage = tool name) instead of per-tool: withUsageContext buffers
 * usage events and flushes them AFTER the tool's withOrg tx closes, so it stays
 * phase-2/pool-safe (no second connection inside the tx). Without this, MCP calls
 * fall through recordUsage's no-context path and persist with a null org. The
 * same wrap resolves the (agent, model-per-role) every call underneath reads.
 * Call it before any tool is registered: it covers the tools registered after.
 */
export function attributeUsage(server: McpServer, ctx: McpCtx): void {
  const baseRegister = server.registerTool.bind(server) as (
    name: string,
    config: unknown,
    handler: (...args: unknown[]) => unknown,
  ) => unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).registerTool = (
    name: string,
    config: unknown,
    handler: (...args: unknown[]) => unknown,
  ) => {
    return baseRegister(name, config, async (...args: unknown[]) =>
      withUsageContext(
        {
          organizationId: ctx.organizationId,
          credentialKeyId: null,
          requestId: ctx.requestId,
          budgetTool: name,
          source: "mcp",
          stage: name,
          ...(await boundaryModelScopeFor(ctx.organizationId)),
        },
        () => Promise.resolve(handler(...args)),
      ),
    );
  };
}
