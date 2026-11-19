import { listClaudeModels } from "./modelCatalogs";
import { isolatedAuthStore } from "./authStore";
import { homedir } from "node:os";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { claudeChatSurface } from "./claudeChat";
import { LOCAL_AGENT_MODELS } from "@engager/common/local-agent-support";
import { agentReportedFailure } from "./state";
import {
  configuredField,
  readConfiguredModelFile,
} from "./metadata";
import type { AgentCliAdapter, AgentCliRequest, AgentCliResult } from "./types";
import { AgentCliError } from "./types";
import { AGENT_INSTALLERS } from "./installers";

/** Claude Code 2.1.258 print transport. Native schema output still passes
 * deterministic validation in AgentCliLLM. Background tools/customizations are
 * disabled. Production chat also uses this executor through the shared broker. */
/** The tools a web look-up gets, and the one site they never open. */
const WEB_TOOLS = "WebSearch,WebFetch";
const NO_LINKEDIN = "WebFetch(domain:linkedin.com),WebFetch(domain:www.linkedin.com)";

export const claudeAdapter: AgentCliAdapter = {
  id: "claude",
  name: "Claude",
  provider: "anthropic",
  // The ONE installer table's entry — the same command the first-run
  // window's install button runs and `engager doctor` prints, so the
  // empty state can never name a different one (US-ONE-02).
  install: {
    command: AGENT_INSTALLERS.claude.command,
    url: AGENT_INSTALLERS.claude.url,
  },
  descriptor: {
    adapterId: "claude",
    adapterContractVersion: "1",
    supportedExecutableVersions: ["2.1.258"],
    // Claude Code auto-updates every few days; an exact pin locked every owner
    // out after the next update. Isolation is re-verified per binary at run
    // time (`verifyIsolationProfile`: required flags present, no managed
    // settings), so later versions are admitted and still checked.
    minimumExecutableVersion: "2.1.258",
    background: { text: true, structured: "native_schema" },
    chat: {
      transport: "broker",
      events: true,
      textDeltas: false,
      brokerTools: true,
      resumable: "canonical_history",
    },
    isolationProfileVersion: "claude-2.1.258-v1",
    supportedAuthRoutes: ["native_login"],
    supportedModelRoutes: [
      { providerRef: "anthropic", models: LOCAL_AGENT_MODELS.claude! },
    ],
    // The directories the native installer uses when it leaves PATH alone.
    // Claude Desktop's bundle is deliberately NOT here: it ships no CLI,
    // its `Claude` executable answers to `claude` on a case-insensitive
    // filesystem, and probing it would launch the desktop app. Discovery
    // refuses `Claude.app` candidates outright (`isClaudeDesktopPath`).
    discovery: {
      executables: ["claude"],
      // `~/.local/bin` is where the native installer (the table's command)
      // puts the binary; the scan names it itself so a just-installed
      // Claude is found even before any PATH picks it up.
      directories: ["~/.local/bin", "~/.claude/local", "~/.local/share/claude"],
    },
  },
  supportsJsonSchema: true,
  supportsWebSearch: false,
  supportsWebResearch: true,
  chat: claudeChatSurface,
  // The list Claude Code's own picker shows, read from its control-protocol
  // `initialize` response: no user message, no thread, no inference. It answers
  // for the OWNER'S account, so the probe runs against their real Claude home
  // rather than the private one every other probe gets — which is why this
  // route is admitted exactly as execution is, version and isolation both, and
  // an installation that fails either falls back to the configured model below
  // instead of being spawned.
  metadata: {
    network: true,
    readsOwnerAuthStore: true,
    listModels: listClaudeModels,
    listUnsupported:
      "Claude's own model list could not be read here — choose the configured model or enter a model id",
    async configuredModel(context) {
      const root = isolatedAuthStore("claude", context.authStorePath) ?? join(homedir(), ".claude");
      return readConfiguredModelFile(
        join(root, "settings.json"),
        (parsed) => configuredField(parsed, "model"),
        { signal: context.signal },
      );
    },
  },

  bin(): string {
    return process.env.ENGAGER_AGENT_CLI_BIN ?? "claude";
  },

  async prepareInvocation(request, env) {
    if (!request.requestDirectory)
      throw new AgentCliError("agent_profile_required");
    if (request.system) {
      // A JSON key named `system` in stdin is still user text to Claude. Give
      // app instructions their native role, without exposing private context
      // in argv. The executor owns and removes this private request directory.
      await writeFile(
        join(request.requestDirectory, "system-prompt.txt"),
        request.system,
        {
          mode: 0o600,
          flag: "wx",
        },
      );
    }
    return { env, input: JSON.stringify({ user: request.user }) };
  },

  buildArgs(request: AgentCliRequest): string[] {
    return [
      "-p",
      ...(request.system && request.requestDirectory
        ? [
            "--system-prompt-file",
            join(request.requestDirectory, "system-prompt.txt"),
          ]
        : []),
      "--output-format",
      "json",
      ...(request.jsonSchema
        ? ["--json-schema", JSON.stringify(request.jsonSchema)]
        : []),
      "--model",
      request.model,
      // Only a level this installation listed for this model (`picker.ts`),
      // and only when the call asks for the owner's chosen model (`run.ts`).
      ...(request.frozenSelection?.effort
        ? ["--effort", request.frozenSelection.effort]
        : []),
      // Inference only. Without an explicit allowlist the agent could read or
      // run things on the owner's machine to answer a scoring prompt — the
      // input to which is untrusted LinkedIn text. A web look-up is the one
      // call with tools: the two that read the public web, for a request
      // that carries the owner's question and nothing Engager read. LinkedIn
      // is read through the account's own browser and budget, never here.
      "--tools",
      request.webResearch ? WEB_TOOLS : "",
      ...(request.webResearch ? ["--allowedTools", WEB_TOOLS] : []),
      "--disallowedTools",
      `Bash,Edit,Write,NotebookEdit,Task,KillShell,Read,Glob,Grep${request.webResearch ? `,${NO_LINKEDIN}` : ""}`,
      // No MCP servers at all: --strict-mcp-config without --mcp-config means
      // the user's own registrations (including engager-local) never load, so
      // a background job can never re-enter Engager through its own agent.
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--safe-mode",
      "--restricted",
      "--setting-sources",
      "",
      "--settings",
      '{"disableAllHooks":true}',
      "--disable-slash-commands",
      "--no-chrome",
      "--no-session-persistence",
      "--permission-mode",
      "dontAsk",
    ];
  },

  inspectOutputLine(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return;
    }
    if (!raw || typeof raw !== "object") return;
    const event = raw as Record<string, unknown>;
    const block = event.content_block as { type?: unknown } | null;
    const message = event.message as { content?: unknown } | null;
    if (
      event.type === "tool_use" ||
      event.type === "permission_request" ||
      block?.type === "tool_use" ||
      (Array.isArray(message?.content) &&
        message.content.some(
          (block: { type?: string } | null) => block?.type === "tool_use",
        )) ||
      (Array.isArray(event.permission_denials) &&
        event.permission_denials.length)
    ) {
      throw new AgentCliError("native_tool_attempt");
    }
  },

  parseResult(stdout: string): AgentCliResult {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(stdout.trim()) as Record<string, unknown>;
    } catch {
      throw new AgentCliError("invalid_agent_output");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new AgentCliError("invalid_agent_output");
    if (payload.is_error === true) {
      throw agentReportedFailure(payload.result ?? payload.subtype);
    }
    if (
      payload.type !== "result" ||
      payload.subtype !== "success" ||
      payload.is_error !== false
    ) {
      throw new AgentCliError("agent_terminal_missing");
    }
    const usage = (payload.usage ?? {}) as Record<string, unknown>;
    const serverTool = (usage.server_tool_use ?? {}) as Record<string, unknown>;
    const num = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) && value >= 0
        ? value
        : undefined;
    const reportedModels = Object.keys((payload.modelUsage ?? {}) as object);
    return {
      text: typeof payload.result === "string" ? payload.result : "",
      ...(reportedModels.length === 1
        ? { actualReportedModel: reportedModels[0] }
        : {}),
      ...(payload.structured_output !== undefined
        ? { structured: payload.structured_output }
        : {}),
      usage: {
        ...(num(usage.input_tokens) !== undefined
          ? { inputTokens: num(usage.input_tokens)! }
          : {}),
        ...(num(usage.output_tokens) !== undefined
          ? { outputTokens: num(usage.output_tokens)! }
          : {}),
        ...(num(usage.cache_creation_input_tokens) !== undefined
          ? { cacheCreationTokens: num(usage.cache_creation_input_tokens)! }
          : {}),
        ...(num(usage.cache_read_input_tokens) !== undefined
          ? { cacheReadTokens: num(usage.cache_read_input_tokens)! }
          : {}),
        ...(num(serverTool.web_search_requests) !== undefined
          ? { webSearchRequests: num(serverTool.web_search_requests)! }
          : {}),
        ...(num(payload.total_cost_usd) !== undefined
          ? { costUsd: num(payload.total_cost_usd)! }
          : {}),
      },
    };
  },
};
