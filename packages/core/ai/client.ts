import { assertServerJudgmentAllowed } from "../tasks/judgment";
import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { config } from "../config";
import { currentUsageContext, recordUsage } from "./usage";
import { RescheduleError } from "../jobs/queue";
import {
  ProviderAttemptsExhaustedError,
  withBoundedProviderRetry,
  type ProviderAttemptOutcome,
} from "../jobs/providerRetry";
import {
  AgentCliLLM,
  resolveAgentCliAdapter,
  type AgentCliAdapter,
} from "./agentCli";

export { LLMOutputError } from "./errors";
import { LLMOutputError } from "./errors";

/** Transient provider/infrastructure failures a durable job should RETRY —
 * rate limits, overload, connection loss — as opposed to a genuine
 * output-quality failure, which a retry rarely fixes. Duck-typed on the
 * numeric `status` both the Anthropic and OpenAI SDKs expose, so LLM and
 * embedder errors classify identically. */
export function isRetryableProviderError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  // The bounded provider policy has already made the retry decision for this
  // operation: a circuit refusal and a provider-named retry-after are DELAYED
  // work (`RescheduleError`), and an exhausted attempt budget is a transient
  // provider failure that outlived its own two-minute window. A handler that
  // treats either as a quality failure would mark the job done instead.
  if (err instanceof RescheduleError) return true;
  if (err instanceof ProviderAttemptsExhaustedError) return true;
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number") {
    return status === 408 || status === 429 || status >= 500;
  }
  if (err instanceof Anthropic.APIConnectionError) return true;
  // The OpenAI SDK's connection/timeout errors carry no status; match by class
  // name so the embedder path needs no SDK import here.
  const label = (err as { constructor?: { name?: string } }).constructor?.name;
  return typeof label === "string" && label.includes("ConnectionError");
}

/** Seconds the provider itself asked us to wait, off the SDK's response
 *  headers. Both header shapes the SDKs expose are read; anything else is
 *  absent rather than guessed. */
function providerRetryAfterMs(err: unknown): number | undefined {
  const headers = (err as { headers?: unknown }).headers;
  const raw =
    headers instanceof Headers
      ? headers.get("retry-after")
      : headers && typeof headers === "object"
        ? (headers as Record<string, unknown>)["retry-after"]
        : undefined;
  const seconds = Number(typeof raw === "string" ? raw : NaN);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.min(Math.ceil(seconds), 86_400) * 1_000;
}

/**
 * What one failed model call means to the bounded retry policy.
 *
 * Everything the caller decided — an abort, an output the schema rejected — is
 * `not_provider`: the request either never reached Anthropic or reached it and
 * was answered, so neither is evidence for the circuit that exists to stop
 * hammering a failing provider.
 */
function classifyModelFailure(error: unknown): ProviderAttemptOutcome {
  if (error instanceof LLMOutputError) {
    return { kind: "not_provider" };
  }
  // An abort carries no status and, in the SDK's case, no `name` of its own:
  // `APIUserAbortError` never assigns one, so the instance reads "Error" and a
  // name test alone would send every drained-budget cancellation to the
  // circuit. Match the class, and the constructor name beside it for the
  // embedder SDK that has the same shape without this import.
  const name = error instanceof Error ? error.name : "";
  const label = (error as { constructor?: { name?: string } })?.constructor?.name;
  if (
    error instanceof Anthropic.APIUserAbortError ||
    name === "AbortError" ||
    label === "APIUserAbortError"
  ) {
    return { kind: "not_provider" };
  }
  const failureKind = errKind(error);
  if (!isRetryableProviderError(error)) return { kind: "terminal", failureKind };
  const retryAfterMs = providerRetryAfterMs(error);
  return retryAfterMs === undefined
    ? { kind: "transient", failureKind }
    : { kind: "transient", failureKind, retryAfterMs };
}

/**
 * Run one model call under the bounded retry policy and the org's durable
 * circuit (`jobs/providerRetry.ts`). A call with no organization attribution
 * has no circuit to keep and runs once.
 */
async function withModelRetryPolicy<T>(
  operation: "text" | "json" | "searchText",
  model: string,
  attempt: () => Promise<T>,
): Promise<T> {
  const usage = currentUsageContext();
  if (!usage?.organizationId) {
    return attempt();
  }
  return withBoundedProviderRetry(
    {
      organizationId: usage.organizationId,
      provider: "anthropic",
      // Stable across the attempts of ONE call.
      operationId: `${usage.requestId ?? "unscoped"}:${operation}:${model}`,
      classify: classifyModelFailure,
    },
    attempt,
  );
}

