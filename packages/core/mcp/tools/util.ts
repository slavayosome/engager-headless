import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Wrap any JSON-serialisable value as a tool result (agents parse the text). */
export function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/** A tool error result — the agent sees `isError`, a stable code when supplied,
 *  and a recovery hint without needing to parse prose. */
export function errorResult(
  message: string,
  details: {
    code?: string;
    status?: number;
    recovery?: string;
    /** Structured payload a caller needs in order to retry, merged alongside
     *  the error. Recovery prose tells a model what to do; this carries what a
     *  card needs to actually do it. */
    data?: Record<string, unknown>;
  } = {},
): CallToolResult {
  const { data, ...rest } = details;
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: message, ...rest, ...data }, null, 2),
      },
    ],
    isError: true,
  };
}
