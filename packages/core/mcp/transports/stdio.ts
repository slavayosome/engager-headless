import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

/**
 * Local transport: the MCP client (e.g. Claude Desktop / Claude Code) launches
 * `npm run mcp` and speaks JSON-RPC over stdio. No network, no token — trust is
 * the local process boundary.
 */
export async function startStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logs (stdout is the JSON-RPC channel).
  // eslint-disable-next-line no-console
  console.error("[mcp] engager server ready on stdio");
}
