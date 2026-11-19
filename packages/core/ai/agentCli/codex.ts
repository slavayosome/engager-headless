import { listCodexModels } from "./modelCatalogs";
import { isolatedAuthStore } from "./authStore";
import { homedir } from "node:os";
import { join } from "node:path";
import { LOCAL_AGENT_MODELS } from "@engager/common/local-agent-support";
import type { AgentCliAdapter, AgentCliRequest, AgentCliResult } from "./types";
import { agentFailure, agentReportedFailure } from "./state";
import { readConfiguredTomlValue } from "./metadata";
import { AGENT_INSTALLERS } from "./installers";
import { jsonPrompt } from "./validatedJson";

/** Codex also emits diagnostic items, including a disabled Code Mode notice.
 * These are not tool calls. Known auth/usage failures still stop immediately;
 * other diagnostics cannot substitute for a validated terminal answer. */
function isDiagnostic(item: { type?: string; message?: unknown }): boolean {
  if (item.type !== "error") return false;
  if (typeof item.message !== "string") throw agentFailure("invalid_agent_output");
  const failure = agentReportedFailure(item.message);
  if (failure.message !== "agent_reported_failure") throw failure;
  return true;
}

/** Codex exec's final assistant item is distinct from progress and turn usage.
 * Native isolation is checked before admission; CLI JSONL is never the answer. */
export const codexAdapter: AgentCliAdapter = {
  id: "codex",
  name: "Codex",
  provider: "openai",
  // The ONE installer table's entry, as in claude.ts (US-ONE-02).
  install: {
    command: AGENT_INSTALLERS.codex.command,
    url: AGENT_INSTALLERS.codex.url,
  },
  executableOverrideEnv: "ENGAGER_CODEX_BIN",
  descriptor: {
    adapterId: "codex",
    adapterContractVersion: "1",
    supportedExecutableVersions: ["0.153.4"],
    // The first release with every flag `buildArgs` passes, the permission
    // profile keys it names, `codex sandbox -c` and each feature in
    // `CODEX_DISABLED_FEATURES` (`in_app_local_automation` arrived last, in
    // 0.150.0). Codex ships weekly, so later versions are admitted and each
    // binary must still pass the sandbox self-test (`codexSelfTest.ts`)
    // before it runs.
    minimumExecutableVersion: "0.150.0",
    background: { text: true, structured: "validated_json" },
    chat: {
      // Engager owns chat history and tool dispatch through its broker.
      transport: "broker",
      events: true,
      textDeltas: false,
      brokerTools: true,
      resumable: "canonical_history",
    },
    isolationProfileVersion: "codex-0.153.4-v1",
    supportedAuthRoutes: ["native_login"],
    supportedModelRoutes: [
      { providerRef: "openai", models: LOCAL_AGENT_MODELS.codex! },
    ],
    discovery: {
      executables: ["codex"],
      // The npm global root and the Homebrew keg are the two places a Codex
      // CLI lands when the installer does not touch PATH; both are named
      // explicitly so a Finder launch does not depend on an inherited one.
      directories: [
        "~/.local/bin",
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/Applications/Codex.app/Contents/Resources",
      ],
    },
  },
  supportsJsonSchema: true,
  supportsWebSearch: false,
  // Codex's full inventory lives behind the app-server protocol, and this reads
  // it the way its own client does: initialize, `model/list`, close. No thread
  // and no turn is ever created. The models are the owner's account's, so the
  // probe runs against their real `CODEX_HOME` rather than the private profile
  // every other probe gets — which is why this route is admitted exactly as
  // execution is, version and isolation both: an installation whose sandbox
  // self-test has not passed falls back to the configured model below.
  metadata: {
    network: true,
    readsOwnerAuthStore: true,
    listModels: listCodexModels,
    listUnsupported:
      "Codex's own model list could not be read here — choose the configured model or enter a model id",
    async configuredModel(context) {
      const root = isolatedAuthStore("codex", context.authStorePath) ?? join(homedir(), ".codex");
      return readConfiguredTomlValue(join(root, "config.toml"), "model", {
        signal: context.signal,
      });
    },
  },
  inspectOutputLine(line: string): void {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw agentFailure("invalid_agent_output");
    }
    if (typeof event?.type !== "string")
      throw agentFailure("invalid_agent_output");
    if (event.type.startsWith("item.") && isDiagnostic(event.item ?? {})) return;
    if (
      event.type.startsWith("item.") &&
      !["agent_message", "reasoning"].includes(event.item?.type)
    )
      throw agentFailure("native_tool_attempt");
  },
  bin() {
    return (
      process.env.ENGAGER_CODEX_BIN ??
      process.env.ENGAGER_AGENT_CLI_BIN ??
      "codex"
    );
  },
  async prepareInvocation(request, env) {
    // Codex's strict response format cannot express the broker's open tool
    // arguments. Use the same schema-carrying transport as the other JSON
    // adapters; the LLM/broker still validates before accepting any output.
    return { env, input: jsonPrompt(request) };
  },
  buildArgs(request: AgentCliRequest): string[] {
    return [
      "exec",
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--model",
      request.model,
      // See claude.ts: a listed level for the chosen model only. The value is
      // already restricted to [a-z0-9_-] by the selection schema, so quoting it
      // as a TOML string cannot break out of the `-c` value.
      ...(request.frozenSelection?.effort
        ? ["-c", `model_reasoning_effort="${request.frozenSelection.effort}"`]
        : []),
      "-c",
      'approval_policy="never"',
      "-c",
      'web_search="disabled"',
      "-c",
      "mcp_servers={}",
      "-c",
      "plugins={}",
      "-c",
      "project_doc_max_bytes=0",
      "-c",
      "check_for_update_on_startup=false",
      "-c",
      "skills.include_instructions=false",
      ...codexPermissionArgs(CODEX_JUDGMENT_PROFILE),
      ...CODEX_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
      "-",
    ];
  },
  parseResult(stdout: string): AgentCliResult {
    let terminal = false;
    let text: string | undefined;
    let model: string | undefined;
    let usage: AgentCliResult["usage"] = {};
    const num = (value: unknown) =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? value
        : undefined;
    for (const line of stdout.split("\n").filter((line) => line.trim())) {
      let event: Record<string, any>;
      try {
        event = JSON.parse(line);
      } catch {
        throw agentFailure("invalid_agent_output");
      }
      if (
        !event ||
        typeof event !== "object" ||
        Array.isArray(event) ||
        typeof event.type !== "string"
      )
        throw agentFailure("invalid_agent_output");
      if (terminal) throw agentFailure("agent_event_after_terminal");
      if (event.type === "error" || event.type === "turn.failed")
        throw agentReportedFailure(event.error ?? event.message);
      if (
        event.type === "item.started" ||
        event.type === "item.updated" ||
        event.type === "item.completed"
      ) {
        const item = event.item;
        if (!item || typeof item.type !== "string")
          throw agentFailure("invalid_agent_output");
        if (isDiagnostic(item)) continue;
        if (!["agent_message", "reasoning"].includes(item.type))
          throw agentFailure("native_tool_attempt");
        if (item.type === "agent_message" && event.type === "item.completed") {
          if (typeof item.text !== "string")
            throw agentFailure("invalid_agent_output");
          text = item.text;
          if (typeof item.model === "string") model = item.model;
        }
      } else if (event.type === "turn.completed") {
        terminal = true;
        const reported = event.usage ?? {};
        usage = {
          ...(num(reported.input_tokens) !== undefined
            ? { inputTokens: num(reported.input_tokens)! }
            : {}),
          ...(num(reported.output_tokens) !== undefined
            ? { outputTokens: num(reported.output_tokens)! }
            : {}),
          ...(num(reported.cached_input_tokens) !== undefined
            ? { cacheReadTokens: num(reported.cached_input_tokens)! }
            : {}),
        };
        if (typeof event.model === "string") model = event.model;
      } else if (!["thread.started", "turn.started"].includes(event.type)) {
        throw agentFailure("agent_event_unsupported");
      }
    }
    if (!terminal || text === undefined)
      throw agentFailure("agent_terminal_missing");
    let structured: unknown;
    try {
      structured = JSON.parse(text);
    } catch {
      /* Plain text is a valid text result. */
    }
    return {
      text,
      usage,
      ...(structured !== undefined ? { structured } : {}),
      ...(model ? { actualReportedModel: model } : {}),
    };
  },
};

