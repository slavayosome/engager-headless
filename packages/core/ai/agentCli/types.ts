/** IDs are admitted through the reviewed adapter registry, never command
 * templates. A new adapter does not require a domain or dashboard union edit. */
export type AgentCliId = string;

/** One provider-neutral inference request. Deliberately the same shape the
 *  `LLM` interface already speaks (single user turn, optional system), because
 *  every call site in the codebase is built on that and must not change. */
export type AgentCliRequest = {
  /** The model to ask for: an id — or a shorthand the CLI accepts — that this
   *  agent's support-matrix entry declares. `AgentCliLLM` refuses one it does
   *  not before a request is ever built, so `buildArgs` may emit this verbatim,
   *  and must emit it in EVERY request shape the adapter declares it serves —
   *  `agentCli.test.ts` builds that sweep out of the declarations below. */
  model: string;
  system?: string | undefined;
  user: string;
  /** When present the agent MUST return an object validating against it. */
  jsonSchema?: Record<string, unknown> | undefined;
  /** Allow the agent's own web-search tool for this call. */
  webSearch?: boolean | undefined;
  /** A look-up on the public web the owner asked for: the call carries their
   *  question and nothing Engager read, and gets the agent's web search and
   *  page fetch and no other tool. Refused for an agent that declares no
   *  `supportsWebResearch`. */
  webResearch?: boolean | undefined;
  /** Private file prepared by the executor, never an owner-supplied path. */
  schemaFile?: string | undefined;
  requestDirectory?: string | undefined;
  frozenSelection?: ResolvedAgentSelection | undefined;
  /**
   * A bounded connection check for a candidate that is NOT the active
   * selection. The executor skips the "is this still the stored revision"
   * comparison for such a request, because the whole point of a preflight is
   * to find out whether a configuration works WITHOUT overwriting the working
   * one first. Set only by the picker's own operation; it carries no
   * authority, since the request is still built, validated and spawned by the
   * server.
   */
  preflight?: boolean | undefined;
  /** A lighter level a short structured step asks for: taken only where the
   *  owner chose no effort for this model and the installation listed this
   *  level for it, so it never overrides the owner or reaches a CLI that
   *  cannot take it. */
  stageEffort?: string | undefined;
  requestId?: string | undefined;
  organizationId?: string | undefined;
  runId?: string | undefined;
};

/** Token counts, when the agent reports them. All optional: an agent that
 *  tells us nothing still works, it just records no local usage row. */
export type AgentCliUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  webSearchRequests?: number;
  costUsd?: number;
};

export type AgentCliResult = {
  /** Free text answer (empty string when the call was schema-only). */
  text: string;
  /** Parsed object when `jsonSchema` was requested and the agent honoured it. */
  structured?: unknown;
  usage: AgentCliUsage;
  actualReportedModel?: string | undefined;
  requestId?: string | undefined;
  adapterVersion?: string | undefined;
  terminalState?: "completed" | undefined;
};

export type AgentPurpose = "background" | "chat";

/** The checks Codex's sandbox self-test runs (`codexSelfTest.ts`), named in
 *  the refusal `isolation_unverified:codex_sandbox:<check>`. */
export type CodexSelfTestCheck =
  | "control"
  | "read_outside"
  | "symlink_out"
  | "traversal"
  | "write_workspace"
  | "write_outside"
  | "network"
  | "network_control"
  | "judgment_profile"
  | "features";
/**
 * The contract version each registered adapter's descriptor declares, readable
 * WITHOUT the adapter. The role resolution (`installedRoleModels`) has to bind
 * the installation's model list to the contract execution would run under, and
 * it stands in a leaf the adapters import back (`claudeChat` reads `roleModels`),
 * so it cannot reach `ADAPTERS`. Like the support matrix's `conformanceVersions`,
 * this is pinned to the descriptors by `registry.test.ts` rather than computed
 * from them; an id missing here has no contract to bind, so no list for it can
 * drive a substitution or a refusal.
 */
export const ADAPTER_CONTRACT_VERSIONS: Readonly<Record<string, string>> =
  Object.freeze({ claude: "1", codex: "1", gemini: "1", opencode: "1" });

