import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { db as baseDb } from "@engager/database";
import { aiUsage } from "@engager/database/schema";
import type { AgentCliId, ResolvedAgentSelection } from "./agentCli/types";
import type { ModelRole } from "./modelFor";
import { costMicros } from "./pricing";

/**
 * Attribution for the LLM/embedding calls made inside a unit of work — set once at
 * an entry boundary (a worker job, an MCP tool call, a dashboard action) and read
 * back at the client chokepoints. The clients are org-agnostic singletons, so this
 * AsyncLocalStorage is how a recorded call learns which org/job/stage it belongs to.
 */
export type UsageContext = {
  organizationId?: string | null;
  jobId?: number | null;
  campaignId?: number | null;
  source?: string | null; // "worker" | "mcp" | "action" | "script"
  stage?: string | null;
  /** Entry-boundary operation used for tool-level hosted COGS dimensions. */
  budgetTool?: string | null;
  /** Hosted MCP credential that authorized this unit of work. */
  credentialKeyId?: string | null;
  /** Stable per-entry-boundary identifier; generated when omitted. */
  requestId?: string | null;
  /** Worker lease identity, used to distinguish legitimate job retries. */
  jobLeaseToken?: string | null;
  /** The agent backing inference for this unit of work ("api" for the direct
   *  provider path), resolved once at the entry boundary. */
  agent?: string | null;
  /** The WORKER identity this unit of work runs AS — the one every trigger
   *  resolves for itself, `null` when the campaign has no scout to run as.
   *  ABSENT is a third state and not a synonym for `null`: it says nobody
   *  decided, which `modelFor` refuses on the job types that must (see
   *  `modelFor.ts`). */
  workerId?: number | null;
  /** What every `modelFor(role)` inside this scope resolves against, set once at
   *  the entry boundary by `boundaryModelScope()` and inherited by nested scopes. */
  models?: Readonly<Record<ModelRole, string>> | null;
  /** The stored claude spawn path, resolved at the same boundary as `models`.
   *  Null or absent = the env fallback; consulted only when the resolved
   *  adapter is claude, so it can never clobber a codex pin. */
  agentBin?: string | null;
  localAgentSelection?: ResolvedAgentSelection | null;
};

export type ProviderUsageContext = UsageContext & {
  requestId: string;
  requestPhase: number;
};

/** One recorded LLM/embedding call, before org/job attribution is applied. */
export type UsageEvent = {
  provider: string;
  /** The agent CLI that served the call; omitted by a direct provider call. */
  agentId?: AgentCliId | null;
  localAgentReport?: { requestedModel: string; actualReportedModel: string | null; usage: Record<string, number> | null };
  model: string;
  operation: "text" | "json" | "embed";
  stage?: string | null; // per-call override of the context stage
  promptRef?: string | null; // stable call-site id@version ("writer.comment@1")
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  /** Billed web searches this call made (usage.server_tool_use.web_search_requests). */
  webSearchRequests?: number;
  latencyMs?: number;
  ok: boolean;
  errorKind?: string | null;
  spendReservationId?: string | null;
  requestPhase?: number | null;
};

type Collector = {
  ctx: UsageContext & { requestId: string };
  events: UsageEvent[];
  phase: { value: number };
};
const store = new AsyncLocalStorage<Collector>();

/**
 * Run `fn` inside a usage-recording scope. Every LLM/embedding call made within
 * (at any depth) is BUFFERED and flushed to ai_usage once `fn` settles — on the
 * base pool, AFTER any `withOrg` tx has closed. This mirrors the worker's
 * phase-1/phase-2 split: telemetry never acquires a second connection inside the
 * handler's tx (so it can't reintroduce the pool-deadlock) and is recorded even
 * when the handler throws and its tx rolls back. Flushing is best-effort — a
 * telemetry write never fails or delays the caller's result.
 */
