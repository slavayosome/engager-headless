/**
 * Central env-backed config. Import this rather than reading process.env directly.
 */
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isHostedRuntimeEnvironment,
  resolveDeploymentEnvironment,
} from "@engager/database/environment";

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function required(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export type DashboardRuntimeConfig =
  | { mode: "disabled" }
  | { mode: "configured"; origin: string }
  | { mode: "invalid"; reason: string };

export function dashboardRuntimeConfig(
  processEnv: NodeJS.ProcessEnv = process.env,
): DashboardRuntimeConfig {
  let deployment: ReturnType<typeof resolveDeploymentEnvironment>;
  try {
    deployment = resolveDeploymentEnvironment(processEnv);
  } catch (error) {
    return {
      mode: "invalid",
      reason:
        error instanceof Error
          ? error.message
          : "Invalid deployment environment",
    };
  }
  const hosted = isHostedRuntimeEnvironment(processEnv);
  if (hosted && deployment !== "dev" && deployment !== "prod") {
    return {
      mode: "invalid",
      reason: "ENGAGER_DEPLOYMENT_ENV must be dev or prod on a hosted platform",
    };
  }
  const raw = processEnv.ENGAGER_DASHBOARD_URL?.trim();
  if (!raw) {
    return hosted
      ? {
          mode: "invalid",
          reason:
            "ENGAGER_DASHBOARD_URL is required for hosted customer notifications",
        }
      : { mode: "disabled" };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return {
      mode: "invalid",
      reason: "ENGAGER_DASHBOARD_URL must be an absolute URL",
    };
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(
    parsed.hostname,
  );
  const validProtocol =
    parsed.protocol === "https:" ||
    (!hosted && parsed.protocol === "http:" && loopback);
  if (
    !validProtocol ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search ||
    parsed.hash
  ) {
    return {
      mode: "invalid",
      reason: hosted
        ? "ENGAGER_DASHBOARD_URL must be an origin-only absolute HTTPS URL in hosted runtimes"
        : "ENGAGER_DASHBOARD_URL must be an origin-only absolute HTTPS URL or a loopback HTTP URL",
    };
  }

  return { mode: "configured", origin: parsed.origin };
}

/** Build a dashboard URL, or throw when a hosted deployment is misconfigured. */
export function dashboardUrl(
  path = "/",
  processEnv: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const runtime = dashboardRuntimeConfig(processEnv);
  if (runtime.mode === "invalid") throw new Error(runtime.reason);
  if (runtime.mode === "disabled") return undefined;
  if (path === "/") return runtime.origin;
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("Dashboard link path must stay on the configured dashboard origin");
  }
  return new URL(path, `${runtime.origin}/`).toString();
}

/**
 * Parse an integer env var, falling back to `fallback` when the var is unset,
 * empty, or not a finite number. An explicit numeric `0` is PRESERVED (callers
 * that treat 0 as "no cap" rely on this — see reserveReadCall). Without this,
 * `Number(process.env.X ?? d)` turns an empty-string env var into 0, which silently
 * disables whatever budget it feeds.
 */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Parse the granular `ENGAGER_LEAD_RANKER` flag. Default OFF: an unset/empty/`0`/
 * `off`/`false` value disables the whole feature (byte-identical FIFO behavior).
 * `1`/`on`/`true` enables both gates. `gate1`/`gate2` (comma-separated allowed,
 * e.g. `gate1,gate2`) enable individual gates with betScore still computed.
 */
export function parseLeadRanker(raw: string | undefined): {
  enabled: boolean;
  gate1: boolean;
  gate2: boolean;
} {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "" || v === "0" || v === "off" || v === "false") {
    return { enabled: false, gate1: false, gate2: false };
  }
  if (v === "1" || v === "on" || v === "true") {
    return { enabled: true, gate1: true, gate2: true };
  }
  const parts = v.split(/[,\s]+/).filter(Boolean);
  const gate1 = parts.includes("gate1");
  const gate2 = parts.includes("gate2");
  if (gate1 || gate2) return { enabled: true, gate1, gate2 };
  // Any other non-empty value: treat as "on" (fail toward the explicit opt-in the
  // operator clearly intended, but never silently when the value is the OFF set above).
  return { enabled: true, gate1: true, gate2: true };
}

