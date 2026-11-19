import { timingSafeEqual } from "node:crypto";

/** The bearer token required for the HTTP transport, if configured. */
export function mcpToken(): string | undefined {
  return process.env.ENGAGER_MCP_TOKEN || undefined;
}

/**
 * Validate an `Authorization: Bearer <token>` header against ENGAGER_MCP_TOKEN
 * using a constant-time comparison. The HTTP transport REQUIRES a configured
 * token — if none is set, every request is rejected (fail closed), because the
 * connected LinkedIn account is real and posting is gated behind these tools.
 *
 * It gates ACCESS and resolves no tenant: one shared token, one org, taken from
 * ENGAGER_ORG_ID by the server rather than from anything a request carries. The
 * per-org API-key lookup this used to promise belonged to the multi-tenant SaaS
 * that was deleted with the hosted surface, so nothing here is pending —
 * `startHttp`'s own header says the same, and both have to, because a comment
 * promising per-request tenancy is what would make the server's ONE shared
 * context read as an oversight rather than the only thing this transport can
 * honestly build.
 */
export function checkBearer(header: string | undefined): boolean {
  const token = mcpToken();
  if (!token) return false; // no token configured → HTTP transport is closed
  if (!header) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  const provided = m?.[1];
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
