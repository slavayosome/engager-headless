import { listGeminiModels } from "./modelCatalogs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { LOCAL_AGENT_MODELS } from "@engager/common/local-agent-support";
import { agentFailure, agentReportedFailure } from "./state";
import {
  configuredField,
  readConfiguredModelFile,
} from "./metadata";
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

const PROFILE = "gemini-0.30.0-v1";

export const geminiAdapter: AgentCliAdapter = {
  id: "gemini",
  name: "Gemini",
  provider: "google",
  install: {
    command: "npm install -g @google/gemini-cli",
    url: "https://geminicli.com/docs/get-started/installation/",
  },
  executableOverrideEnv: "ENGAGER_GEMINI_BIN",
  descriptor: {
    adapterId: "gemini",
    adapterContractVersion: "1",
    supportedExecutableVersions: ["0.30.0"],
    background: { text: true, structured: "validated_json" },
    chat: {
      transport: "broker",
      events: true,
      textDeltas: false,
      brokerTools: true,
      resumable: "canonical_history",
    },
    isolationProfileVersion: PROFILE,
    supportedAuthRoutes: ["native_google_login", "gemini_api_key"],
    supportedModelRoutes: [
      {
        providerRef: "google",
        models: LOCAL_AGENT_MODELS.gemini!,
        authRoutes: ["native_google_login", "gemini_api_key"],
      },
    ],
    discovery: {
      executables: ["gemini"],
      directories: [
        "~/.local/bin",
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/Applications/Gemini.app/Contents/Resources",
      ],
    },
  },
  supportsJsonSchema: true,
  supportsWebSearch: false,
  // Read the installation's model metadata; retain configured/manual fallback.
  metadata: {
    network: false,
    listModels: listGeminiModels,
    listUnsupported:
      "Gemini exposes no noninteractive model list Engager can read — enter a model id",
    async configuredModel(context) {
      return readConfiguredModelFile(
        join(homedir(), ".gemini", "settings.json"),
        (parsed) => {
          const model = configuredField(parsed, "model");
          return typeof model === "string"
            ? model
            : configuredField(model, "name");
        },
        { signal: context.signal },
      );
    },
  },
  bin: () =>
    process.env.ENGAGER_GEMINI_BIN ??
    process.env.ENGAGER_AGENT_CLI_BIN ??
    "gemini",
  async verifyIsolation(selection) {
    verifyInvocationProfile(selection, PROFILE);
  },
  async prepareInvocation(request, baseEnv) {
    const dir = request.requestDirectory;
    const selection = request.frozenSelection;
    if (!dir || !selection) throw agentFailure("agent_profile_required");
    assertNoManagedProfile("gemini");
    const keyRoute = selection.authRoute === "gemini_api_key";
    const settings = {
      general: {
        enableAutoUpdate: false,
        enableAutoUpdateNotification: false,
        retryFetchErrors: false,
        enablePromptCompletion: false,
      },
      admin: {
        extensions: { enabled: false },
        mcp: { enabled: false },
        skills: { enabled: false },
      },
      security: {
        disableYoloMode: true,
        enablePermanentToolApproval: false,
        auth: {
          selectedType: keyRoute ? "gemini-api-key" : "oauth-personal",
          enforcedType: keyRoute ? "gemini-api-key" : "oauth-personal",
        },
      },
      tools: {
        core: [],
        allowed: [],
        exclude: [],
        discoveryCommand: "",
        callCommand: "",
        disableLLMCorrection: true,
      },
      mcp: { allowed: [], serverCommand: "" },
      mcpServers: {},
      hooksConfig: { enabled: false },
      hooks: {},
      context: {
        fileName: [],
        includeDirectoryTree: false,
        includeDirectories: [],
        loadMemoryFromIncludeDirectories: false,
      },
      experimental: {
        enableAgents: false,
        extensionManagement: false,
        extensionReloading: false,
      },
      advanced: { autoConfigureMemory: false },
      telemetry: { enabled: false },
    };
    await writeFile(join(dir, "settings.json"), JSON.stringify(settings), {
      mode: 0o600,
    });
    await writeFile(
      join(dir, "system.md"),
      "You perform bounded Engager judgments. Use only supplied context. No native tools. Follow the supplied response schema when present.",
      { mode: 0o600 },
    );
    // --policy replaces the USER tier, not the inactive workspace tier. Higher
    // admin policy is never bypassed; unknown managed installations refuse.
    await writeFile(
      join(dir, "deny.toml"),
      '[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 999\n',
      { mode: 0o600 },
    );
    // Stop Gemini's upward .env discovery before it reaches any owner file.
    await writeFile(join(dir, ".env"), "", { mode: 0o600 });
    const env: NodeJS.ProcessEnv = {
      ...baseEnv,
      HOME: dir,
      GEMINI_CLI_HOME: keyRoute
        ? dir
        : (selection.authStorePath ?? baseEnv.HOME),
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: join(dir, "settings.json"),
      GEMINI_CLI_SYSTEM_DEFAULTS_PATH: join(dir, "settings.json"),
      GEMINI_SYSTEM_MD: join(dir, "system.md"),
      NO_BROWSER: "true",
    };
    if (keyRoute) {
      if (!process.env.GEMINI_API_KEY)
        throw agentFailure("authentication_required");
      env.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    }
    return { env, input: jsonPrompt(request) };
  },
  buildArgs(request) {
    if (!request.requestDirectory) throw agentFailure("agent_profile_required");
    return [
      "--prompt",
      "Process the supplied stdin request.",
      "--output-format",
      "stream-json",
      "--model",
      request.model,
      "--approval-mode",
      "default",
      "--extensions",
      "none",
      "--policy",
      join(request.requestDirectory, "deny.toml"),
    ];
  },
  inspectOutputLine(line) {
    const event = eventObject(line);
    if (["tool_use", "tool_result", "permission_request"].includes(event.type))
      throw agentFailure("native_tool_attempt");
    if (!["init", "message", "result", "error"].includes(event.type))
      throw agentFailure("agent_event_unsupported");
  },
  parseResult(stdout): AgentCliResult {
    let terminal = false;
    let text = "";
    let sawAssistant = false;
    let model: string | undefined;
    let usage: AgentCliResult["usage"] = {};
    for (const line of stdout.split("\n").filter((line) => line.trim())) {
      this.inspectOutputLine!(line);
      const event = eventObject(line);
      if (terminal) throw agentFailure("agent_event_after_terminal");
      if (event.type === "error")
        throw agentReportedFailure(event.error ?? event.message);
      if (event.type === "init" && typeof event.model === "string")
        model = event.model;
      if (event.type === "message") {
        if (
          !["user", "assistant"].includes(event.role) ||
          typeof event.content !== "string"
        )
          throw agentFailure("invalid_agent_output");
        if (event.role === "assistant") {
          sawAssistant = true;
          text += event.content;
        }
      }
      if (event.type === "result") {
        if (event.status !== "success")
          throw agentReportedFailure(event.error ?? event.status);
        terminal = true;
        const stats = event.stats ?? {};
        for (const [key, value] of [
          ["inputTokens", stats.input_tokens],
          ["outputTokens", stats.output_tokens],
          ["cacheReadTokens", stats.cached],
        ] as const)
          if (tokenCount(value) !== undefined) usage[key] = value;
      }
    }
    if (!terminal || !sawAssistant)
      throw agentFailure("agent_terminal_missing");
    return {
      ...modelPayload(text),
      usage,
      ...(model ? { actualReportedModel: model } : {}),
    };
  },
};