/**
 * A test process never resolves a vault inside the owner's real `~/.engager`.
 * `vitest.setup.ts` gives every test process a throwaway HOME and Brain dir, so
 * reaching the owner's root means a case bypassed that isolation, and the only
 * safe answer is to throw before a note lands in the owner's data. The owner
 * is the account record's home (`userInfo()`), not `$HOME`: the suite's own
 * HOME override is exactly what this has to tell apart from the real one.
 * Both sides are compared as the filesystem sees them — through symlinks, and
 * without case on macOS, whose default volume would open `~/.Engager` as the
 * owner's own directory.
 */
function refuseOwnerVaultUnderTest(dir: string): string {
  if (!env("VITEST") && env("ENGAGER_DEPLOYMENT_ENV") !== "test") return dir;
  let ownerRoot: string;
  try {
    ownerRoot = path.join(os.userInfo().homedir, ".engager");
  } catch {
    return dir; // no account record, so no owner home on this machine
  }
  const inside = path.relative(onDisk(ownerRoot), onDisk(dir));
  if (inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
    return dir;
  }
  throw new Error(
    `Refusing ${dir} under test: it is inside the owner's real ~/.engager. ` +
      "Point ENGAGER_BRAIN_DIR or HOME at a temp dir, as vitest.setup.ts does.",
  );
}

/** `target` with its deepest existing ancestor resolved through symlinks (the
 *  rest may not exist yet), folded to one case where the volume ignores it. */
