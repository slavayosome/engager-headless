export type AgentSupportTier =
  | "supported"
  | "community"
  | "coming_soon"
  | "coming_later";
export type AgentCapability =
  | "supported"
  | "closed_beta"
  | "advanced"
  | "unsupported";

/**
 * One model an agent may be asked for, and what its tokens cost.
 */
export type AgentModel = {
  id: string;
  /**
   * Shorthands the agent's own CLI accepts for this model. The mechanism only,
   * for now: nothing declares one until the dashboard chat's `"sonnet"` joins
   * the table in Phase 9.
   */
  aliases?: readonly string[];
  /**
   * USD per MILLION tokens — the same unit `packages/core/ai/pricing.ts` bills
   * in, and that module reads this rather than a second table of agent models.
   *
   * ABSENT means vocabulary without a price: Engager accepts the id and refuses
   * everything outside the list, but has verified no hosted token price for it,
   * so `costMicros` yields null exactly as it does for any unpriced model. That
   * is the honest shape for an agent Engager only ever reaches through the
   * owner's own subscription, where no hosted price describes the call — and it
   * keeps "which ids are accepted" one question rather than two, which is what
   * a vocabulary the client enforces and the docs omit had made it.
   */
  price?: { inputPerM: number; outputPerM: number };
};

export type AgentSupportEntry = {
  id: string;
  name: string;
  clients: readonly string[];
  tier: AgentSupportTier;
  interactive: AgentCapability;
  unattendedRunner: AgentCapability;
  /**
   * Every model Engager may ask this agent for. One vocabulary, read by every
   * lane: the price table prices what carries a price here, the agent-CLI
   * client refuses a model that is not listed, and `docs/generated/support.md`
   * publishes the list to the owner who has to choose from it.
   *
   * An EMPTY list means Engager has verified no vocabulary for the agent — not
   * that it has none. Nothing is refused for such an agent (an unverified
   * adapter has no vocabulary to enforce, and its text calls must keep working
   * when the owner pins it). A listed model without a `price` is refused by
   * neither lane and priced by none: see `AgentModel.price`.
   */
  models: readonly AgentModel[];
  /**
   * Whether this agent's CLI can back Engager's own BACKGROUND model calls —
   * discovery enrichment, Brain seeding, product ingest, drafting. A local
   * install runs every one of these through the owner's agent rather than a
   * provider API key, so this column decides whether an install with only this
   * agent works at all. "supported" requires schema-constrained output; an
   * agent without it cannot serve the structured calls the pipeline depends on.
   *
   * Reported here, decided elsewhere: the authority is the adapter's own
   * capability declaration in `packages/core/ai/agentCli`, which is what
   * selection reads. `packages/common` cannot import core — core imports
   * common — so this field is pinned to that declaration by
   * `agentCli/registry.test.ts` rather than computed from it.
   */
  backgroundJobs: AgentCapability;
  /**
   * The EXACT executable versions this repository has offline conformance
   * fixtures for — argv, effective configuration, streamed events and parsed
   * result, all against a fake process. Empty means no adapter, so nothing was
   * fixture-tested and nothing is refused for a version.
   *
   * Fixture-tested is not provider-tested. Nothing here says a native login,
   * a real model or a real isolation attempt was ever exercised; that is R-10,
   * pending for every route in this table. The support document prints the two
   * as separate facts because publishing one as the other is the exact claim
   * TIER-08 forbids.
   *
   * Reported here, decided elsewhere, like `backgroundJobs`: the authority is
   * `descriptor.supportedExecutableVersions` in `packages/core/ai/agentCli`,
   * which is what selection refuses against. `packages/common` cannot import
   * core, so `agentCli/registry.test.ts` pins this to it.
   */
  conformanceVersions: readonly string[];
  note: string;
};

/**
 * Product support truth shared by generated docs and UI copy.
 *
 * Keep this about surfaces Engager has actually tested. A client being able to
 * speak MCP is not the same as Engager supporting its auth, installation, and
 * recovery path.
 */
