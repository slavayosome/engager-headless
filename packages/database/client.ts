import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import { pgConnectionSecurityConfig } from "./poolConfig";

// Reuse a single pool across hot reloads / worker imports.
const globalForDb = globalThis as unknown as {
  __engagerPool?: Pool;
  __engagerDb?: NodePgDatabase<typeof schema>;
};

function createPool(): Pool {
  const p = new Pool({
    ...pgConnectionSecurityConfig(),
    // Serverless (Vercel) connects through a TRANSACTION-MODE pooler (PgBouncer /
    // Supabase :6543 / Neon): keep a SMALL per-invocation pool so concurrent
    // function instances don't exhaust Postgres connections. withOrg() uses a
    // single tx (set_config LOCAL), which is safe under transaction pooling.
    // Defaults stay friendly for a long-running local/VPS process.
    max: Number(process.env.ENGAGER_PG_POOL_MAX ?? 10),
    // Fail fast when a connection can't be acquired (pool exhausted, or a request
    // needs more connections than the pool allows) instead of hanging until the
    // platform's function timeout — a 300s hang here crashes the whole serverless
    // instance with an uncaught idle-in-transaction error. A bounded wait surfaces
    // as a catchable error on the offending request, keeping siblings alive.
    connectionTimeoutMillis: Number(
      process.env.ENGAGER_PG_CONNECT_TIMEOUT_MS ?? 10_000,
    ),
    // Keep idle TCP connections alive so a long-running worker's connection isn't
    // silently dropped by the network/Neon between polls.
    keepAlive: true,
  });
  // CRITICAL for the long-running worker: when Neon closes an IDLE pooled connection,
  // pg emits 'error' on that idle client. With no listener, Node treats it as an
  // unhandled EventEmitter 'error' and crashes the whole process (the worker then
  // restarts, losing its loop). Swallow it — pg discards the dead client and opens a
  // fresh one on the next acquire, so the next query simply reconnects.
  p.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error("[db] idle client error (pool will reconnect):", err.message);
  });
  return p;
}

export const pool: Pool =
  globalForDb.__engagerPool ?? (globalForDb.__engagerPool = createPool());

export const db: NodePgDatabase<typeof schema> =
  globalForDb.__engagerDb ??
  (globalForDb.__engagerDb = drizzle(pool, { schema }));

export { schema };

/**
 * Is this a transient DB connection/pool failure that a best-effort handler should
 * RETRY on (by rethrowing) rather than swallow? It distinguishes "the pool was
 * momentarily starved / Neon dropped the socket / connect timed out" — which must fail
 * the job so the queue retries and eventually surfaces it — from a genuine content/LLM
 * failure that is a true no-op. Deliberately CONSERVATIVE: only clear infra signals
 * return true; anything unrecognised is treated as NON-retryable, so a real logic bug
 * can never be turned into an infinite retry loop. Checks one level of `cause` because
 * drizzle/pg sometimes wrap the underlying driver error.
 */
export function isRetryableDbError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { message?: unknown; code?: unknown; cause?: unknown };
  const code = typeof e.code === "string" ? e.code : undefined;
  // node socket errnos + Postgres SQLSTATE connection classes (08xxx) + admin/capacity.
  const RETRYABLE_CODES = new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "ENOTFOUND",
    "EPIPE",
    "EHOSTUNREACH",
    "08000",
    "08001",
    "08003",
    "08004",
    "08006", // connection_exception family
    "57P01", // admin_shutdown
    "57P03", // cannot_connect_now
    "53300", // too_many_connections
    // Lock casualties: the statement lost a race, not its correctness — a fresh
    // attempt against the settled state is exactly the remedy. Swallowing a
    // 40P01 is how import_voice silently lost a channel voice while the job
    // read `done` (CI flake, 2026-07-27: setChannelVoice vs
    // setProfileStructuralRange lock-order deadlock).
    "40001", // serialization_failure
    "40P01", // deadlock_detected
    "55P03", // lock_not_available (lock_timeout)
  ]);
  if (code && RETRYABLE_CODES.has(code)) return true;
  const msg = typeof e.message === "string" ? e.message.toLowerCase() : "";
  if (
    msg.includes("timeout exceeded when trying to connect") || // pg Pool acquire timeout
    msg.includes("connection terminated") ||
    msg.includes("client has encountered a connection error") ||
    msg.includes("connection refused") ||
    msg.includes("could not connect")
  ) {
    return true;
  }
  if (e.cause && e.cause !== err) return isRetryableDbError(e.cause);
  return false;
}
