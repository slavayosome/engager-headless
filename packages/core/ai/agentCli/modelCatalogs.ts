import { homedir } from "node:os";
import { agentExecutablePath, isolatedAuthStore } from "./authStore";
import { dirname, join } from "node:path";
import { realpath } from "node:fs/promises";
import { z } from "zod";
import { agentFailure } from "./state";
import { readConfiguredBounded, runMetadataProbe } from "./metadata";
import type {
  ModelListResult,
  ModelMetadataContext,
  ReportedModel,
} from "./types";

/** The alphabet a reported id may use — the same one the selection request
 *  accepts, plus the `[1m]` context suffix Claude reports on its own ids. */
const modelId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\w.:@+/-]+(?:\[1m\])?$/);

/** One line of a protocol's stdout, as data. A line that is not JSON is not a
 *  protocol message — every reader below matches on shape rather than position,
 *  so a banner or a warning is dropped instead of failing the read. */
function protocolLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}

/** The one control response Claude's picker reads, matched on its own shape so
 *  an unrelated event on the same stream can never stand in for it. */
const claudeModelList = z.object({
  type: z.literal("control_response"),
  response: z.object({
    request_id: z.string(),
    subtype: z.literal("success"),
    response: z.object({
      models: z
        .array(
          z.object({
            value: modelId,
            resolvedModel: modelId.optional(),
            displayName: z.string(),
            description: z.string().optional(),
            supportedEffortLevels: z.array(z.string()).max(12).optional(),
          }),
        )
        .min(1)
        .max(200),
    }),
  }),
});

/** Claude's initialize response is the same metadata used by its model picker.
 * No user message is sent. Tools, hooks, project settings and MCP stay disabled.
 *
 * The models are the OWNER'S account's, so this is the one probe that runs
 * against their real Claude home rather than the private profile
 * `runMetadataProbe` hands every other read. `claudeAdapter` marks the route
 * `readsOwnerAuthStore`, which binds it to the same version admission execution
 * has: an installation this build cannot admit never reaches this function. */
export async function listClaudeModels(
  context: ModelMetadataContext,
): Promise<ModelListResult> {
  const requestId = "engager-models";
  const authStore = isolatedAuthStore("claude", context.authStorePath);
  const result = await runMetadataProbe(context.absoluteExecutable, {
    args: [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json",
      "--verbose", "--tools", "", "--strict-mcp-config",
      "--mcp-config", '{"mcpServers":{}}', "--safe-mode", "--restricted",
      "--setting-sources", "", "--settings", '{"disableAllHooks":true}',
      "--disable-slash-commands", "--no-chrome", "--no-session-persistence",
      "--permission-mode", "dontAsk",
    ],
    env: {
      HOME: homedir(),
      PATH: agentExecutablePath(),
      ...(authStore ? { CLAUDE_CONFIG_DIR: authStore } : {}),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ...(process.env.ENGAGER_DEV_APP === "1" ? { DISABLE_AUTOUPDATER: "1" } : {}),
    },
    input:
      JSON.stringify({
        type: "control_request",
        request_id: requestId,
        request: { subtype: "initialize", hooks: {} },
      }) + "\n",
    signal: context.signal,
    timeoutMs: 10_000,
  });
  if (result.code !== 0 || result.truncated)
    throw agentFailure("agent_metadata_invalid");
  const reply = result.stdout
    .split("\n")
    .map((line) => claudeModelList.safeParse(protocolLine(line)))
    .find((event) => event.success && event.data.response.request_id === requestId);
  if (!reply?.success) throw agentFailure("agent_metadata_invalid");
  const models = new Map<string, ReportedModel>();
  for (const row of reply.data.response.response.models) {
    // Resolve aliases to the exact release the installation reports, without
    // replacing or guessing version numbers in Engager.
    const id = row.resolvedModel ?? row.value;
    // Claude reports the levels per row and no default level: the CLI's own
    // default applies when the owner picks none.
    const efforts = row.supportedEffortLevels?.length
      ? { efforts: row.supportedEffortLevels }
      : {};
    if (!models.has(id))
      models.set(id, {
        id,
        label: row.description?.split(" · ")[0] || row.displayName,
        ...(row.value === "default" ? { reportedDefault: true } : {}),
        ...efforts,
      });
    // The alias row carries the release's own description; `default` names
    // whichever release it points at and would label every model "Default".
    else if (row.value !== "default" && row.description)
      models.set(id, {
        ...models.get(id)!,
        label: row.description.split(" · ")[0]!,
      });
  }
  return {
    models: [...models.values()],
    providerRef: "anthropic",
    source: "Models reported by your Claude installation",
  };
}

/** Codex's `model/list` reply, matched on the id its own request carried. */
const codexModelList = z.object({
  id: z.literal(2),
  result: z.object({
    data: z
      .array(
        z.object({
          id: modelId,
          model: modelId.optional(),
          displayName: z.string(),
          isDefault: z.boolean().optional(),
          hidden: z.boolean().optional(),
          supportedReasoningEfforts: z
            .array(z.object({ reasoningEffort: z.string() }).passthrough())
            .max(12)
            .optional(),
          defaultReasoningEffort: z.string().nullish(),
        }).passthrough(),
      )
      .min(1)
      .max(200),
    nextCursor: z.string().nullish(),
  }),
});