export type LocalAgentDescriptor = {
  adapterId: string;
  adapterContractVersion: string;
  supportedExecutableVersions: readonly string[];
  /**
   * Admit this version and every later one, on top of the exact list. Only for
   * an adapter whose isolation is verified against the binary in front of it
   * rather than against a version list — Claude's `--help` flag check plus
   * managed-settings refusal at run time, Codex's sandbox proof recorded per
   * binary hash (`codexProof.ts`) — so a vendor auto-update is checked rather
   * than locked out. Dotted numeric versions only; anything else is never
   * admitted by it.
   */
  minimumExecutableVersion?: string | undefined;
  background: {
    text: boolean;
    structured: "native_schema" | "validated_json" | "none";
  };
  /** Declared chat transport, independent of background and native validation. */
  chat: {
    transport: "legacy_cli" | "pending_broker" | "broker";
    events: boolean;
    textDeltas: boolean;
    brokerTools: boolean;
    resumable: "canonical_history";
  };
  isolationProfileVersion: string;
  supportedAuthRoutes: readonly string[];
  supportedModelRoutes: readonly {
    providerRef: string;
    models: readonly string[];
    authRoutes?: readonly string[];
  }[];
  /**
   * Where this agent's executable may legally be found. Discovery reads THIS
   * rather than deriving a filename from the adapter id: the roots are a
   * property of how the agent is installed, and a discovery-only entry can
   * carry one without an execution adapter behind it.
   */
  discovery: AdapterDiscoveryDescriptor;
};

/** The bounded set of places one adapter's executable is looked for. Every
 *  entry is an absolute or `~`-rooted directory; nothing here walks the disk,
 *  sources a shell startup file, or runs a login shell to learn PATH. */
export type AdapterDiscoveryDescriptor = {
  /** Executable basenames, most canonical first. */
  executables: readonly string[];
  /** Extra directories, searched after §5's standard installation roots. */
  directories?: readonly string[];
  /** CLI locations inside a supported app bundle, relative to the bundle root
   *  — so a Finder launch reaches the agent the desktop app installed. */
  bundlePaths?: readonly string[];
};

/**
 * What adapter-owned metadata inspection may do. Each entry states a route the
 * adapter OWNS — its own protocol, argv and parser — because §6's order
 * (native list, then local catalog or configured model, then a manual id) is a
 * property of the agent, not of the picker. An adapter with no list protocol
 * says so here rather than inventing one.
 */
export type AdapterMetadataDescriptor = {
  /** The adapter's supported model-list protocol, where one exists. */
  listModels?: (context: ModelMetadataContext) => Promise<ModelListResult>;
  /** A narrowly scoped, non-secret configured/default model. */
  configuredModel?: (
    context: ModelMetadataContext,
  ) => Promise<string | undefined>;
  /** Why no list route exists, in the owner's words. Present is the honest
   *  fallback §6 requires; absent with no `listModels` means unsupported. */
  listUnsupported?: string;
  /** Whether the list route reaches the provider over the network, so the
   *  picker can disclose it on Refresh. */
  network: boolean;
  /** Whether the list route runs the executable against the OWNER'S OWN agent
   *  home — their real credentials and configuration — rather than the probe's
   *  private profile. It is the only thing that makes a metadata read
   *  inference-adjacent, so a route that does it is admitted exactly as
   *  execution is: the declared version AND the isolation verifier. An
   *  installation that fails either is never spawned against that store
   *  (R-10), and its picker falls back to the configured id and manual
   *  entry. */
  readsOwnerAuthStore?: boolean;
};

/** What a metadata probe is told. It receives no caller-supplied argv, no
 *  environment map and no credential: the adapter builds its own invocation
 *  from the executable it was handed and the private profile beside it. */
export type ModelMetadataContext = {
  /** The exact executable discovery resolved and hashed. */
  absoluteExecutable: string;
  observedVersion: string;
  /** The auth route the owner selected, when one is already stored. */
  authRoute?: string | undefined;
  /** The provider this catalog is being read for, when already known. */
  providerRef?: string | undefined;
  /** The profile root the selected auth route uses, when one is stored — so a
   *  reader that must inspect an account-specific catalog reads the account the
   *  selection actually names and no other. */
  authStorePath?: string | undefined;
  signal: AbortSignal;
};

/** One entry a list protocol reported, before normalization. An adapter emits
 *  this raw fact; the catalog layer decides labels, providers and certainty,
 *  so no adapter can mint an option shape the rest of the system must trust. */