/** The web_search server-tool variant sent with searchText. The current writer
 *  models (sonnet-4-6 / opus-4-8) support 20260209; an env-overridden OLDER model
 *  400s on it — flip this constant to "web_search_20250305" in that case. */
const WEB_SEARCH_TOOL_TYPE = "web_search_20260209" as const;

export type TextOpts = {
  model: string;
  system?: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  /** Optional logical-step label recorded in ai_usage (e.g. "writer", "reply"). */
  stage?: string;
  /** Stable call-site id@version (see ai/prompt/ids.ts) — recorded in ai_usage and
   *  the primary FakeLLM routing key in tests. */
  promptRef?: string;
  /** Cancel the in-flight request (job wall-clock budget). When set, per-request
   *  retries are DISABLED: under a budget, a retry after a slow first attempt is a
   *  doomed request the abort would kill anyway — don't pay for it. */
  signal?: AbortSignal;
};

export type JsonOpts<T> = {
  model: string;
  system?: string;
  user: string;
  schema: z.ZodType<T>;
  /** Constrain bounded worker batches at the provider; Zod still validates the result. */
  strict?: boolean;
  maxTokens?: number;
  /** Optional logical-step label recorded in ai_usage (e.g. "filter", "distill"). */
  stage?: string;
  /** See TextOpts.promptRef — stable call-site id@version. */
  promptRef?: string;
  /** See TextOpts.signal — cancels in-flight + disables per-request retries. */
  signal?: AbortSignal;
};

export type WebSearchOpts = {
  /** Max billed searches for this call (default 3). */
  maxUses?: number;
  allowedDomains?: string[];
  blockedDomains?: string[];
  /** Per-request timeout — web-search calls run much longer than plain writes, but
   *  must still fit the serverless job budget (default config.webSearchTimeoutMs). */
  timeoutMs?: number;
};

export type SearchedTextResult = {
  text: string;
  /** Whether any web search actually ran (drives the billing surcharge). */
  searched: boolean;
  /** Billed searches (usage.server_tool_use.web_search_requests, summed). */
  searchCount: number;
  /** What the draft drew on — cited URLs first, else top results. date = page_age. */
  sources: { url: string; title?: string; date?: string }[];
};

/** Content-block sequence of a searchText exchange, order-preserving. */
export type SearchedTextPart =
  | { kind: "text"; text: string }
  | { kind: "result" };

/**
 * The ANSWER of a search-augmented exchange is the text emitted AFTER the last
 * tool result — everything before it is the model narrating its research
 * ("No clean results on X, writing without a nod…"), which leaked verbatim
 * into shipped DMs when all text blocks were naively concatenated. No search
 * ran → every text block is the answer.
 */
export function assembleSearchedText(parts: SearchedTextPart[]): string {
  const lastResult = parts.map((p) => p.kind).lastIndexOf("result");
  const answer = parts
    .slice(lastResult + 1)
    .filter((p): p is { kind: "text"; text: string } => p.kind === "text")
    .map((p) => p.text)
    .join("")
    .trim();
  // Defensive: a model that emits NOTHING after the final tool result would
  // otherwise return "" — fall back to the full concatenation (pre-fix shape).
  if (answer) return answer;
  return parts
    .filter((p): p is { kind: "text"; text: string } => p.kind === "text")
    .map((p) => p.text)
    .join("")
    .trim();
}

/** Provider-agnostic LLM surface so stages can be unit-tested with a fake. */
export interface LLM {
  text(opts: TextOpts): Promise<string>;
  json<T>(opts: JsonOpts<T>): Promise<T>;
  /** OPTIONAL — web-search-augmented text (Anthropic server tool). Callers MUST
   *  fall back to text() when absent (fakes/providers without search). */
  searchText?(
    opts: TextOpts & { webSearch?: WebSearchOpts },
  ): Promise<SearchedTextResult>;
}

/**
 * Bind every call made through the returned LLM to `signal` (used by the worker so
 * a job's wall-clock abort actually cancels its in-flight LLM calls instead of
 * abandoning them). `base` resolution is LAZY so key-less deployments that never
 * reach an LLM call don't throw at wrap time.
 */