export async function withUsageContext<T>(
  ctx: UsageContext,
  fn: () => Promise<T>,
): Promise<T> {
  const parent = store.getStore();
  const merged = { ...parent?.ctx, ...ctx };
  const collector: Collector = {
    ctx: {
      ...merged,
      requestId: merged.requestId?.trim() || randomUUID(),
    },
    events: [],
    // Nested scopes share one counter object. That keeps phases unique even when
    // sibling helpers run concurrently under Promise.all.
    phase: parent?.phase ?? { value: 0 },
  };
  try {
    return await store.run(collector, fn);
  } finally {
    if (collector.events.length > 0) {
      await insertRows(collector.ctx, collector.events).catch((e) => {
        // eslint-disable-next-line no-console
        console.error("[ai-usage] flush failed:", e instanceof Error ? e.message : e);
      });
    }
  }
}

/**
 * Claim the next deterministic provider phase inside the current request. Real
 * provider clients call this exactly once before reserving spend. No context is
 * returned for explicit local/test scripts, where the hosted guard may bypass;
 * dev/prod callers fail closed in the reservation layer.
 */
export function claimProviderUsageContext(
  stage?: string | null,
): ProviderUsageContext | undefined {
  const collector = store.getStore();
  if (!collector) return undefined;
  collector.phase.value += 1;
  return {
    ...collector.ctx,
    stage: stage ?? collector.ctx.stage ?? null,
    requestPhase: collector.phase.value,
  };
}

/** Read-only access for diagnostics/tests; callers must not mutate the result. */
export function currentUsageContext(): UsageContext | undefined {
  return store.getStore()?.ctx;
}

/**
 * Record one LLM/embedding call. Called by the client chokepoints. Inside a
 * `withUsageContext` scope it buffers (flushed at the boundary); outside one
 * (scripts, unwrapped paths) it persists immediately, fire-and-forget, so a call
 * is never silently uncounted. The immediate write is NOT awaited, so it can't
 * deadlock the caller's tx even at pool max 1.
 */
export function recordUsage(ev: UsageEvent): void {
  const collector = store.getStore();
  if (collector) {
    collector.events.push(ev);
    return;
  }
  void insertRows(undefined, [ev]).catch(() => {
    /* best-effort telemetry */
  });
}

async function insertRows(
  ctx: UsageContext | undefined,
  events: UsageEvent[],
): Promise<void> {
  // Telemetry persistence is a side effect of the REAL clients. Skip it under vitest
  // so unit tests that exercise those clients with a mocked SDK stay
  // DB-free. Production (worker / MCP / dashboard / scripts) runs with VITEST unset.
  if (process.env.VITEST) return;
  const rows = events.map((ev) => {
    const inputTokens = ev.inputTokens ?? 0;
    const outputTokens = ev.outputTokens ?? 0;
    const cacheCreationTokens = ev.cacheCreationTokens ?? 0;
    const cacheReadTokens = ev.cacheReadTokens ?? 0;
    return {
      organizationId: ctx?.organizationId ?? null,
      provider: ev.provider,
      agentId: ev.agentId ?? null,
      localAgentReport: ev.localAgentReport ?? null,
      model: ev.model,
      operation: ev.operation,
      stage: ev.stage ?? ctx?.stage ?? null,
      promptRef: ev.promptRef ?? null,
      source: ctx?.source ?? null,
      credentialKeyId: ctx?.credentialKeyId ?? null,
      requestId: ctx?.requestId ?? null,
      requestPhase: ev.requestPhase ?? null,
      spendReservationId: ev.spendReservationId ?? null,
      jobId: ctx?.jobId ?? null,
      campaignId: ctx?.campaignId ?? null,
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      totalTokens: inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens,
      costUsdMicros: ev.agentId ? null : costMicros(ev.model, ev),
      latencyMs: ev.latencyMs ?? null,
      ok: ev.ok,
      errorKind: ev.errorKind ?? null,
    };
  });
  await baseDb.insert(aiUsage).values(rows);
}