export const AGENT_SUPPORT_MATRIX = Object.freeze([
  Object.freeze({
    id: "claude",
    name: "Claude",
    clients: Object.freeze(["Claude Code", "Claude Desktop"]),
    tier: "supported",
    interactive: "supported",
    unattendedRunner: "closed_beta",
    backgroundJobs: "supported",
    // The three ids the background roles default to (`config.models`). The
    // numbers and their stamp — platform.claude.com pricing, 2026-06-29 — moved
    // here verbatim from `ai/pricing.ts`; nothing was re-verified in the move.
    models: Object.freeze([
      Object.freeze({
        id: "claude-haiku-4-5",
        price: Object.freeze({ inputPerM: 1.0, outputPerM: 5.0 }),
      }),
      Object.freeze({
        id: "claude-sonnet-4-6",
        price: Object.freeze({ inputPerM: 3.0, outputPerM: 15.0 }),
      }),
      Object.freeze({
        id: "claude-opus-4-8",
        price: Object.freeze({ inputPerM: 5.0, outputPerM: 25.0 }),
      }),
    ]),
    conformanceVersions: Object.freeze(["2.1.258"]),
    note: "Supported for interactive MCP sessions; the closed-beta local runner supports the Claude CLI. Backs local background inference and shared brokered chat through `claude -p` with schema-constrained output. Prepared MCP stages use the external agent's judgment. The two clients are configured separately: Claude Code takes `~/.claude.json` and Skills in `~/.claude/skills`; Claude Desktop (with Cowork) takes one MCP entry in its own `claude_desktop_config.json` and loads no Skills from disk, so it retrieves them with `list_skills`/`get_skill_file`. Native provider/auth validation remains pending R-10.",
  }),
  Object.freeze({
    id: "codex",
    name: "Codex",
    clients: Object.freeze(["Codex CLI"]),
    tier: "supported",
    interactive: "supported",
    unattendedRunner: "closed_beta",
    backgroundJobs: "advanced",
    // The transport vocabulary the Codex adapter's own model routes declare and
    // `AgentCliLLM` refuses everything outside — so it belongs here, where the
    // owner reads which ids the `ENGAGER_MODEL_*` variables may take. UNPRICED:
    // Engager reaches Codex only through the owner's own subscription, and a
    // hosted token price for it is a number nobody has verified.
    models: Object.freeze([
      Object.freeze({ id: "gpt-5-codex" }),
      Object.freeze({ id: "gpt-5.3-codex" }),
      Object.freeze({ id: "gpt-5.4" }),
    ]),
    conformanceVersions: Object.freeze(["0.153.4"]),
    note: "Supported for external interactive MCP sessions. Background text/schema transport has offline conformance fixtures for the version column beside it; an explicit executable/model/native-auth selection and verified isolation profile are required. An installed Codex runs only after its own sandbox self-test passes on that Mac, recorded per binary. The shared in-app broker has actual-adapter offline fixtures; native provider/auth validation remains pending R-10.",
  }),
  Object.freeze({
    id: "gemini",
    name: "Gemini",
    clients: Object.freeze(["Gemini CLI"]),
    tier: "coming_soon",
    interactive: "unsupported",
    unattendedRunner: "unsupported",
    backgroundJobs: "advanced",
    models: Object.freeze([
      Object.freeze({ id: "gemini-2.5-flash" }),
      Object.freeze({ id: "gemini-2.5-pro" }),
    ]),
    conformanceVersions: Object.freeze(["0.30.0"]),
    note: "Actual background and shared in-app broker adapters have offline fixtures for the version beside them, using validated model JSON. Native Google login and explicitly selected Gemini API key routes are distinct. Installed execution refuses until exact isolation evidence is admitted; R-10 pending. External client installation is not certified.",
  }),
  Object.freeze({
    id: "opencode",
    name: "OpenCode",
    clients: Object.freeze(["OpenCode"]),
    tier: "coming_soon",
    interactive: "unsupported",
    unattendedRunner: "unsupported",
    backgroundJobs: "advanced",
    models: Object.freeze([
      Object.freeze({ id: "openai/gpt-5.4" }),
      Object.freeze({ id: "ollama/qwen3:8b" }),
    ]),
    conformanceVersions: Object.freeze(["1.18.18"]),
    note: "Actual background and shared in-app broker adapters have offline fixtures for the version beside them. Explicit OpenAI API key or loopback Ollama routes only; no Claude subscription credentials or plugins. Installed execution refuses until exact isolation evidence is admitted; R-10 pending. External client installation is not certified.",
  }),
  Object.freeze({
    id: "hermes",
    name: "Hermes",
    clients: Object.freeze(["Hermes"]),
    tier: "community",
    interactive: "unsupported",
    unattendedRunner: "unsupported",
    backgroundJobs: "unsupported",
    models: Object.freeze([]),
    conformanceVersions: Object.freeze([]),
    note: "Discovery only. No reviewed background or in-app execution contract; selection is refused.",
  }),
  Object.freeze({
    id: "openclaw",
    name: "OpenClaw",
    clients: Object.freeze(["OpenClaw"]),
    tier: "community",
    interactive: "advanced",
    unattendedRunner: "unsupported",
    backgroundJobs: "unsupported",
    models: Object.freeze([]),
    conformanceVersions: Object.freeze([]),
    note: "Community and advanced use only. Bearer-token MCP may work, but Engager does not certify setup or recovery.",
  }),
  Object.freeze({
    id: "grok",
    name: "Grok",
    clients: Object.freeze(["Grok CLI"]),
    tier: "coming_soon",
    interactive: "unsupported",
    unattendedRunner: "unsupported",
    backgroundJobs: "unsupported",
    models: Object.freeze([]),
    conformanceVersions: Object.freeze([]),
    note: "Coming soon. Engager notes the CLI when it is installed, but has no adapter to run it yet; selection is refused.",
  }),
  Object.freeze({
    id: "cursor",
    name: "Cursor",
    clients: Object.freeze(["Cursor CLI"]),
    tier: "coming_soon",
    interactive: "unsupported",
    unattendedRunner: "unsupported",
    backgroundJobs: "unsupported",
    models: Object.freeze([]),
    conformanceVersions: Object.freeze([]),
    note: "Coming soon. Engager notes the Cursor agent CLI when it is installed, but has no adapter to run it yet; selection is refused. The editor's own launcher is not the agent CLI and is never reported as one.",
  }),
  Object.freeze({
    id: "chatgpt",
    name: "ChatGPT",
    clients: Object.freeze(["ChatGPT"]),
    tier: "coming_later",
    interactive: "unsupported",
    unattendedRunner: "unsupported",
    backgroundJobs: "unsupported",
    models: Object.freeze([]),
    conformanceVersions: Object.freeze([]),
    note: "Coming later. ChatGPT connectors require an authentication path Engager does not provide yet.",
  }),
] as const satisfies readonly AgentSupportEntry[]);