export type ReportedModel = {
  id: string;
  label?: string | undefined;
  reportedDefault?: boolean | undefined;
  /** Effort / reasoning levels the installation says this model accepts, in
   *  its own order. Absent or empty = the model takes no effort setting. */
  efforts?: readonly string[] | undefined;
  /** The level the installation uses when none is asked for, if it says. */
  defaultEffort?: string | undefined;
};

export type ModelListResult = {
  models: readonly ReportedModel[];
  /** Where the list came from, in the owner's words — shown on Refresh. */
  source: string;
  /** Provider/profile the list is bound to, when the protocol reports one. */
  providerRef?: string | undefined;
  /** The protocol's own default/configured model, when it reports one. */
  reportedDefault?: string | undefined;
  /** Whether the protocol reported more entries than it returned. A bounded
   *  page that stopped early says so rather than claiming a complete catalog. */
  partial?: boolean | undefined;
};

/**
 * One installation discovery found, as the browser receives it. The absolute
 * path is deliberately absent: the picker works from the opaque candidate id,
 * and the server resolves that id back to a path it discovered itself — which
 * is what stops a request from nominating an arbitrary executable.
 */
export type AgentInstallation = {
  /** Deterministic `sha256(realPath)` prefix. Opaque, stable across scans. */
  candidateId: string;
  adapterId: string;
  displayName: string;
  observedVersion: string;
  /** The adapter's `minimumExecutableVersion`, when it admits by minimum, so
   *  a refusal can name what to update to. */
  minimumVersion?: string | undefined;
  /** Whether an installed adapter may serve chat and/or background inference. */
  chatEligible: boolean;
  backgroundEligible: boolean;
  /** The auth routes this adapter declares, for the picker's Advanced control.
   *  Registry facts about the ADAPTER, not evidence about the account. */
  authRoutes: readonly string[];
  /** Safe codes: `agent_version_unsupported`, `isolation_unverified`,
   *  `discovery_only`, `agent_inspection_failed`, … */
  reasonCodes: readonly string[];
  authStatus: AgentConnectionStatus;
  /** Where it was found (`PATH`, `homebrew`, `app_bundle`, …), for the owner
   *  who has two of the same version and needs to tell them apart. */
  location: string;
  discoveredAt: number;
};

export type AgentConnectionStatus =
  | "unknown"
  | "signed_out"
  | "signed_in"
  | "unavailable";

/** What one scan knows: the inventory, and whether it was cut short. A partial
 *  scan is a normal answer — one hung agent must not withhold the others. */
export type AgentInventory = {
  installations: readonly AgentInstallation[];
  /** Every adapter Engager can drive, whether or not it was found — so an
   *  empty screen can say what to install instead of only what is missing.
   *  Registry facts, never a scan result. */
  supported: readonly AgentInstallHint[];
  scannedAt: number;
  /** The scan hit its overall deadline; the list is what finished in time. */
  partial: boolean;
  /** Codes for agents that could not be probed at all. */
  warnings: readonly string[];
};

/** One agent the owner could install, with the vendor's own documented
 *  command and page. Presentation copy carried by the adapter registry — not
 *  a second capability registry, and never evidence that anything is
 *  installed. */
export type AgentInstallHint = {
  adapterId: string;
  displayName: string;
  installCommand: string;
  installUrl: string;
};

/**
 * One model the selected installation reported. `id` is the exact string the
 *  executor would be asked for; a display label never substitutes for it.
 *
 * What this does NOT carry is whether the id may be USED. That is a different
 * question, asked of the adapter's routes and the selected auth route, and it
 * has one answer per (adapter, auth route) rather than one per catalog — so it
 * is derived by `modelEligibility` at the point of display or save. A field
 * here would be a second copy of that answer, computed against a catalog that
 * was still being built, and it would change the catalog's own fingerprint
 * every time the route changed.
 */
export type NormalizedModelOption = {
  id: string;
  label: string;
  providerRef: string;
  reportedDefault?: boolean | undefined;
  /** See `ReportedModel.efforts`: only ever what the installation listed. */
  efforts?: string[] | undefined;
  defaultEffort?: string | undefined;
  /** `listed` = the protocol named it; `configured` = read from the agent's
   *  own configuration; `manual` = the owner typed it and nothing verified it. */
  certainty: "listed" | "configured" | "manual";
};

