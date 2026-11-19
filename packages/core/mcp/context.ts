import { withOrg } from "@engager/database/tenant";
import type { LLM } from "../ai/client";
import type { CapabilityKind } from "../connector/capabilities";
import {
  resolveOrgConnector,
  type ConnectorResolution,
} from "../connector/resolve";

/**
 * The context every MCP tool runs with. It holds the TENANT (organizationId) and
 * the request-scoped deps — but NOT a DB handle. DB-only tools open a short
 * `withOrg(ctx.organizationId, async tx => …)` transaction. Provider-backed
 * tools must use snapshot → external preparation → fenced apply: never carry a
 * transaction across LLM, embedding, connector, or network I/O. Build
 * `{ db: tx, ... }` only for operations proven DB-only.
 *
 * `llm` is intentionally lazy/omitted: the draft tools fall back to getLLM() only
 * when they actually need it, so a management-only session never requires
 * ANTHROPIC_API_KEY.
 */
export type McpCtx = {
  organizationId: string;
  /** Hosted HTTP request attribution. Local stdio may omit it. */
  requestId?: string;
  /**
   * The capabilities this org's account performs, or the reason there is none.
   *
   * A caller names the KINDS it needs and receives only the members those kinds
   * cover, or a typed `Refusal` carrying the rung that said no. SEVERAL at once
   * because a caller often needs several from one connector — the send path
   * comments and then likes the post it commented on — and asking twice hands
   * back two values that nothing can rejoin.
   *
   * Each call resolves the account's channel row inside its OWN `withOrg`
   * transaction, so a reconnected credential or a re-bound connector takes
   * effect on the next call, where the process-wide driver this replaces took
   * effect on the next process. That is also why a caller must not ask from
   * INSIDE a transaction: at `ENGAGER_PG_POOL_MAX=1` the nested acquire never
   * returns. Ask first, then open the transaction with the answer.
   */
  grant: <K extends CapabilityKind>(
    ...kinds: readonly [K, ...K[]]
  ) => Promise<ConnectorResolution<K>>;
  llm?: LLM;
  /** Server-authored by the chat broker, for the turn that carries the
   *  owner's ask on the agent's comment draft waiting on a post (a
   *  `RequestedDraft` with `messageId`): the angles task it prepares
   *  serves that comment, which needs no draft request of its own. Never
   *  from a tool's input, and absent on every other surface. */
  askedDraft?: AskedDraft;
};

/** The owner's ask on a waiting comment, as `McpCtx.askedDraft` carries it. */
export type AskedDraft = {
  campaignId: number;
  discoveredPostId: number;
  messageId: number;
  /** The angle a draft is to be written from; null for angles, or none. */
  angle: string | null;
};

/** Stable operation attribution without trusting any tool input. */
export function mcpOperationActor(_ctx: McpCtx): string {
  return "mcp:local-stdio";
}

/**
 * Build an MCP context for an organization.
 *
 * It resolves NOTHING and touches no database. Which connector reaches this
 * account is `channels.connector`, a row `grant` reads per call inside its own
 * transaction — so it went back to being synchronous the moment the last field
 * that needed a whole driver at build time was deleted, and a server whose
 * database is briefly unreachable binds its transport and reports the fault
 * through the tool that was called instead of exiting before it ever listened.
 */
export function buildMcpCtx(organizationId: string): McpCtx {
  return {
    organizationId,
    grant: grantForOrg(organizationId),
  };
}

/**
 * The capability accessor for one org.
 *
 * Each call opens its OWN transaction, which is safe here and would not be in
 * the job worker: an MCP tool holds no transaction at the ctx layer — the type
 * carries no DB handle and every tool opens its own short `withOrg` — so a
 * grant can never nest inside one and stall a single-connection pool.
 *
 * A DATABASE fault is deliberately NOT caught. The ladder has four rungs and
 * none of them is "the server cannot read its own database", so any refusal
 * minted for one would say something false — `not_connected` to an owner whose
 * account is connected, which is the exact class of lie T-5.3b deleted when it
 * split a decrypt fault from a never-connected org. The error itself is the
 * honest answer, it reaches the caller as the tool's own error, and the next
 * call succeeds once the pool is back.
 */
function grantForOrg(organizationId: string): McpCtx["grant"] {
  return (...kinds) =>
    withOrg(organizationId, (tx) => resolveOrgConnector(tx, kinds));
}