/**
 * The models this agent may be asked for, in declaration order. Empty means
 * Engager has verified no vocabulary for it, which is a different thing from
 * the agent having no models — see `AgentSupportEntry.models`.
 *
 * `agentId` is a bare string rather than the matrix union because the adapter
 * REGISTRY keys on one: a new agent-CLI adapter is a registry entry, not a
 * union edit (`AgentCliId`). An id no entry names has no vocabulary, which is
 * the same answer the union would have refused to ask.
 */
export function agentModels(agentId: string): readonly AgentModel[] {
  return (
    AGENT_SUPPORT_MATRIX.find((entry) => entry.id === agentId)?.models ?? []
  );
}

/**
 * A model id pinned to a release carries a date suffix
 * (`claude-sonnet-4-6-20251001`) and names the same model. Stripping it here,
 * where the one lookup lives, is what keeps the two lanes from parting over it:
 * the price table would take the dated id and the agent-CLI client refuse it.
 */
export function undatedModel(model: string): string {
  return model.replace(/-\d{8}$/, "");
}

function names(declared: AgentModel, model: string): boolean {
  return declared.id === model || (declared.aliases?.includes(model) ?? false);
}

/**
 * The declared model `model` names — matched on its id, on a shorthand the
 * agent's CLI accepts for it, or on either with a release date appended.
 *
 * `agentId` narrows the search to one agent's vocabulary, which is the question
 * the agent-CLI client asks. The price table asks without one, because it is
 * handed a model id and nothing else; ids and aliases are unique across the
 * matrix (`agent-support.test.ts` pins that), so the first match is the only
 * match.
 */
export function declaredModel(
  model: string,
  agentId?: string,
): AgentModel | undefined {
  const undated = undatedModel(model);
  const searched = agentId
    ? [agentId]
    : AGENT_SUPPORT_MATRIX.map((entry) => entry.id);
  for (const agent of searched) {
    const found = agentModels(agent).find(
      (declared) => names(declared, model) || names(declared, undated),
    );
    if (found) return found;
  }
  return undefined;
}

export const SUPPORTED_AGENT_NAMES = Object.freeze(
  AGENT_SUPPORT_MATRIX.filter((entry) => entry.tier === "supported").map(
    (entry) => entry.name,
  ),
);

export const COMMUNITY_AGENT_NAMES = Object.freeze(
  AGENT_SUPPORT_MATRIX.filter((entry) => entry.tier === "community").map(
    (entry) => entry.name,
  ),
);

export const COMING_SOON_AGENT_NAMES = Object.freeze(
  AGENT_SUPPORT_MATRIX.filter((entry) => entry.tier === "coming_soon").map(
    (entry) => entry.name,
  ),
);

export const COMING_LATER_AGENT_NAMES = Object.freeze(
  AGENT_SUPPORT_MATRIX.filter((entry) => entry.tier === "coming_later").map(
    (entry) => entry.name,
  ),
);

export const CLOSED_BETA_RUNNER_AGENT_NAMES = Object.freeze(
  AGENT_SUPPORT_MATRIX.filter(
    (entry) => entry.unattendedRunner === "closed_beta",
  ).map((entry) => entry.name),
);