/** One option as the picker renders it: what the installation reported, plus
 *  whether this install's route admits it, and why not when it does not. */
export type EligibleModelOption = NormalizedModelOption & {
  eligible: boolean;
  reasonCode?: string | undefined;
};

/**
 * A model catalog bound to exactly what produced it. The binding is the point:
 * a list read for one executable/contract/provider must not authorize a model
 * for another, and the revision is what a concurrent save is checked against.
 */
export type AgentModelCatalog = {
  adapterId: string;
  providerRef: string;
  executableIdentity: string;
  observedVersion: string;
  adapterContractVersion: string;
  authRoute: string;
  /** The profile root this catalog was read under, when the selection named
   *  one. Part of the binding: the same binary on two accounts is two lists. */
  authStorePath?: string | undefined;
  /** New per successful read; a save compares it and refuses a stale one. */
  revision: string;
  fetchedAt: number;
  source: string;
  /** True when the route has no list protocol at all — `options` is then the
   *  configured/manual fallback, not a catalog. */
  listUnsupported: boolean;
  partial: boolean;
  /** True when this is the last known answer kept because a refresh failed:
   *  the age and the error say what happened, and the options still describe
   *  the same executable and revision. */
  stale?: boolean | undefined;
  /** Mutable on purpose: one normalization pass rewrites the reported default
   *  onto the option it names. */
  options: NormalizedModelOption[];
  /** Set only when the read itself failed; a stale catalog keeps its age. */
  error?: string | undefined;
};

/** What the picker asks the server to save. No argv, environment map, proof
 *  record or secret crosses this boundary — the server resolves the candidate
 *  itself and rebuilds every field it persists. */
export type AgentSelectionRequest = {
  candidateId: string;
  catalogRevision: string;
  modelId: string;
  /** One of the chosen option's `efforts`, or absent for the agent default. */
  effort?: string | undefined;
  authRoute: string;
  /** Which purposes this one choice is for. A fresh shared choice names both
   *  and is validated before ONE mutation; an explicit split names one. */
  purposes: readonly AgentPurpose[];
  /** The roles to persist. A role whose purpose this request does not name is
   *  refused rather than written. */
  roles: Readonly<Record<string, string>>;
  /** The state revision the caller read; a concurrent change is a conflict. */
  expectedConfigurationRevision: string;
};

/** Chat and background readiness are reported separately, because they fail
 *  separately: an install whose agent serves chat and no background role keeps
 *  a working conversation and a refused worker. */
export type AgentReadinessState =
  | "unconfigured"
  | "checking"
  | "configured"
  | "verified"
  | "action_required";

export type AgentReadiness = {
  chat: AgentReadinessState;
  background: AgentReadinessState;
  /** Safe actionable codes, never subprocess output or machine paths. */
  reasonCodes: readonly string[];
  checkedAt: number;
};

/** No credentials or arbitrary config snippets belong in this persisted shape. */
export type ResolvedAgentSelection = {
  purpose: AgentPurpose;
  absoluteExecutable: string;
  realPath: string;
  executableIdentity: string;
  observedVersion: string;
  adapterId: string;
  modelRef: string;
  /** RUN-TIME ONLY, never persisted: `run.ts` fills it from the effort sidecar
   *  (`effort.ts`) on the frozen copy it hands the adapter, and only when the
   *  call asks for the model the effort was saved with. A stored selection
   *  never carries it — `selectionSchema` is strict and versioned. */
  effort?: string | undefined;
  providerRef: string;
  authRoute: string;
  authStorePath?: string | undefined;
  configRevision: string;
  capabilityEvidence: string[];
  missingCapabilities: string[];
};

export type AgentEvent =
  | { kind: "started"; requestId: string; adapterId: string }
  | { kind: "progress"; requestId: string }
  | { kind: "text_delta"; requestId: string; text: string }
  | { kind: "usage"; requestId: string; usage: AgentCliUsage }
  | { kind: "result"; requestId: string; result: AgentCliResult }
  | { kind: "failure" | "canceled"; requestId: string; code: string };

