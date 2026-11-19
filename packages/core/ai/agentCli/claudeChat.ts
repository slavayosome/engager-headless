import { roleModels } from "../modelRoles";
import type {
  AgentChatSurface,
  ChatDriverEvent,
  ChatSpawnOpts,
  ChatStreamParser,
} from "./types";

/**
 * DEAD COMPATIBILITY MODULE — the surface below has no production caller since
 * P2b: in-app chat runs the shared broker (`packages/core/chat/broker.ts`) over
 * `runAgentCli`, and `claudeAdapter.chat.transport` is `"broker"`. Kept beside
 * the adapter, un-refactored, while the legacy CLI driver it feeds still exists;
 * see `apps/dashboard/lib/chat/claudeCliDriver.ts`.
 *
 * Claude Code as the dashboard chat backend: one streaming `claude -p` turn,
 * resumable across turns, with the chat MCP child armed.
 *
 * Beside the one-shot background adapter rather than in the dashboard, because
 * the NDJSON the parser below reads is emitted by the argv above it — two
 * halves of one agent's wire format that used to sit a package apart, so a
 * second agent meant writing the whole shape twice. The parser, its helpers,
 * the argv vector and the env allowlist moved here verbatim from
 * `apps/dashboard/lib/chat/claudeCliDriver.ts`; process management, the session
 * store and the AI-SDK translation stayed there, because none of them is
 * agent-specific.
 */

/**
 * Stateful translator from claude CLI stream-json NDJSON objects to normalized
 * ChatDriverEvents. Kept separate from process management so tests can feed it
 * captured fixture lines without ever spawning the real CLI.
 *
 * Shape notes from the 2.1.220 smoke fixtures:
 * - `assistant` events repeat (one per completed content block, cumulative),
 *   so tool_use inputs and fallback text must dedupe.
 * - `assistant` can arrive BEFORE the block's content_block_stop; a text block
 *   that streamed any delta is skipped by the fallback.
 * - tool_result blocks carry only tool_use_id; the tool name is recovered from
 *   the tool_use that introduced the id.
 * - Ignorable types: system/{hook_started,hook_response,status,thinking_tokens},
 *   rate_limit_event, stream_event/{message_delta}, and anything unknown.
 */
class ClaudeStreamParser implements ChatStreamParser {
  private step = -1;
  private blockKind = new Map<number, "text" | "reasoning" | "tool">();
  private blockToolCallId = new Map<number, string>();
  private toolNames = new Map<string, string>();
  private streamedText = new Set<string>();
  /** Accumulated delta text per streamed block — the content half of the
   *  fallback dedupe (see onAssistant). */
  private streamedTextAccum = new Map<string, string>();
  private emittedToolInputs = new Set<string>();
  private emittedFallbackText = new Set<string>();
  private emittedFallbackContent = new Set<string>();
  sawResult = false;

  private blockId(index: number): string {
    return `s${this.step}b${index}`;
  }