export function llmWithSignal(base: LLM | undefined, signal: AbortSignal): LLM {
  return {
    text: (opts) => (base ?? getLLM()).text({ ...opts, signal }),
    json: (opts) => (base ?? getLLM()).json({ ...opts, signal }),
    // Presence must mirror the underlying client at CALL time (fallback contract):
    // a getter so wrapping a search-less fake yields undefined, not a throwing stub.
    get searchText() {
      const b = base ?? getLLM();
      const f = b.searchText;
      return f
        ? (opts: TextOpts & { webSearch?: WebSearchOpts }) =>
            f.call(b, { ...opts, signal })
        : undefined;
    },
  };
}

export class AnthropicLLM implements LLM {
  private client: Anthropic;
  constructor(apiKey?: string) {
    // Bound every call: the SDK default is a ~10-minute timeout with 2 retries, so a
    // single hung/slow request can outlast the serverless function budget and get the
    // whole job killed mid-run (then silently retried forever). A 30s per-request
    // timeout keeps any one LLM call well under the drain's per-job budget. SDK
    // retries are disabled: an invisible retry can incur provider spend that has
    // no usage block to record exactly. Retry semantics belong to the durable
    // job and to `withModelRetryPolicy`.
    this.client = new Anthropic({
      apiKey: apiKey ?? config.anthropicKey(),
      timeout: 30_000,
      maxRetries: 0,
    });
  }

  text(opts: TextOpts): Promise<string> {
    return withModelRetryPolicy("text", opts.model, () => this.textOnce(opts));
  }

  /** One attempt. The policy above decides whether a failed one is tried
   *  again. */
  private async textOnce(opts: TextOpts): Promise<string> {
    const maxTokens = opts.maxTokens ?? 400;
    const startedAt = Date.now();
    let res: Anthropic.Message;
    try {
      res = await this.client.messages.create(
        {
          model: opts.model,
          max_tokens: maxTokens,
          system: opts.system,
          temperature: opts.temperature,
          messages: [{ role: "user", content: opts.user }],
        },
        opts.signal ? { signal: opts.signal, maxRetries: 0 } : undefined,
      );
    } catch (e) {
      recordUsage({
        provider: "anthropic",
        model: opts.model,
        operation: "text",
        stage: opts.stage,
        promptRef: opts.promptRef,
        latencyMs: Date.now() - startedAt,
        ok: false,
        errorKind: errKind(e),
      });
      throw e;
    }
    const actualUsage = usageFrom(res.usage);
    recordUsage({
      provider: "anthropic",
      model: opts.model,
      operation: "text",
      stage: opts.stage,
      promptRef: opts.promptRef,
      ...actualUsage,
      latencyMs: Date.now() - startedAt,
      ok: true,
    });
    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  }

  /**
   * Web-search-augmented text generation (Anthropic server tool). The model
   * searches autonomously (up to maxUses); we parse the cited sources + billed
   * search count out of the response for billing (3-credit drafts) and the
   * draft trace. `pause_turn` continuations are followed (cap 2). Throws on
   * API/timeout errors — the caller falls back to plain text().
   */
  searchText(
    opts: TextOpts & { webSearch?: WebSearchOpts },
  ): Promise<SearchedTextResult> {
    return withModelRetryPolicy("searchText", opts.model, () =>
      this.searchTextOnce(opts),
    );
  }

