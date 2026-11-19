import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { and, eq } from "drizzle-orm";
import { db } from "@engager/database";
import {
  channels,
  jobs,
  organizations,
  type ApiKeyScope,
  type Job,
} from "@engager/database/schema";
import { withOrg } from "@engager/database/tenant";
import { connectorBindingForDriverName } from "../connector/binding";
import type { CapabilityKind, LinkedInDriver } from "../connector/capabilities";
import { MockDriver } from "../linkedin/mock";
import type { Refusal } from "../refusal";
import { beatRuntimeHeartbeat } from "../tasks/liveness";
import { FakeLLM } from "./fakes";
import type { McpCtx } from "../mcp/context";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { attributeUsage } from "../mcp/attributeUsage";
import { createMcpServer } from "../mcp/server";
import { registerV2Tools } from "../mcp/v2";

/** The kinds this connector refuses, and what each one answers. A kind that is
 *  absent is granted — the map states the exceptions, never the whole surface,
 *  so a test naming one refusal does not have to enumerate the other ten. */
export type InjectedRefusals = Partial<Record<CapabilityKind, Refusal>>;

/**
 * The one place a test names a connector.
 *
 * A context carries a grant and nothing else, so this is the whole seam: the
 * driver it is given is what every granted capability hands back, and no tool
 * can read around it to a connector this file did not name.
 *
 * TOTAL unless the test says otherwise: it never consults
 * `CONNECTOR_DECLARATIONS`. The injected driver IS this test's connector, and
 * gating on the fixture's declaration would refuse kinds the mock deliberately
 * answers — `own_content` is declared false because a mock is "no real
 * account", while the suites that inject one for voice import expect it to
 * reply.
 *
 * The binding it grants is the one this driver's NAME stands for, which is what
 * `probeLinkedInSession` stamps on the channel row — the mock's `null` included,
 * since a fixture proves nothing about how the account is reached.
 *
 * `refusals` is how a test refuses a kind anyway, by name. Every migrated site
 * owes a case proving that a refused grant produces exactly the silent outcome
 * the site produced before, and a grant that can only say yes leaves that half
 * of every site unreachable.
 */
export function injectedConnector(
  driver: LinkedInDriver,
  refusals: InjectedRefusals = {},
): Pick<McpCtx, "grant"> {
  // The binding this fixture stands for — null for the mock, which reaches no
  // real account and must never stamp the channel row.
  const connector = connectorBindingForDriverName(driver.name);
  return {
    // Any refused kind refuses the whole ask, exactly as the resolver does: a
    // caller named the set it needs, so a partial answer is not one.
    grant: async (...kinds) => {
      for (const kind of kinds) {
        const refusal = refusals[kind];
        if (refusal) return refusal;
      }
      return { ok: true, use: driver, connector };
    },
  };
}

/** Connect an in-memory MCP client to a server built from `ctx`. */
export async function connect(ctx: McpCtx): Promise<Client> {
  const server = createMcpServer(ctx);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

/** Connect an in-memory MCP client to a server that carries only the v2
 *  registry, under the same usage attribution `createMcpServer` applies. */
export async function connectV2(ctx: McpCtx): Promise<Client> {
  const server = new McpServer({ name: "engager-v2", version: "0" });
  attributeUsage(server, ctx);
  registerV2Tools(server, ctx);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

/** Call one v2 tool by name and return its raw result. */
export async function v2call(
  ctx: McpCtx,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  const client = await connectV2(ctx);
  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await client.close();
  }
}

/** Parse a tool result's first text block as JSON. */
export function parse(res: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const content = (res as CallToolResult).content;
  const first = content[0];
  if (!first || first.type !== "text") throw new Error("no text content");
  return JSON.parse(first.text);
}

/** Create the product required by the public Product-campaign contract. */
export async function createProductId(
  client: Client,
  name = `test-product-${randomUUID()}`,
): Promise<number> {
  const result = parse(
    await client.callTool({ name: "save_product", arguments: { name } }),
  );
  const productId = result.productId;
  if (typeof productId !== "number") {
    throw new Error(`save_product returned no productId: ${JSON.stringify(result)}`);
  }
  return productId;
}

/**
 * Say that a background agent PROCESS is alive for this org.
 *
 * `agentHealthy` needs two facts and a test context only supplies one: a
 * `FakeLLM` says the org has something to think with, and this says there is a
 * worker to think ON. Without it every tool routes to the in-session fallback,
 * which is correct behaviour and the wrong fixture for a suite asking what the
 * QUEUE does.
 */
export async function beatAgent(
  orgId: string,
  at: number = Date.now(),
): Promise<void> {
  await withOrg(orgId, (tx) => beatRuntimeHeartbeat(tx, "test-runtime", at));
}

export type TestCtx = { ctx: McpCtx; llm: FakeLLM; orgId: string };

/** Create a fresh committed org + an MCP context bound to it (FakeLLM/MockDriver).
 *  `refusals` names the capabilities this org's connector cannot perform. */
export async function freshCtx(
  opts: {
    driver?: MockDriver;
    refusals?: InjectedRefusals;
    scopes?: ApiKeyScope[];
    /** Default true: an org with a configured agent and a worker behind it,
     *  which is what every suite written before the in-session fallback meant
     *  by "a context". Pass false to get the free install's own routing. */
    agentAlive?: boolean;
  } = {},
): Promise<TestCtx> {
  const [o] = await db
    .insert(organizations)
    .values({ slug: `mcp-${randomUUID()}`, name: "m" })
    .returning();
  // Every real org has a channel row (migration seed / bootstrapLocalOrg), and
  // the account's ceilings live on it — an org without one reads back as having
  // no safety settings at all.
  await withOrg(o!.id, (tx) =>
    tx.insert(channels).values({ organizationId: o!.id, writesEnabled: true }),
  );
  const llm = new FakeLLM();
  const ctx: McpCtx = {
    organizationId: o!.id,
    ...injectedConnector(opts.driver ?? new MockDriver(), opts.refusals),
    llm,
  };
  if (opts.agentAlive !== false) await beatAgent(o!.id);
  return { ctx, llm, orgId: o!.id };
}

/** Jobs of a given type for an org (the jobs table is not RLS-scoped → filter by org). */
export async function jobsOfType(
  orgId: string,
  type: Job["type"],
): Promise<{ id: number; payload: unknown }[]> {
  return db
    .select({ id: jobs.id, payload: jobs.payload })
    .from(jobs)
    .where(and(eq(jobs.organizationId, orgId), eq(jobs.type, type)));
}
