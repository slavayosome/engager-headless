import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { handleSkillHttpRequest } from "../../skills/httpRoute";
import { checkBearer, mcpToken } from "../auth";

const PATH = "/mcp";

/** This listener's own origin, so the installer downloads from the server that
 *  generated its manifest. Mirrors mcpPublicOrigin() in apps/mcp. */
function requestOrigin(req: IncomingMessage): string {
  const host = req.headers.host ?? "127.0.0.1";
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto =
    (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)
      ?.split(",")[0]
      ?.trim() || "http";
  return `${proto}://${host}`;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(json);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 4_000_000) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Remote transport: a small HTTP server exposing `POST /mcp` (MCP streamable
 * HTTP, stateless + JSON responses) behind a bearer token, so remote clients
 * (Claude, Codex, OpenClaw, and other bearer-token clients) can drive Engager.
 * ChatGPT connectors require OAuth and are not supported by this transport yet.
 * Each request gets a fresh server + transport (no shared session state). Binds
 * to localhost by default; REQUIRES ENGAGER_MCP_TOKEN — without it the server
 * refuses to start.
 *
 * ONE ORG, one context, however many requests. `checkBearer` gates on a single
 * shared ENGAGER_MCP_TOKEN and derives NOTHING per request — no org, no scopes,
 * no credential — because this fork is local-first and the multi-tenant server
 * that would have needed a bearer → org lookup was deleted with the hosted
 * surface. So `main()` builds one context from ENGAGER_ORG_ID and hands the
 * same one to every request; the freshness that matters is the connector's, and
 * `ctx.grant` re-reads the account's row per call.
 */
export async function startHttp(factory: () => McpServer): Promise<void> {
  if (!mcpToken()) {
    throw new Error(
      "ENGAGER_MCP_TOKEN is not set — refusing to start the HTTP MCP transport (it gates posting to a real LinkedIn account).",
    );
  }
  const port = Number(process.env.ENGAGER_MCP_HTTP_PORT ?? 8788);
  const host = process.env.ENGAGER_MCP_HTTP_HOST ?? "127.0.0.1";

  const httpServer = createServer((req, res) => {
    void handle(req, res, factory);
  });

  await new Promise<void>((resolve) => httpServer.listen(port, host, resolve));
  // eslint-disable-next-line no-console
  console.error(`[mcp] engager server ready on http://${host}:${port}${PATH} (bearer-token)`);
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  factory: () => McpServer,
): Promise<void> {
  const url = req.url ?? "";

  if (req.method === "GET" && (url === "/" || url === "/health")) {
    return send(res, 200, { ok: true, service: "engager-mcp" });
  }
  // Skill distribution: unauthenticated, served from this release's own disk.
  // See packages/core/skills/httpRoute.ts for why it must not come from the
  // dashboard's separately deployed copy.
  if (req.method === "GET" || req.method === "HEAD") {
    const skills = handleSkillHttpRequest({
      method: req.method,
      url,
      origin: requestOrigin(req),
      ifNoneMatch: req.headers["if-none-match"],
    });
    if (skills) {
      res.writeHead(skills.status, skills.headers);
      return void res.end(req.method === "HEAD" ? undefined : skills.body);
    }
  }
  if (!url.startsWith(PATH)) return send(res, 404, { error: "not found" });

  if (!checkBearer(req.headers.authorization)) {
    res.setHeader("www-authenticate", "Bearer");
    return send(res, 401, { error: "unauthorized" });
  }

  // Stateless mode: GET/DELETE for SSE sessions are not used.
  if (req.method !== "POST") {
    return send(res, 405, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method Not Allowed (stateless: use POST)" },
      id: null,
    });
  }

  let body: unknown;
  try {
    body = await readBody(req);
  } catch (e) {
    return send(res, 400, { error: e instanceof Error ? e.message : "bad request" });
  }

  let server: McpServer;
  try {
    server = factory();
  } catch (e) {
    if (e instanceof Error && e.message === "interactive_credential_required") {
      return send(res, 403, { error: "interactive_credential_required" });
    }
    throw e;
  }
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    if (!res.headersSent) {
      send(res, 500, {
        jsonrpc: "2.0",
        error: { code: -32603, message: e instanceof Error ? e.message : "internal error" },
        id: null,
      });
    }
  }
}