  push(line: string): ChatDriverEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      return []; // non-JSON noise on stdout; ignore
    }
    if (typeof raw !== "object" || raw === null) return [];
    const d = raw as Record<string, unknown>;
    switch (d.type) {
      case "system":
        if (d.subtype === "init" && typeof d.session_id === "string") {
          return [{ kind: "session", sessionId: d.session_id }];
        }
        return [];
      case "stream_event":
        return this.onStreamEvent(d.event as Record<string, unknown> | undefined);
      case "assistant":
        return this.onAssistant(d.message as Record<string, unknown> | undefined);
      case "user":
        return this.onUser(d.message as Record<string, unknown> | undefined);
      case "result":
        return this.onResult(d);
      default:
        return [];
    }
  }

  private onStreamEvent(event: Record<string, unknown> | undefined): ChatDriverEvent[] {
    if (!event) return [];
    switch (event.type) {
      case "message_start": {
        this.step += 1;
        this.blockKind.clear();
        this.blockToolCallId.clear();
        return [{ kind: "step-start" }];
      }
      case "content_block_start": {
        const index = typeof event.index === "number" ? event.index : 0;
        const block = (event.content_block ?? {}) as Record<string, unknown>;
        if (block.type === "text") {
          this.blockKind.set(index, "text");
          return [{ kind: "text-start", id: this.blockId(index) }];
        }
        if (block.type === "thinking") {
          this.blockKind.set(index, "reasoning");
          return [{ kind: "reasoning-start", id: this.blockId(index) }];
        }
        if (block.type === "tool_use") {
          const toolCallId = typeof block.id === "string" ? block.id : this.blockId(index);
          const toolName = typeof block.name === "string" ? block.name : "unknown";
          this.blockKind.set(index, "tool");
          this.blockToolCallId.set(index, toolCallId);
          this.toolNames.set(toolCallId, toolName);
          return [{ kind: "tool-start", toolCallId, toolName }];
        }
        return [];
      }
      case "content_block_delta": {
        const index = typeof event.index === "number" ? event.index : 0;
        const delta = (event.delta ?? {}) as Record<string, unknown>;
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          const id = this.blockId(index);
          this.streamedText.add(id);
          this.streamedTextAccum.set(id, (this.streamedTextAccum.get(id) ?? "") + delta.text);
          return [{ kind: "text-delta", id, delta: delta.text }];
        }
        if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          return [
            { kind: "reasoning-delta", id: this.blockId(index), delta: delta.thinking },
          ];
        }
        if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const toolCallId = this.blockToolCallId.get(index);
          if (toolCallId) {
            return [{ kind: "tool-input-delta", toolCallId, delta: delta.partial_json }];
          }
        }
        return [];
      }
      case "content_block_stop": {
        const index = typeof event.index === "number" ? event.index : 0;
        const kind = this.blockKind.get(index);
        if (kind === "text") return [{ kind: "text-end", id: this.blockId(index) }];
        if (kind === "reasoning")
          return [{ kind: "reasoning-end", id: this.blockId(index) }];
        return []; // tool input completion comes from the assistant event
      }
      case "message_stop":
        return [{ kind: "step-end" }];
      default:
        return [];
    }
  }

  private onAssistant(message: Record<string, unknown> | undefined): ChatDriverEvent[] {
    const content = Array.isArray(message?.content) ? message.content : [];
    const events: ChatDriverEvent[] = [];
    content.forEach((rawBlock: unknown, position: number) => {
      if (typeof rawBlock !== "object" || rawBlock === null) return;
      const block = rawBlock as Record<string, unknown>;
      if (block.type === "tool_use" && typeof block.id === "string") {
        if (this.emittedToolInputs.has(block.id)) return;
        this.emittedToolInputs.add(block.id);
        const toolName =
          typeof block.name === "string" ? block.name : (this.toolNames.get(block.id) ?? "unknown");
        this.toolNames.set(block.id, toolName);
        events.push({
          kind: "tool-input",
          toolCallId: block.id,
          toolName,
          input: block.input ?? {},
        });
        return;
      }
      // Belt-and-braces: if stream_event deltas never arrived for a text block
      // (shape drift, --include-partial-messages regression), emit its full
      // text once from the completed snapshot so chat still works. Deduped by
      // POSITION and by CONTENT: the snapshot's content index can drift from
      // the stream's block index (thinking blocks, a snapshot landing after
      // the next message_start bumped the step), and a positional miss there
      // used to re-emit an already-streamed paragraph as a duplicate part.
      if (block.type === "text" && typeof block.text === "string" && block.text) {
        const streamId = this.blockId(position);
        const fallbackId = `s${this.step}f${position}`;
        if (this.streamedText.has(streamId) || this.emittedFallbackText.has(fallbackId)) return;
        if (this.emittedFallbackContent.has(block.text)) return;
        for (const streamed of this.streamedTextAccum.values()) {
          if (streamed === block.text) return;
        }
        this.emittedFallbackText.add(fallbackId);
        this.emittedFallbackContent.add(block.text);
        events.push(
          { kind: "text-start", id: fallbackId },
          { kind: "text-delta", id: fallbackId, delta: block.text },
          { kind: "text-end", id: fallbackId },
        );
      }
    });
    return events;
  }

  private onUser(message: Record<string, unknown> | undefined): ChatDriverEvent[] {
    const content = Array.isArray(message?.content) ? message.content : [];
    const events: ChatDriverEvent[] = [];
    for (const rawBlock of content) {
      if (typeof rawBlock !== "object" || rawBlock === null) continue;
      const block = rawBlock as Record<string, unknown>;
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      events.push({
        kind: "tool-output",
        toolCallId: block.tool_use_id,
        toolName: this.toolNames.get(block.tool_use_id) ?? "unknown",
        output: parseToolResultContent(block.content),
        isError: block.is_error === true,
      });
    }
    return events;
  }

  private onResult(d: Record<string, unknown>): ChatDriverEvent[] {
    this.sawResult = true;
    const isError = d.is_error === true;
    return [
      {
        kind: "result",
        isError,
        ...(isError
          ? {
              errorText:
                typeof d.result === "string" && d.result
                  ? d.result
                  : `claude exited with ${String(d.subtype ?? "error")}`,
            }
          : {}),
        usage: {
          ...(typeof d.total_cost_usd === "number" ? { costUsd: d.total_cost_usd } : {}),
          ...(typeof d.num_turns === "number" ? { numTurns: d.num_turns } : {}),
          ...(typeof d.duration_ms === "number" ? { durationMs: d.duration_ms } : {}),
        },
      },
    ];
  }
}