/**
 * What an agent must be able to do before it can back Engager's own background
 * inference. Every member is something the `json()` calls behind discovery
 * enrichment, Brain seeding, product ingest and drafting cannot be served
 * without, so an agent missing one is refused at selection rather than at the
 * first structured call.
 */
export const BACKGROUND_SURFACE = ["jsonSchema"] as const;

export type BackgroundCapability = (typeof BACKGROUND_SURFACE)[number];

/**
 * One normalized event from a streaming chat turn. It lives here rather than in
 * the dashboard because the parsers that emit it are agent-specific and live
 * beside their adapters; what stays dashboard is the translation from this
 * union into AI-SDK chunks, which knows no agent at all.
 */
export type ChatDriverEvent =
  | {
      kind: "agent-report";
      adapterId: string;
      requestedModel: string;
      actualReportedModel: string | null;
      usage: AgentCliUsage | null;
      streamMode: "events";
    }
  | { kind: "final-text"; id: string; text: string }
  | { kind: "session"; sessionId: string }
  | { kind: "text-start"; id: string }
  | { kind: "text-delta"; id: string; delta: string }
  | { kind: "text-end"; id: string }
  | { kind: "reasoning-start"; id: string }
  | { kind: "reasoning-delta"; id: string; delta: string }
  | { kind: "reasoning-end"; id: string }
  | { kind: "tool-start"; toolCallId: string; toolName: string }
  | { kind: "tool-input-delta"; toolCallId: string; delta: string }
  | { kind: "tool-input"; toolCallId: string; toolName: string; input: unknown }
  | {
      kind: "tool-output";
      toolCallId: string;
      toolName: string;
      output: unknown;
      isError: boolean;
    }
  | { kind: "step-start" }
  | { kind: "step-end" }
  | {
      kind: "result";
      isError: boolean;
      errorText?: string;
      usage?: { costUsd?: number; numTurns?: number; durationMs?: number };
    };

/** One chat turn's spawn inputs. The session store and the MCP child are the
 *  dashboard's, so it decides every field here; the surface only turns them
 *  into its own agent's argv. */
export type ChatSpawnOpts = {
  /** The agent session this turn belongs to. The caller mints it, because the
   *  caller is the side that has to persist it. */
  sessionId: string;
  /** Whether `sessionId` names a session the agent already holds. */
  resume: boolean;
  userText: string;
  /** Inline JSON for the agent's MCP config; omitted = no MCP servers. */
  mcpConfig?: string | undefined;
  /** Tools the turn may call (a bare server name allows all its tools). */
  allowedTools?: readonly string[] | undefined;
  systemPromptSuffix?: string | undefined;
  /** Overrides whatever model the surface would otherwise ask for. */
  model?: string | undefined;
  /** What this turn may spend of the owner's subscription. Required, and
   *  deliberately not defaulted here: a surface that fell back to a number of
   *  its own would be core setting the ceiling, and the ceiling belongs to the
   *  surface doing the spending. */
  maxBudgetUsd: number;
};

/** Stateful translator from one agent's stream format into `ChatDriverEvent`s.
 *  One instance per turn: implementations carry per-turn block state. */
export interface ChatStreamParser {
  push(line: string): ChatDriverEvent[];
  /** Whether the agent reported its own end-of-turn result. A stream that ends
   *  without one ended unexpectedly, and the driver says so. */
  readonly sawResult: boolean;
}

/**
 * How an agent backs the dashboard chat: a streaming, MCP-armed, resumable
 * conversational turn, where the background members below are one-shot and
 * tool-free. Optional, because an agent can serve background inference and no
 * chat — and chat selection reads this DECLARATION rather than the background
 * pin, so an owner who points background inference at another agent keeps the
 * chat they had.
 */
export interface AgentChatSurface {
  /** Executable to spawn for a chat turn; overridable via env. */
  bin(): string;
  /** The model a turn asks for when `ChatSpawnOpts.model` names none. Beside
   *  `bin()` because the Agent page reports both, and a surface that only
   *  emitted this one into argv would leave that page reading the env for
   *  itself — two statements of one default. */
  model(): string;
  /** argv after the binary. Never include the binary itself. */
  buildArgs(opts: ChatSpawnOpts): string[];
  /** A parser for exactly one turn's stream. */
  createParser(): ChatStreamParser;
  /** Env for the child. An allowlist — never a `process.env` spread. */
  spawnEnv(): NodeJS.ProcessEnv;
}