/** A metadata-only app-server connection: initialize then model/list. No thread,
 * turn or inference request is ever created. EOF shuts the server down.
 *
 * Like Claude's, this list is the owner's account's and runs against their real
 * `CODEX_HOME`; `codexAdapter` marks the route `readsOwnerAuthStore` so an
 * unadmitted version is never spawned against it. */
export async function listCodexModels(
  context: ModelMetadataContext,
): Promise<ModelListResult> {
  let initialized = false;
  const result = await runMetadataProbe(context.absoluteExecutable, {
    args: ["app-server", "-c", "mcp_servers={}", "-c", "plugins={}"],
    env: {
      HOME: homedir(),
      CODEX_HOME: isolatedAuthStore("codex", context.authStorePath) ?? join(homedir(), ".codex"),
    },
    input:
      JSON.stringify({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "engager_model_discovery", version: "1" },
        },
      }) + "\n",
    onLine(line) {
      const message = z
        .object({ id: z.number(), error: z.unknown().optional() })
        .safeParse(protocolLine(line));
      if (!message.success) return undefined;
      if (message.data.id === 1 && !initialized) {
        initialized = true;
        if (message.data.error) throw agentFailure("agent_metadata_invalid");
        return {
          input:
            JSON.stringify({ method: "initialized" }) + "\n" +
            JSON.stringify({
              id: 2,
              method: "model/list",
              params: { includeHidden: false, limit: 100 },
            }) + "\n",
        };
      }
      if (message.data.id === 2) return { closeInput: true };
      return undefined;
    },
    signal: context.signal,
    timeoutMs: 10_000,
  });
  if (result.code !== 0 || result.truncated)
    throw agentFailure("agent_metadata_invalid");
  const reply = result.stdout
    .split("\n")
    .map((line) => codexModelList.safeParse(protocolLine(line)))
    .find((event) => event.success);
  if (!reply?.success) throw agentFailure("agent_metadata_invalid");
  const { data, nextCursor } = reply.data.result;
  return {
    models: data
      .filter((row) => !row.hidden)
      .map((row) => ({
        id: row.model ?? row.id,
        label: row.displayName,
        reportedDefault: row.isDefault ?? false,
        ...(row.supportedReasoningEfforts?.length
          ? {
              // `ultra` is not a depth: Codex describes it as "automatic task
              // delegation", i.e. spawning sub-agents inside an isolated,
              // single-shot judgment call. Not offered.
              efforts: row.supportedReasoningEfforts
                .map((entry) => entry.reasoningEffort)
                .filter((level) => level !== "ultra"),
              ...(row.defaultReasoningEffort
                ? { defaultEffort: row.defaultReasoningEffort }
                : {}),
            }
          : {}),
      })),
    providerRef: "openai",
    source: "Models reported by your Codex installation",
    partial: Boolean(nextCursor),
  };
}

/** How deep beside the executable the installed package may sit before this
 *  gives up looking for it. */
const GEMINI_PACKAGE_DEPTH = 6;

/** Gemini 0.30's ACP protocol does not enumerate models. Read its installed
 * package's literal catalog as DATA: no importing/executing package or settings.
 * This is the CLI's supported list, not proof of the owner's account access. */
export async function listGeminiModels(
  context: ModelMetadataContext,
): Promise<ModelListResult> {
  let directory = dirname(await realpath(context.absoluteExecutable));
  for (let depth = 0; depth < GEMINI_PACKAGE_DEPTH; depth++) {
    if (context.signal.aborted) throw agentFailure("agent_canceled");
    const text = await readConfiguredBounded(join(directory, "package.json"), {
      signal: context.signal,
    });
    const manifest = text
      ? z.object({ name: z.string() }).safeParse(protocolLine(text))
      : undefined;
    if (manifest?.success && manifest.data.name === "@google/gemini-cli") {
      const catalog = await readConfiguredBounded(
        join(
          directory,
          "node_modules/@google/gemini-cli-core/dist/src/config/models.js",
        ),
        { signal: context.signal },
      );
      // The package's own layout: the catalog may live a directory up from the
      // manifest that named it, so keep walking rather than give up here.
      if (!catalog) {
        directory = dirname(directory);
        continue;
      }
      const constants = new Map(
        [
          ...catalog.matchAll(
            /export const ([A-Z][A-Z0-9_]*)\s*=\s*['"]([^'"\r\n]+)['"]/g,
          ),
        ].map((match) => [match[1]!, match[2]!]),
      );
      const members = catalog.match(
        /export const VALID_GEMINI_MODELS\s*=\s*new Set\(\[([^\]]+)\]\)/,
      )?.[1];
      if (!members) break;
      const ids = members
        .split(",")
        .map((symbol) => constants.get(symbol.trim()))
        .filter(
          (id): id is string =>
            typeof id === "string" && modelId.safeParse(id).success,
        );
      if (!ids.length) break;
      return {
        models: [...new Set(ids)].map((id) => ({ id, label: id })),
        providerRef: "google",
        source:
          "Models supported by your installed Gemini CLI; account access is checked when connecting",
      };
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw agentFailure("agent_metadata_invalid");
}