  private async searchTextOnce(
    opts: TextOpts & { webSearch?: WebSearchOpts },
  ): Promise<SearchedTextResult> {
    const ws = opts.webSearch ?? {};
    const maxUses = ws.maxUses ?? 3;
    const maxTokens = opts.maxTokens ?? 2000;
    const tool: Anthropic.WebSearchTool20260209 = {
      type: WEB_SEARCH_TOOL_TYPE,
      name: "web_search",
      max_uses: maxUses,
      ...(ws.allowedDomains?.length
        ? { allowed_domains: ws.allowedDomains }
        : {}),
      ...(ws.blockedDomains?.length
        ? { blocked_domains: ws.blockedDomains }
        : {}),
    };
    const requestOpts = {
      timeout: ws.timeoutMs ?? config.webSearchTimeoutMs,
      maxRetries: 0,
      ...(opts.signal ? { signal: opts.signal } : {}),
    };

    const startedAt = Date.now();
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: opts.user },
    ];
    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    };
    let searchCount = 0;
    const parts: SearchedTextPart[] = [];
    // url → {title, date}: result blocks carry page_age; citations mark what the
    // model actually used. Cited URLs win; result blocks are the fallback pool.
    const resultMeta = new Map<string, { title?: string; date?: string }>();
    const citedUrls: string[] = [];

    try {
      for (let turn = 0; turn <= 2; turn++) {
        const res = await this.client.messages.create(
          {
            model: opts.model,
            max_tokens: maxTokens,
            system: opts.system,
            temperature: opts.temperature,
            messages,
            tools: [tool],
          },
          requestOpts,
        );
        const u = usageFrom(res.usage);
        usage.inputTokens += u.inputTokens;
        usage.outputTokens += u.outputTokens;
        usage.cacheCreationTokens += u.cacheCreationTokens;
        usage.cacheReadTokens += u.cacheReadTokens;
        searchCount += res.usage?.server_tool_use?.web_search_requests ?? 0;

        for (const block of res.content) {
          if (block.type === "text") {
            parts.push({ kind: "text", text: block.text });
            for (const c of block.citations ?? []) {
              if (
                c.type === "web_search_result_location" &&
                c.url &&
                !citedUrls.includes(c.url)
              ) {
                citedUrls.push(c.url);
                if (!resultMeta.has(c.url))
                  resultMeta.set(c.url, { title: c.title ?? undefined });
              }
            }
          } else if (block.type === "web_search_tool_result") {
            parts.push({ kind: "result" });
            // content is an ERROR OBJECT on failure, a result list on success.
            if (Array.isArray(block.content)) {
              for (const r of block.content) {
                if (!resultMeta.has(r.url)) {
                  resultMeta.set(r.url, {
                    title: r.title ?? undefined,
                    date: r.page_age ?? undefined,
                  });
                }
              }
            }
          }
        }
        if (res.stop_reason !== "pause_turn") break;
        messages.push({ role: "assistant", content: res.content });
      }
    } catch (e) {
      recordUsage({
        provider: "anthropic",
        model: opts.model,
        operation: "text",
        stage: opts.stage,
        promptRef: opts.promptRef,
        ...usage,
        webSearchRequests: searchCount,
        latencyMs: Date.now() - startedAt,
        ok: false,
        errorKind: errKind(e),
      });
      throw e;
    }

    recordUsage({
      provider: "anthropic",
      model: opts.model,
      operation: "text",
      stage: opts.stage,
      promptRef: opts.promptRef,
      ...usage,
      webSearchRequests: searchCount,
      latencyMs: Date.now() - startedAt,
      ok: true,
    });

    const urls = citedUrls.length > 0 ? citedUrls : [...resultMeta.keys()];
    const sources = urls.slice(0, 5).map((url) => {
      const m = resultMeta.get(url);
      return { url, title: m?.title, date: m?.date };
    });
    return {
      text: assembleSearchedText(parts),
      searched: searchCount > 0,
      searchCount,
      sources,
    };
  }

  json<T>(opts: JsonOpts<T>): Promise<T> {
    return withModelRetryPolicy("json", opts.model, () => this.jsonOnce(opts));
  }

  private async jsonOnce<T>(opts: JsonOpts<T>): Promise<T> {
    // Forced tool choice alone does not constrain argument types. Worker
    // batches opt into strict decoding; other callers may have larger schemas
    // than the provider's strict-schema limits allow.
    let jsonSchema = zodToJsonSchema(opts.schema, {
      $refStrategy: "none",
      target: opts.strict ? "jsonSchema7" : "openApi3",
    }) as Record<string, unknown>;
    delete jsonSchema.$schema;
    if (opts.strict) {
      // The SDK moves unsupported bounds into descriptions and closes objects.
      // Keep the original Zod schema below: IDs, verdicts and text are never coerced.
      jsonSchema = jsonSchemaOutputFormat(jsonSchema as { type: "object" }).schema;
    }

    const maxTokens = opts.maxTokens ?? 500;
    const startedAt = Date.now();
    let res: Anthropic.Message;
    try {
      res = await this.client.messages.create(
        {
          model: opts.model,
          max_tokens: maxTokens,
          system: opts.system,
          messages: [{ role: "user", content: opts.user }],
          tools: [
            {
              name: "emit",
              description: "Emit the structured result.",
              input_schema: jsonSchema as Anthropic.Tool.InputSchema,
              ...(opts.strict ? { strict: true } : {}),
            },
          ],
          tool_choice: { type: "tool", name: "emit" },
        },
        opts.signal ? { signal: opts.signal, maxRetries: 0 } : undefined,
      );
    } catch (e) {
      recordUsage({
        provider: "anthropic",
        model: opts.model,
        operation: "json",
        stage: opts.stage,
        promptRef: opts.promptRef,
        latencyMs: Date.now() - startedAt,
        ok: false,
        errorKind: errKind(e),
      });
      throw e;
    }

    const block = res.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    const parsed = block ? opts.schema.safeParse(block.input) : undefined;
    // The API call succeeded — tokens were SPENT — even if the output is unusable.
    // Record it (with an errorKind) so wasted spend on truncated/invalid drafts is
    // visible in ai_usage rather than vanishing into the thrown error below.
    const outErr = !block
      ? res.stop_reason === "max_tokens"
        ? "max_tokens"
        : "no_tool_use"
      : parsed && !parsed.success
        ? res.stop_reason === "max_tokens"
          ? "max_tokens"
          : "schema_fail"
        : null;
    const actualUsage = usageFrom(res.usage);
    recordUsage({
      provider: "anthropic",
      model: opts.model,
      operation: "json",
      stage: opts.stage,
      promptRef: opts.promptRef,
      ...actualUsage,
      latencyMs: Date.now() - startedAt,
      ok: true,
      errorKind: outErr,
    });

    if (!block) {
      // A max_tokens stop can cut the response off before any tool_use block.
      if (res.stop_reason === "max_tokens") {
        throw new LLMOutputError(
          `output truncated at max_tokens=${maxTokens} before a tool call; raise maxTokens`,
        );
      }
      throw new LLMOutputError("model returned no tool_use block");
    }
    if (!parsed!.success) {
      // The usual cause of a "required field missing" failure here is the
      // forced-tool JSON being cut off at the token limit: the API returns the
      // partial tool input (often `{}`), so required fields look absent. Surface
      // that explicitly rather than a misleading schema error.
      if (res.stop_reason === "max_tokens") {
        throw new LLMOutputError(
          `output truncated at max_tokens=${maxTokens}; raise maxTokens or shorten the input`,
        );
      }
      throw new LLMOutputError(
        `tool output failed schema: ${parsed!.error.message.slice(0, 240)}`,
      );
    }
    return parsed!.data;
  }
}