function onDisk(target: string): string {
  const missing: string[] = [];
  let existing = target;
  let resolved = target;
  for (;;) {
    try {
      resolved = path.join(realpathSync(existing), ...missing);
      break;
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
  return process.platform === "darwin" ? resolved.toLowerCase() : resolved;
}

export const config = {
  dbPath: env("ENGAGER_DB_PATH", "./engager.db")!,
  // The Brain's PARA markdown vault (INV-14's canonical knowledge store).
  // `ENGAGER_BRAIN_DIR` overrides the default ~/.engager/brain (homedir-joined);
  // a `~` prefix on the explicit value expands the same way. A getter (like
  // factRerank/briefInjection) so the env is read at CALL time, never frozen at
  // module load — vitest runs test files in parallel and each suite points this
  // at its own temp dir, never ~/.engager, which a test process is refused.
  get brainDir(): string {
    const raw = env("ENGAGER_BRAIN_DIR");
    const dir = raw
      ? path.resolve(
          raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw,
        )
      : path.join(os.homedir(), ".engager", "brain");
    return refuseOwnerVaultUnderTest(dir);
  },
  masterKey: () => required("ENGAGER_MASTER_KEY"),
  dashboardPassword: () => env("ENGAGER_DASHBOARD_PASSWORD"),

  anthropicKey: () => required("ANTHROPIC_API_KEY"),
  /**
   * Where server-side inference runs. "agent-cli" drives the OWNER'S OWN
   * coding-agent CLI, so a local install needs no provider API key at all —
   * the product's whole premise. "api" is the direct Anthropic HTTP path, kept
   * for a metered deployment and for anyone who would rather spend a key than
   * their subscription.
   *
   * Default: agent-cli everywhere EXCEPT the "test" environment, which stays
   * on the API path for the same reason localSetupContract() excludes it — CI
   * exercises the metered contract, and a unit test must never spawn a real
   * agent process (it would hang on a machine with no CLI, and cost real
   * subscription quota on one that has it). Tests that want the CLI path opt
   * in by setting ENGAGER_LLM_BACKEND=agent-cli.
   *
   * A getter so tests and `engager doctor` can toggle it at runtime.
   */
  get llmBackend(): "agent-cli" | "api" {
    const explicit = env("ENGAGER_LLM_BACKEND");
    if (explicit === "api" || explicit === "agent-cli") return explicit;
    try {
      return resolveDeploymentEnvironment() === "test" ? "api" : "agent-cli";
    } catch {
      return "agent-cli";
    }
  },
  /**
   * The model per role — the three background ones and the dashboard chat's.
   * `roleModels()` in `ai/modelRoles.ts` is the ONE reader: `boundaryModelScope()`
   * resolves its answer onto the usage scope once at an entry boundary and every
   * background call site asks `modelFor(role)` instead, while the agent-CLI
   * status probe and the chat surface — both of which stand outside any scope —
   * ask the leaf for that same answer. A second reader would be a call site
   * choosing its own model with nothing to hold it to the boundary's, the drift
   * INV-5 exists to prevent.
   *
   * `modelFor.test.ts` scans the tree for the spellings that reach this object
   * — the direct read, a destructure, an aliased or namespaced import, a
   * computed access — and fails on a second file. It does NOT hold a plain
   * rebind (`const c = config`) or any other indirection; that much is code
   * review's.
   */
  models: {
    filter: env("ENGAGER_MODEL_FILTER", "claude-haiku-4-5")!,
    writer: env("ENGAGER_MODEL_WRITER", "claude-sonnet-4-6")!,
    writerPremium: env("ENGAGER_MODEL_WRITER_PREMIUM", "claude-opus-4-8")!,
    chat: env("ENGAGER_MODEL_CHAT", "claude-sonnet-4-6")!,
  },

  firecrawlKey: () => env("FIRECRAWL_API_KEY"),

  // Inject the per-campaign compiled focus brief into the writer. Kill switch
  // (default ON): `ENGAGER_BRIEF_INJECTION=off` drops the brief framing + the
  // preferred-slot quotas — but NOT constraint enforcement: `avoid` rows are
  // hard-included on every path regardless of this switch. A getter so the env
  // can be toggled at runtime / in tests (like factRerank/promoFit).
  get briefInjection(): boolean {
    return env("ENGAGER_BRIEF_INJECTION", "on") !== "off";
  },

  // Lead-DM web research: on the API backend the DM may be grounded by 1-2 web
  // searches on the lead (name + headline) for ONE reference to their actual
  // company/product. The agent CLI has no search and writes the offline path.
  // Kill switch (default ON — single-tenant posture; revisit before real
  // tenants): `ENGAGER_DM_WEB_FACTS=off` reverts to the offline DM path.
  get dmWebFacts(): boolean {
    return env("ENGAGER_DM_WEB_FACTS", "on") !== "off";
  },

  // Per-draft voice-derived STYLE DIRECTIVE rotation (Phase 2 of writer-variety).
  // Kill switch (default ON): `ENGAGER_STYLE_DIRECTIVES=off` skips picking +
  // injecting directives, reverting Phase 2 only (Phase 1 stays unconditional).
  styleDirectives: env("ENGAGER_STYLE_DIRECTIVES", "on") !== "off",
  // Intelligent fact retrieval: pull a WIDER Brain candidate set, then a cheap Haiku
  // rerank picks the few most usable-in-a-comment facts for THIS post (replaces the
  // top-2 cosine/recency slice that surfaced off-topic rows → factless, generic
  // comments). Default OFF: it adds one Haiku call per draft (only when there are more
  // candidates than the final slice) and touches the real comment output, so it ships
  // dark for a `npm run shadow:legacy` eval before `ENGAGER_FACT_RERANK=on`. A getter so the
  // env can be toggled at runtime / in tests (like promoFit).
  get factRerank(): boolean {
    return env("ENGAGER_FACT_RERANK", "off") === "on";
  },
  // Fact GROUNDING (the usage half of the same feedback: "comments don't reference the
  // facts / research"). When on, the writer is told to PREFER anchoring the comment in a
  // concrete retrieved fact/story/number when one genuinely fits — instead of a generic
  // take — while staying honest ("don't force an off-topic fact"). Free (prompt text
  // only, no extra LLM call), so it's a separate switch from factRerank. Default OFF:
  // it reshapes the real comment output, so it ships dark for a shadow eval.
  get factGrounding(): boolean {
    return env("ENGAGER_FACT_GROUNDING", "off") === "on";
  },
  // The embedder-free STRUCTURAL path inside checkDiversity (openingSignature
  // collision OR trigram-cosine). Default ON; `ENGAGER_STRUCTURAL_DIVERSITY=off`
  // is the fast org-wide off-switch if a bad signature/threshold over-rejects.
  structuralDiversity: env("ENGAGER_STRUCTURAL_DIVERSITY", "on") !== "off",
  // Post-aware promo fit: when ON, a post the filter flags as an inappropriate context
  // for promotion (grief / layoff / loss / raw personal) downgrades promo→neutral
  // (never upgrades). Default OFF — behavior-additive, ships gated + revertible. A getter
  // (like leadRanker) so the env can be toggled at runtime / in tests, not frozen at import.
  get promoFit(): boolean {
    return env("ENGAGER_PROMO_FIT", "off") === "on";
  },
  // Per-post adaptive length ("auto" tone.length + legacy unset rows). Default ON;
  // `ENGAGER_AUTO_LENGTH=off` restores the legacy fixed-short resolution exactly.
  // A getter so tests/ops can toggle at runtime.
  get autoLength(): boolean {
    return env("ENGAGER_AUTO_LENGTH", "on") !== "off";
  },
  // Author-impact enrichment + ranking (per-campaign author_targeting is the real
  // gate — the default "any" already opts out). Ops kill switch: =off stops the
  // enrich_authors job AND the ranking boost without touching campaign config.
  get authorImpact(): boolean {
    return env("ENGAGER_AUTHOR_IMPACT", "on") !== "off";
  },
  // Per-request timeout for a web-search-augmented writer call. Much longer than the
  // 30s plain-call ceiling would allow inside the 45s serverless job budget — 25s
  // leaves room for the fail-open fallback write when search hangs.
  get webSearchTimeoutMs(): number {
    return envInt("ENGAGER_WEB_SEARCH_TIMEOUT_MS", 25_000);
  },
  // One redraft retry when the slop gate rejects (violations fed back to the writer).
  // Bounded at 1 extra writer+judge call; no extra credit charge. Default ON;
  // `ENGAGER_SLOP_RETRY=off` restores single-attempt drop behavior.
  get slopRetry(): boolean {
    return env("ENGAGER_SLOP_RETRY", "on") !== "off";
  },
  // Hard-reject client-submitted drafts (draft submission/submit_draft) that fail the
  // deterministic slop lint (markdown/URL invariants, stop-slop AI-tell patterns,
  // and the gateable register rules). Per-item, machine-readable violations — the
  // agent redrafts. Default ON; `ENGAGER_INTAKE_SLOP_GATE=off` degrades to
  // warnings-only (the pre-gate behavior) if the gate misfires on real drafts.
  get intakeSlopGate(): boolean {
    return env("ENGAGER_INTAKE_SLOP_GATE", "on") !== "off";
  },
  // Legacy web onboarding wizard. Default OFF (agent-first posture): the route
  // /organizations/[slug]/onboarding renders the agent-first MCP setup page —
  // connector guide + live setup progress + a "continue in your agent" prompt —
  // and every post-signup / post-checkout / post-LinkedIn redirect lands there.
  // `ENGAGER_WEB_ONBOARDING=on` restores the full multi-step web wizard on the
  // same route; nothing else changes (MCP tools, redirects, and the paywall gate
  // are unaffected). A getter so the env can be toggled at runtime / in tests.
  get webOnboardingWizard(): boolean {
    return env("ENGAGER_WEB_ONBOARDING", "off") === "on";
  },
  // Curated candidate pool. Default ON: the agent triages discovered posts (match/
  // reject) so Candidates shows relevance-vetted matches and the draft lane pops from
  // them. Kill switch (`ENGAGER_POOL_CURATION=off`) makes the runner-facing surfaces
  // revert to the pre-curation behavior — the work order emits no triage, prepared tasks
  // returns nothing, and people list ignores matchedOnly (returns the whole ranked
  // 'new' pool) so the draft lane never starves regardless of the switch.
  get poolCuration(): boolean {
    return env("ENGAGER_POOL_CURATION", "on") !== "off";
  },
  // BetScore lead ranking. GRANULAR kill switch, default OFF (byte-identical to the
  // pre-feature FIFO behavior). `ENGAGER_LEAD_RANKER` is the master toggle; the two
  // gates can also be disabled independently so a bad Gate-1 admission gate doesn't
  // keep starving the writer after Gate-2 reordering is reverted (and vice-versa):
  //   ENGAGER_LEAD_RANKER=1            → both gates on
  //   ENGAGER_LEAD_RANKER=gate1        → admission only
  //   ENGAGER_LEAD_RANKER=gate2        → DEPRECATED: the post-best-eligible swap was
  //                                      removed (post ordering is owned by the slot
  //                                      plan; the flag still turns betScore compute on)
  //   ENGAGER_LEAD_RANKER=0 / unset    → both off (current behavior)
  // betScore is still COMPUTED + persisted whenever the master toggle is on (for
  // observability) even when a specific gate is disabled — only the gate's effect
  // on drafting/posting order is suppressed.
  leadRanker: {
    /** Master toggle: false ⇒ no betScore compute, no gates (pre-feature behavior). */
    get enabled(): boolean {
      return parseLeadRanker(env("ENGAGER_LEAD_RANKER")).enabled;
    },
    /** Gate 1 (draft admission) active. */
    get gate1(): boolean {
      return parseLeadRanker(env("ENGAGER_LEAD_RANKER")).gate1;
    },
    /** Gate 2 (post-best-eligible reordering) active. */
    get gate2(): boolean {
      return parseLeadRanker(env("ENGAGER_LEAD_RANKER")).gate2;
    },
  },


  // Demand-aware discovery. Default ON: each scheduled sweep first checks the
  // campaign's candidate-pool health (candidatePool.size vs target, which derives
  // from dailyCap × horizon) and scales the number of sources swept — 0 when the
  // pool is saturated (also skips Haiku enrichment), 1 keep-warm when healthy,
  // TERMS_PER_RUN normally, boosted when thin or decaying. The hourly provider
  // budget stays the hard ceiling. `ENGAGER_SMART_DISCOVERY=off` reverts to the
  // fixed TERMS_PER_RUN sweep (byte-identical). Getter so tests can toggle it.
  get smartDiscovery(): boolean {
    return env("ENGAGER_SMART_DISCOVERY", "on") !== "off";
  },

  // Question-rate cap (writer-variety): when the recent org-wide window of comments
  // already skews too heavily to questions, bias the next draft AWAY from a question
  // opener / "ask" stance so the feed stops collapsing to "so what do you think?". The
  // value is the SHARE threshold (0..1) — e.g. `ENGAGER_QUESTION_CAP=0.4` biases away
  // once >40% of recent comments end in a question. Unset/invalid = disabled (no
  // biasing, byte-identical), so it ships dark for a shadow eval.
  get questionCap(): number | null {
    const raw = env("ENGAGER_QUESTION_CAP");
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 && n < 1 ? n : null;
  },

  // ---- client-drafting batch model (AI-native path) -------------------------
  // Abuse guard on the client submit path, which is unmetered by Engager but still
  // consumes the customer's model-provider allowance/API spend: max client-authored
  // drafts accepted per org per rolling day. 0 = no Engager intake cap (default).
  get mcpSubmitsPerDay(): number {
    return envInt("ENGAGER_MCP_SUBMITS_PER_DAY", 0);
  },

  // Per-job wall-clock budget for the SERVERLESS drain only. The Vercel drain route
  // caps the function at maxDuration=60s; without a per-job budget a single slow job
  // runs uncapped toward that kill, so the phase-2 complete/fail bookkeeping never
  // runs and the row is orphaned in `running`. Default 45s: comfortably under both
  // the 60s function limit and LEASE_MS (5min). The es2 continuous runLoop does NOT
  // pass this (it's the uncapped long-job drainer), so only the drain is time-boxed.
  get jobTimeoutMs(): number {
    return envInt("ENGAGER_JOB_TIMEOUT_MS", 45_000);
  },

  // Jittered pacing bases for recurring provider reads (claimPacedRun draws
  // uniform [0.7, 1.3]× these). Fixed-interval polling is a documented
  // LinkedIn automation detection signal — shorten these only deliberately.
  get pollIncomingBaseMs(): number {
    return envInt("ENGAGER_POLL_INCOMING_BASE_MIN", 45) * 60_000;
  },
  get discoverBaseMs(): number {
    return envInt("ENGAGER_DISCOVER_BASE_MIN", 35) * 60_000;
  },

  // Engagement monitor (comment_watches): how long a posted comment is watched
  // for replies/reactions, when a quiet watch retires early, and how many due
  // watches one monitor run drills into. (ENGAGER_THREAD_INTAKE is GONE:
  // detected thread replies always land status='new'; the campaign's Reply
  // mode — not an env flag — decides whether anything drafts against them.)
  get watchTtlMs(): number {
    return envInt("ENGAGER_WATCH_TTL_DAYS", 12) * 86_400_000;
  },
  get watchQuietMax(): number {
    return envInt("ENGAGER_WATCH_QUIET_MAX", 10);
  },
  get monitorBatch(): number {
    return envInt("ENGAGER_MONITOR_BATCH", 6);
  },
  // Max replies WE post into one thread (anti-ping-pong: the other party may be
  // an AI too, and an endless mutual thread is its own bot signature).
  get threadReplyDepthCap(): number {
    return envInt("ENGAGER_THREAD_REPLY_DEPTH_CAP", 2);
  },

  // Every customer-facing link resolves here. There is no second service
  // origin to confuse it with: the public-api deployment `ENGAGER_APP_URL`
  // addressed is gone, and so is the getter that read it.
  dashboardUrl: (path = "/") => dashboardUrl(path),

  driver:
    (env("ENGAGER_DRIVER", "mock") as "mock" | "browser-use") ??
    "mock",
  /** The single org the local runtime acts for (`npm run mcp`, worker,
   *  scheduler). Also what binds the browser-use driver to exactly one org:
   *  the browser session is ONE LinkedIn account, and only this org may
   *  resolve it. */
  organizationId: () => env("ENGAGER_ORG_ID"),
  browserUse: {
    profileDir: () => env("ENGAGER_BROWSER_PROFILE_DIR"),
    /** Engager's own downloaded Chromium (US-OND-04); unset leaves the
     *  sidecar to find the installed build under ~/.engager/browser. */
    executable: () => env("ENGAGER_BROWSER_EXECUTABLE"),
    // Live write authority moved to the channel row (`writes_enabled`),
    // flipped only by the dashboard's write switch — the runtime no
    // longer consults ENGAGER_BROWSER_WRITES, and `engager doctor` warns when
    // it is still set. The doctrine the env var carried lives on the column:
    // DEFAULT OFF, never enabled by inference.
    /**
     * How long an idle sidecar keeps the browser profile before exiting and
     * handing it back. 0 (the default) holds it for the life of the process.
     *
     * A profile has ONE holder — the python journal takes a non-blocking flock
     * — and the two processes that want it want opposite things. The job
     * worker runs a sweep as browser → model → browser, with minutes of
     * inference in between: hand the profile back in that gap and the next
     * step has to cold-start Chrome, which is exactly the 30s
     * `BrowserStartEvent` timeout a discover run died on. The INTERACTIVE MCP
     * server is the opposite — it probes once at setup and then sits idle for
     * as long as the dashboard is open, starving the worker. So the holder
     * that must yield sets this (the dashboard does, for its chat MCP child);
     * the worker leaves it at 0 and stays what CLAUDE.md calls it: the one
     * browser-profile holder.
     */
    idleReleaseMs: () => {
      const raw = Number(env("ENGAGER_BROWSER_IDLE_RELEASE_MS"));
      return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
    },
    /**
     * Whether the sidecar hides its headed Chrome from the screen (macOS app
     * hide; the default). Normalized to "true"/"false" for the bridge argv —
     * the default itself lives in the python backend, the one place that
     * decides launch behavior. Unset stays unset so the child's default rules.
     */
    hidden: () => {
      const raw = env("ENGAGER_BROWSER_HIDDEN")?.trim().toLowerCase();
      if (!raw) return undefined;
      return raw === "false" ? ("false" as const) : ("true" as const);
    },
    /**
     * Whether this process may route browser work through the standing
     * bridge (the agent's loopback HTTP holder) when one is reachable.
     * "off" forces every process back to its own subprocess sidecar — the
     * dev/debug escape hatch, not a mode.
     */
    bridgeEnabled: () =>
      env("ENGAGER_BROWSER_BRIDGE")?.trim().toLowerCase() !== "off",
    /** The bridge's preferred loopback port. 8788 is the standalone MCP, 8789
     *  the chat MCP child; the browser holder is their neighbor, and takes a
     *  free port instead when another program holds this one. */
    bridgePort: () => {
      const raw = Number(env("ENGAGER_BROWSER_BRIDGE_PORT"));
      // 0 is a real answer — bind an ephemeral port (test isolation).
      return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 8790;
    },
    /**
     * Where the agent answers a READINESS probe, beside the loopback bridge
     * and carrying none of its authority: no token, no profile directory, no
     * org data, and a bare 404 for every path but `GET /health`.
     *
     * Set only in the tenant container, where the host resolves to
     * `fly-local-6pn` — Fly's private network — so the probe is reachable by
     * the platform and by nothing on the public internet. Unset on every
     * install that exists today, which means no second listener at all.
     */
    healthHost: () => env("ENGAGER_AGENT_HEALTH_HOST"),
    healthPort: () => {
      const raw = Number(env("ENGAGER_AGENT_HEALTH_PORT"));
      // 0 is a real answer — bind an ephemeral port (test isolation).
      return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : undefined;
    },
  },
} as const;