/**
 * Everything agent-specific lives behind this. An adapter never touches the
 * `LLM` interface, spend accounting, or job plumbing — it only knows how to
 * turn one request into argv, and one stdout into a result.
 */
export interface AgentCliAdapter {
  readonly id: AgentCliId;
  /** Display name for errors and setup copy (matches the support matrix). */
  readonly name: string;
  /** Whose models this agent actually reaches. Telemetry reads it rather than
   *  assuming one vendor, so a usage row never names a provider the call never
   *  travelled to. */
  readonly provider: string;
  /** The vendor's documented way to install this CLI, for the empty picker.
   *  Copy, not capability: finding nothing has to say what to install. */
  readonly install?: { command: string; url: string };
  readonly descriptor: LocalAgentDescriptor;
  /**
   * The adapter's own metadata routes — its model-list protocol and its
   * non-secret configured model. Optional because an agent can be perfectly
   * executable and expose neither, and §6's answer for that case is the
   * manual id entry rather than a fabricated list.
   */
  readonly metadata?: AdapterMetadataDescriptor;
  /** Executable to spawn; overridable per adapter via env. */
  bin(): string;
  /** Adapter-owned profile preparation inside the executor's private directory.
   * No domain caller supplies config, environment or shell text. */
  prepareInvocation?(
    request: AgentCliRequest,
    env: NodeJS.ProcessEnv,
  ): Promise<{
    env: NodeJS.ProcessEnv;
    input: string;
  }>;
  /** The isolation boundary. `options.signal` is how a bounded caller — an
   *  inventory that hit its budget, a canceled connection check — tears down
   *  the native probes instead of waiting each one out. */
  verifyIsolation?(
    selection: ResolvedAgentSelection,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<void>;
  readonly executableOverrideEnv?: string;
  /** Whether this agent supports schema-constrained output — the authority for
   *  `jsonSchema` in `BACKGROUND_SURFACE`, declared here beside the argv code
   *  that makes it true. Selection reads it and the support matrix is pinned to
   *  it; `registry.test.ts` holds every other source file to reading the
   *  answer rather than stating one of its own. */
  readonly supportsJsonSchema: boolean;
  /** Whether this agent can run a web search as part of the turn. */
  readonly supportsWebSearch: boolean;
  /** Whether this agent can run a web-only call (`webResearch`): its argv
   *  gives the call the web tools and keeps every other tool off. */
  readonly supportsWebResearch?: boolean;
  /** argv after the binary. Never include the binary itself. */
  buildArgs(request: AgentCliRequest): string[];
  /** Parse the process stdout into a result, or throw for a malformed reply. */
  parseResult(stdout: string): AgentCliResult;
  /** Reject forbidden native events before a later final result. */
  inspectOutputLine?(line: string): void;
  /** How this agent backs the dashboard chat, when it can at all. Absent means
   *  it cannot, and chat selection passes over it. */
  readonly chat?: AgentChatSurface;
}

/** An adapter that declares a chat surface. Chat resolution returns this, so
 *  the driver reaches the surface with no non-null assertion at any call site. */
export type ChatCapableAdapter = AgentCliAdapter & {
  readonly chat: AgentChatSurface;
};

function dottedVersion(value: string): number[] | undefined {
  if (!/^\d+(?:\.\d+)*$/.test(value)) return undefined;
  return value.split(".").map(Number);
}

/** Negative, zero or positive as `a` is older than, equal to or newer than
 *  `b`; undefined when either is not a dotted numeric version. */
export function compareExecutableVersions(
  a: string,
  b: string,
): number | undefined {
  const left = dottedVersion(a);
  const right = dottedVersion(b);
  if (!left || !right) return undefined;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The one version-admission question, asked by discovery and by selection
 *  alike: the exact list, or at/after `minimumExecutableVersion`. */
export function executableVersionSupported(
  descriptor: Pick<
    LocalAgentDescriptor,
    "supportedExecutableVersions" | "minimumExecutableVersion"
  >,
  observedVersion: string,
): boolean {
  if (!observedVersion) return false;
  if (descriptor.supportedExecutableVersions.includes(observedVersion))
    return true;
  if (!descriptor.minimumExecutableVersion) return false;
  const order = compareExecutableVersions(
    observedVersion,
    descriptor.minimumExecutableVersion,
  );
  return order !== undefined && order >= 0;
}

/** Each background capability: the adapter declaration that answers for it, and
 *  the words a refusal uses. An owner told "schema-constrained JSON output"
 *  learns what their agent lacks, where a field name would teach them nothing. */
const BACKGROUND_CAPABILITIES: Record<
  BackgroundCapability,
  { declaredBy: (adapter: AgentCliAdapter) => boolean; label: string }
> = {
  jsonSchema: {
    declaredBy: (adapter) => adapter.supportsJsonSchema,
    label: "schema-constrained JSON output",
  },
};

/**
 * What this adapter cannot serve of the background surface, named as a refusal
 * names it; empty means it covers the whole surface. Both AUTO selection and
 * the support matrix are pinned to this one question, so neither restates the
 * answer for itself.
 */
export function missingBackgroundCapabilities(
  adapter: AgentCliAdapter,
): string[] {
  return BACKGROUND_SURFACE.filter(
    (capability) => !BACKGROUND_CAPABILITIES[capability].declaredBy(adapter),
  ).map((capability) => BACKGROUND_CAPABILITIES[capability].label);
}

/** One background role, the model it resolves to, and whether anything admits
 *  that model on this installation's route — the list the installed agent
 *  reported, the selection's admission record, or the adapter's declared
 *  vocabulary. `declared` is the WIRE name every reader of `SetupState.agent`
 *  already parses, so it stays; the question behind it is the admission one a
 *  call asks. `role` is a key of `config.models` (filter | writer |
 *  writerPremium today) rather than a vocabulary of its own: the probe reads
 *  the roles off that object, so a fourth one reports without a second list to
 *  maintain. */
export type AgentRoleModel = {
  role: string;
  model: string;
  declared: boolean;
  /** Present only when the installation does not offer the model this role was
   *  configured with: that id, while `model` is what the role runs in its place. */
  configured?: string;
};

/** A role whose configured model its installation does not offer, and the
 *  model the role runs instead. */
export type UnofferedRoleModel = { configured: string; using: string };

/**
 * What the read-only probe reports about BACKGROUND inference: which adapter
 * selection resolves, whether its binary is actually on the machine, what it
 * can do, and — when selection refuses — the refusal itself.
 *
 * Declared here rather than beside the probe because it is a WIRE shape:
 * `SetupState.agent` is this type, so `get_status` carries it verbatim to
 * every skill that reads it, and a second statement of these fields on the
 * operations side is precisely how the two would drift.
 *
 * `id` is null exactly when `error` is set — there is no agent to name — and
 * `installed: false` then means "no agent at all" rather than "this one is
 * missing". Both readings route to the same place: install one, or fix the pin.
 */
export type AgentCliStatus = {
  id: AgentCliId | null;
  name: string | null;
  bin: string | null;
  installed: boolean;
  supportsJsonSchema: boolean;
  models: AgentRoleModel[];
  error?: string;
  /** Independently selected chat purpose; no authentication probe is implied. */
  chatSelection?: {
    adapterId: string;
    model: string;
    configRevision: string;
    transport: string;
    authStatus: "unknown";
    streamMode: "events";
  } | null;
  localExecution?: {
    configurationRevision: string;
    observedVersion: string;
    authRoute: string;
    authStatus: "unknown";
    isolationProfileAdmitted: boolean;
    background: LocalAgentDescriptor["background"];
    chat: LocalAgentDescriptor["chat"];
    nativeBrowser: false;
    providerValidation: "pending_R10";
  };
};

/** Thrown when the agent CLI itself fails — missing binary, non-zero exit,
 *  timeout, unparseable output. Distinct from a schema failure, which is the
 *  model's fault and surfaces as LLMOutputError like the API path. */
export class AgentCliError extends Error {
  constructor(
    message: string,
    readonly cause?: {
      code?: string | undefined;
      stderr?: string | undefined;
      /** When a `quota_exhausted` limit lifts, epoch ms, parsed from what
       *  the CLI printed (`usageLimit.ts`). The only thing kept of it. */
      resetsAt?: number | undefined;
      /** The actual adapter used by this attempt, attached by runAgentCli. */
      adapterId?: string | undefined;
    },
  ) {
    super(message);
    this.name = "AgentCliError";
  }
}