/** Flatten an Anthropic usage block into the token counts ai_usage records. */
function usageFrom(u: Anthropic.Usage | undefined): {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
} {
  if (!u) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    };
  }
  // The pinned SDK doesn't type the prompt-cache fields, but the API returns them
  // at runtime — read defensively so cache spend is still captured.
  const c = u as Anthropic.Usage & {
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheCreationTokens: c.cache_creation_input_tokens ?? 0,
    cacheReadTokens: c.cache_read_input_tokens ?? 0,
  };
}

/** Compact error label for ai_usage.error_kind (e.g. "api_429", "APIError"). */
function errKind(e: unknown): string {
  if (
    e &&
    typeof e === "object" &&
    "status" in e &&
    typeof (e as { status?: unknown }).status === "number"
  ) {
    return `api_${(e as { status: number }).status}`;
  }
  return e instanceof Error ? e.name : "error";
}

/**
 * The clients this process has built, keyed by the AGENT that backs them — the
 * direct Anthropic path under "api".
 *
 * Keyed by agent and never by (agent, model): `model` is a per-call argument on
 * `LLM` and both clients are model-agnostic, so a per-model key would mint an
 * identical client per model id and split the one instance callers share. The
 * map has a single live key today; it is what Phase 8's per-worker agents will
 * key, and it is where the mistake would otherwise land.
 */
const clients = new Map<string, LLM>();

function clientFor(key: string, build: () => LLM): LLM {
  const existing = clients.get(key);
  if (existing) return existing;
  const built = build();
  clients.set(key, built);
  return built;
}

/**
 * The process-wide LLM. Defaults to the owner's own agent CLI (no API key),
 * falling back to the direct Anthropic path only when explicitly configured
 * with ENGAGER_LLM_BACKEND=api.
 *
 * Lazy on purpose, as before: a management-only MCP session that never reaches
 * an LLM call must not require a provider — nor, now, an installed agent CLI.
 */
export function getLLM(): LLM {
  assertServerJudgmentAllowed();
  if (config.llmBackend !== "agent-cli") {
    return clientFor("api", () => new AnthropicLLM());
  }
  const adapter = resolveAgentCliAdapter();
  return clientFor(adapter.id, () => new AgentCliLLM(adapter));
}

/**
 * Which agent backs inference in this process — the key `getLLM()` builds
 * under, the direct Anthropic path answering "api". Exported for
 * `boundaryModelScope()`, which stamps it on the usage scope: it reads the same
 * resolution, so a scope and the client serving it resolve the same agent.
 */
export function resolvedAgentId(): string {
  if (config.llmBackend !== "agent-cli") return "api";
  return resolveAgentCliAdapter().id;
}