/**
 * MCP tool results arrive as [{type:"text", text:"<json>"}]; surface the parsed
 * JSON when it parses so the deck card can read structured output directly.
 */
function parseToolResultContent(content: unknown): unknown {
  if (typeof content === "string") return tryJson(content);
  if (!Array.isArray(content)) return content ?? null;
  const firstText = content.find(
    (b): b is { type: "text"; text: string } =>
      typeof b === "object" &&
      b !== null &&
      (b as Record<string, unknown>).type === "text" &&
      typeof (b as Record<string, unknown>).text === "string",
  );
  return firstText ? tryJson(firstText.text) : content;
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * How long the CLI waits on ONE Engager MCP tool before giving up on it.
 *
 * Engager's tools are the slow kind by nature: `seed_brain`
 * drives the owner's real browser through their own posts and then extracts
 * every chunk through a model, and `discover` sweeps LinkedIn. Claude Code's
 * default ceiling is a minute, which those exceed routinely — the owner read
 * "The operation timed out." on the very first Brain seed of a fresh install
 * and the chat then reported an empty Brain. Held just under the driver's own
 * five-minute turn timeout (apps/dashboard/lib/chat/claudeCliDriver.ts) so a
 * genuinely stuck tool still surfaces as a tool failure inside the turn, with
 * whatever earlier chunks already wrote left standing.
 */
const MCP_TOOL_TIMEOUT_MS = 4 * 60 * 1000;

/** Spawn env allowlist. Never spread process.env: the dashboard's .env.local
 *  carries ANTHROPIC_API_KEY, and leaking it would silently switch the CLI
 *  from the user's subscription to API-key billing. */
function spawnEnv(): NodeJS.ProcessEnv {
  const env: Record<string, string> = {
    TERM: "dumb",
    MCP_TOOL_TIMEOUT: String(MCP_TOOL_TIMEOUT_MS),
  };
  for (const key of ["HOME", "PATH", "USER", "SHELL", "NODE_ENV"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env as NodeJS.ProcessEnv;
}

/** The model a chat turn asks for when its caller names none — the `chat` role,
 *  off the registry every other role resolves through. Asked of the leaf rather
 *  than `modelFor`, because a chat turn stands outside every usage scope, where
 *  `modelFor` throws by design. One statement of it, emitted into argv below
 *  and reported by `model()` for the Agent page. */
function chatModel(): string {
  return roleModels().chat;
}

/**
 * The chat lane speaks the background vocabulary now: `ENGAGER_AGENT_CLI_BIN`
 * names the binary and `ENGAGER_MODEL_CHAT` the model, so the id a turn asks
 * for is one the price table carries and the declared-model check gates — where
 * the private pair it read until T-9.6 defaulted to the CLI alias `"sonnet"`,
 * which neither does. `bin()` STATES the read `claudeAdapter.bin` makes rather
 * than importing it: `claude.ts` imports this file, and the reverse import
 * would close a cycle.
 *
 * The turn's budget stays off that vocabulary: `maxBudgetUsd` is required on
 * the request, so the caller states the ceiling on every turn and this file
 * spends only what it is given.
 */
export const claudeChatSurface: AgentChatSurface = {
  bin(): string {
    return process.env.ENGAGER_AGENT_CLI_BIN ?? "claude";
  },

  model: chatModel,

  buildArgs(opts: ChatSpawnOpts): string[] {
    return [
      "-p",
      opts.userText,
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose", // required with -p + stream-json on 2.1.220
      ...(opts.resume
        ? ["--resume", opts.sessionId]
        : ["--session-id", opts.sessionId]),
      "--strict-mcp-config",
      ...(opts.mcpConfig ? ["--mcp-config", opts.mcpConfig] : []),
      ...(opts.allowedTools?.length ? ["--allowedTools", opts.allowedTools.join(",")] : []),
      // Read-only web tools stay available for fact-grounded drafting (the
      // campaign's webFacts instructions rely on them); everything that can
      // touch the machine stays blocked.
      "--tools",
      "Skill,WebSearch,WebFetch",
      "--disallowedTools",
      "Bash,Edit,Write,NotebookEdit,Task,KillShell",
      "--permission-mode",
      "dontAsk",
      ...(opts.systemPromptSuffix ? ["--append-system-prompt", opts.systemPromptSuffix] : []),
      "--model",
      opts.model ?? chatModel(),
      "--max-budget-usd",
      String(opts.maxBudgetUsd),
    ];
  },

  createParser(): ChatStreamParser {
    return new ClaudeStreamParser();
  },

  spawnEnv,
};