/** A Codex permission profile, in the shape `codexPermissionArgs` renders as
 *  `-c` overrides. `filesystem` maps a path or special path (`:root`,
 *  `:workspace_roots`, `:minimal`) to an access level, or to a table of
 *  subpaths under it. */
export type CodexPermissionProfile = {
  name: string;
  filesystem: Readonly<
    Record<string, string | Readonly<Record<string, string>>>
  >;
  network: boolean;
};

/** What a judgment call may touch: the request directory, read-only, and no
 *  network. Without `:minimal` macOS denies even the system libraries a
 *  process loads, so any tool process Codex starts under it dies before it
 *  runs; the sandbox self-test pins exactly that. */
export const CODEX_JUDGMENT_PROFILE: CodexPermissionProfile = {
  name: "engager_judgment",
  filesystem: { ":root": "deny", ":workspace_roots": { ".": "read" } },
  network: false,
};

function tomlInlineTable(
  entries: Readonly<Record<string, string | Readonly<Record<string, string>>>>,
): string {
  const pairs = Object.entries(entries).map(
    ([key, value]) =>
      `${JSON.stringify(key)}=${typeof value === "string" ? JSON.stringify(value) : tomlInlineTable(value)}`,
  );
  return `{${pairs.join(",")}}`;
}

/** The overrides that make `profile` the active one. `exec` and the sandbox
 *  self-test both take them from here, so the profile a proof was recorded
 *  for is the profile execution runs under. */
export function codexPermissionArgs(profile: CodexPermissionProfile): string[] {
  return [
    "-c",
    `default_permissions=${JSON.stringify(profile.name)}`,
    "-c",
    `permissions.${profile.name}.filesystem=${tomlInlineTable(profile.filesystem)}`,
    "-c",
    `permissions.${profile.name}.network.enabled=${profile.network}`,
  ];
}

export const CODEX_DISABLED_FEATURES = [
  "shell_tool",
  "unified_exec",
  "shell_snapshot",
  "apps",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "in_app_browser",
  "code_mode",
  "code_mode_host",
  "multi_agent",
  "multi_agent_v2",
  "plugins",
  "hooks",
  "image_generation",
  "view_image",
  "memories",
  "remote_plugin",
  "skill_mcp_dependency_install",
  "skill_search",
  "tool_suggest",
  "workspace_dependencies",
  "in_app_local_automation",
  "request_permissions_tool",
] as const;
