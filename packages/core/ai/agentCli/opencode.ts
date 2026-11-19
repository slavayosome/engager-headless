import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LOCAL_AGENT_MODELS } from "@engager/common/local-agent-support";
import { agentFailure, agentReportedFailure } from "./state";
import { runMetadataProbe } from "./metadata";
import {
  assertNoManagedProfile,
  verifyInvocationProfile,
} from "./profileEvidence";
import {
  eventObject,
  jsonPrompt,
  modelPayload,
  tokenCount,
} from "./validatedJson";
import type { AgentCliAdapter, AgentCliResult } from "./types";

const PROFILE = "opencode-1.18.18-v1";

/** API and loopback local routes only. No shared auth.json, OAuth token import,
 * well-known remote config, Claude subscription plugin or native MCP. */
export const opencodeAdapter: AgentCliAdapter = {
  id: "opencode",
  name: "OpenCode",
  provider: "selected_provider",
  install: {
    command: "curl -fsSL https://opencode.ai/install | bash",
    url: "https://opencode.ai/docs/",
  },
  executableOverrideEnv: "ENGAGER_OPENCODE_BIN",
  descriptor: {
    adapterId: "opencode",
    adapterContractVersion: "1",
    supportedExecutableVersions: ["1.18.18"],
    background: { text: true, structured: "validated_json" },
    chat: {
      transport: "broker",
      events: true,
      textDeltas: false,
      brokerTools: true,
      resumable: "canonical_history",
    },
    isolationProfileVersion: PROFILE,
    supportedAuthRoutes: ["openai_api_key", "local_ollama"],
    supportedModelRoutes: [
      {
        providerRef: "openai",
        models: LOCAL_AGENT_MODELS.opencode!.filter((model) =>
          model.startsWith("openai/"),
        ),
        authRoutes: ["openai_api_key"],
      },
      {
        providerRef: "ollama",
        models: LOCAL_AGENT_MODELS.opencode!.filter((model) =>
          model.startsWith("ollama/"),
        ),
        authRoutes: ["local_ollama"],
      },
    ],
    discovery: {
      executables: ["opencode"],
      directories: [
        "~/.opencode/bin",
        "~/.local/bin",
        "/opt/homebrew/bin",
        "/usr/local/bin",
      ],
    },
  },
  supportsJsonSchema: true,
  supportsWebSearch: false,
  // OpenCode is the one registered adapter with a documented, noninteractive
  // list subcommand (`opencode models [provider]`). It is run under the
  // metadata profile's private HOME with its own fetches disabled, so the read
  // enumerates the models the INSTALLED binary knows without reaching the
  // network behind the owner's back — `--refresh` is never passed. A listed id
  // is evidence about this installation's catalog and nothing more: whether
  // the account may reach it stays the route's question.
  metadata: {
    network: false,
    async listModels(context) {
      const provider = context.providerRef;
      const result = await runMetadataProbe(context.absoluteExecutable, {
        args: [
          "models",
          ...(provider && provider !== "selected_provider" ? [provider] : []),
        ],
        env: {
          OPENCODE_DISABLE_MODELS_FETCH: "true",
          npm_config_offline: "true",
        },
        timeoutMs: 10_000,
        signal: context.signal,
      });
      if (result.code !== 0 && !result.stdout.trim())
        throw agentFailure("catalog_unavailable");
      // One id per line, of the `provider/model` shape the list subcommand
      // prints; a line that is not one is dropped rather than guessed at.
      const models = result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /^[a-z0-9][\w.+-]*\/[\w.:@+-]+$/i.test(line))
        .map((id) => ({ id, label: id }));
      return {
        models,
        source: "the installation's own model catalog (read offline)",
        ...(provider && provider !== "selected_provider"
          ? { providerRef: provider }
          : {}),
      };
    },
  },
  bin: () =>
    process.env.ENGAGER_OPENCODE_BIN ??
    process.env.ENGAGER_AGENT_CLI_BIN ??
    "opencode",
  async verifyIsolation(selection) {
    verifyInvocationProfile(selection, PROFILE);
  },
  async prepareInvocation(request, baseEnv) {
    const dir = request.requestDirectory;
    const selection = request.frozenSelection;
    if (!dir || !selection) throw agentFailure("agent_profile_required");
    assertNoManagedProfile("opencode");
    if (selection.authStorePath)
      throw agentFailure("agent_auth_store_unsupported");
    const local = selection.authRoute === "local_ollama";
    const config = {
      model: request.model,
      small_model: request.model,
      default_agent: "engager",
      enabled_providers: [selection.providerRef],
      provider: local
        ? {
            ollama: {
              npm: "@ai-sdk/openai-compatible",
              name: "Local Ollama",
              options: { baseURL: "http://127.0.0.1:11434/v1" },
              models: { "qwen3:8b": { name: "qwen3:8b" } },
            },
          }
        : {},
      permission: { "*": "deny" },
      agent: {
        engager: {
          mode: "primary",
          model: request.model,
          permission: { "*": "deny" },
          steps: 1,
          prompt:
            "Use only the supplied Engager request. Return its requested text or JSON value. No native tools.",
        },
      },
      mcp: {},
      plugin: [],
      instructions: [],
      share: "disabled",
      autoupdate: false,
      lsp: false,
      formatter: false,
      compaction: { auto: false, prune: false },
    };
    await writeFile(join(dir, "opencode.json"), JSON.stringify(config), {
      mode: 0o600,
    });
    await writeFile(
      join(dir, ".npmrc"),
      "offline=true\nignore-scripts=true\naudit=false\nfund=false\n",
      { mode: 0o600 },
    );
    await mkdir(join(dir, "tmp"), { mode: 0o700 });
    const env: NodeJS.ProcessEnv = {
      ...baseEnv,
      HOME: dir,
      TMPDIR: join(dir, "tmp"),
      XDG_CONFIG_HOME: join(dir, "config"),
      XDG_DATA_HOME: join(dir, "data"),
      XDG_CACHE_HOME: join(dir, "cache"),
      XDG_STATE_HOME: join(dir, "state"),
      OPENCODE_CONFIG: join(dir, "opencode.json"),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_PERMISSION: '{"*":"deny"}',
      OPENCODE_DISABLE_PROJECT_CONFIG: "true",
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_DISABLE_MODELS_FETCH: "true",
      OPENCODE_DISABLE_AUTOCOMPACT: "true",
      OPENCODE_DISABLE_FFF: "true",
      OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
      npm_config_offline: "true",
      npm_config_ignore_scripts: "true",
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_userconfig: join(dir, ".npmrc"),
      npm_config_globalconfig: join(dir, ".npmrc"),
    };
    if (!local) {
      if (!process.env.OPENAI_API_KEY)
        throw agentFailure("authentication_required");
      env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    }
    return { env, input: jsonPrompt(request) };
  },
  buildArgs(request) {
    return [
      "run",
      "--format",
      "json",
      "--model",
      request.model,
      "--agent",
      "engager",
    ];
  },
  inspectOutputLine(line) {
    const event = eventObject(line);
    if (
      ["tool_use", "permission", "permission_request"].includes(event.type) ||
      event.part?.type === "tool"
    )
      throw agentFailure("native_tool_attempt");
    if (
      !["step_start", "text", "reasoning", "step_finish", "error"].includes(
        event.type,
      )
    )
      throw agentFailure("agent_event_unsupported");
  },
  parseResult(stdout): AgentCliResult {
    let terminal = false;
    let started = false;
    let sawText = false;
    let text = "";
    let session: string | undefined;
    let usage: AgentCliResult["usage"] = {};
    for (const line of stdout.split("\n").filter((line) => line.trim())) {
      this.inspectOutputLine!(line);
      const event = eventObject(line);
      if (terminal) throw agentFailure("agent_event_after_terminal");
      if (event.type === "error") throw agentReportedFailure(event.error);
      if (typeof event.sessionID !== "string" || !event.sessionID)
        throw agentFailure("invalid_agent_output");
      session ??= event.sessionID;
      if (session !== event.sessionID)
        throw agentFailure("agent_session_conflict");
      if (event.type === "step_start") {
        if (started) throw agentFailure("agent_event_unsupported");
        started = true;
      } else if (!started) throw agentFailure("agent_terminal_missing");
      if (event.type === "text") {
        if (typeof event.part?.text !== "string" || !event.part?.time?.end)
          throw agentFailure("invalid_agent_output");
        sawText = true;
        text += event.part.text;
      }
      if (event.type === "step_finish") {
        if (event.part?.reason === "tool-calls")
          throw agentFailure("native_tool_attempt");
        if (event.part?.reason !== "stop")
          throw agentFailure("invalid_agent_output");
        terminal = true;
        const tokens = event.part.tokens ?? {};
        for (const [key, value] of [
          ["inputTokens", tokens.input],
          ["outputTokens", tokens.output],
          ["cacheReadTokens", tokens.cache?.read],
          ["cacheCreationTokens", tokens.cache?.write],
        ] as const)
          if (tokenCount(value) !== undefined) usage[key] = value;
      }
    }
    if (!terminal || !sawText) throw agentFailure("agent_terminal_missing");
    // run JSON events do not report model identity. Do not copy the requested
    // model into an "actual" field, or treat native cost as subscription spend.
    return { ...modelPayload(text), usage };
  },
};
