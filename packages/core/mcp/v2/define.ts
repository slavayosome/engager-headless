import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AppError } from "@engager/common/errors";
import { withOrg } from "@engager/database/tenant";
import { ownerTimeZone, readOwnerTimeZone, withLocalTimes } from "../../ownerClock";
import type { McpCtx } from "../context";
import { errorResult } from "../tools/util";

/**
 * The one registration path for the v2 tool surface. A tool is a thin adapter:
 * it parses its arguments, calls an operation in core and returns the result.
 * What this file enforces is what a host reads from `tools/list`, so a tool
 * that breaks a rule never reaches an agent's context.
 *
 * `read` changes nothing; `write` changes Engager's own state; `destructive`
 * deletes or overwrites; `linkedin` reaches the account. The kind is the only
 * source of the host-facing hints, so no tool states them by hand.
 */
export type V2Kind = "read" | "write" | "destructive" | "linkedin";

/** Every description is a contract of at most this many characters: what the
 *  tool does, what it refuses, which skill holds the playbook. */
export const MAX_DESCRIPTION_CHARS = 300;

export const ANNOTATIONS: Record<V2Kind, ToolAnnotations> = {
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  write: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  destructive: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  linkedin: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
};

/** What the registry hands a handler besides its arguments. */
export type V2Call = {
  ctx: McpCtx;
  /** Aborted when the host cancels the request. */
  signal: AbortSignal;
};

export type V2ToolSpec<I extends z.ZodTypeAny> = {
  name: string;
  kind: V2Kind;
  description: string;
  /** A flat object schema. Omit it for a tool that takes no arguments; its
   *  handler is then `(call) => …` and never reads any. */
  input?: I;
  handler: (call: V2Call, input: z.infer<I>) => Promise<CallToolResult>;
};

/** A validated spec, ready for `registerV2Tool`. */
export type V2Tool = {
  readonly name: string;
  readonly kind: V2Kind;
  readonly description: string;
  readonly input: z.ZodObject<z.ZodRawShape> | undefined;
  readonly handler: (call: V2Call, input: never) => Promise<CallToolResult>;
};

function malformed(name: unknown, why: string): never {
  throw new Error(`v2 tool "${String(name)}": ${why}`);
}

/**
 * The rules, checked where a tool is defined and again where it is registered
 * (a hand-built `V2Tool` skips the first). A tool that breaks one throws,
 * naming itself, so building the server fails instead of publishing it.
 */
function assertWellFormed(tool: {
  name: unknown;
  kind: unknown;
  description: unknown;
  input?: unknown;
  handler: unknown;
}): void {
  const { name, kind, description, input, handler } = tool;
  if (typeof name !== "string" || !/^[a-z][a-z0-9_]*$/.test(name)) {
    malformed(name, "name must be snake_case");
  }
  if (typeof kind !== "string" || !(kind in ANNOTATIONS)) {
    malformed(name, `kind must be one of ${Object.keys(ANNOTATIONS).join(", ")}`);
  }
  if (typeof description !== "string" || description.trim() === "") {
    malformed(name, "description is required");
  }
  if (description.length > MAX_DESCRIPTION_CHARS) {
    malformed(name, `description is ${description.length} characters, over ${MAX_DESCRIPTION_CHARS}`);
  }
  if (typeof handler !== "function") malformed(name, "handler is required");
  if (input === undefined) {
    // No-input handlers may have zero parameters or one plain call parameter.
    // Checking length alone misses defaulted and rest parameters.
    const source = Function.prototype.toString.call(handler).trim();
    const noInputSignature = /^(?:async\s*)?(?:\(\s*(?:[\w$]+)?\s*\)|[\w$]+)\s*=>/;
    const noInputFunction = /^(?:async\s+)?function(?:\s+[\w$]+)?\s*\(\s*(?:[\w$]+)?\s*\)/;
    if (!noInputSignature.test(source) && !noInputFunction.test(source)) {
      malformed(name, "a tool without input must have at most one plain call parameter");
    }
    return;
  }
  if (input instanceof z.ZodUnion || input instanceof z.ZodDiscriminatedUnion) {
    malformed(name, "input is a top-level union, which a host cannot read; use one flat object");
  }
  if (!(input instanceof z.ZodObject)) malformed(name, "input must be a flat z.object");
  if (Object.keys(input.shape).length === 0) {
    malformed(name, "the input publishes no properties; omit it for a tool without arguments");
  }
}

export function defineTool<I extends z.ZodTypeAny>(spec: V2ToolSpec<I>): V2Tool {
  assertWellFormed(spec);
  return spec as unknown as V2Tool;
}

/** A result with each moment's twin on the owner's clock beside it
 *  (`withLocalTimes`). A refusal, a body that is not JSON, one with no moment
 *  and an install with no known zone come back as they were. */
async function onOwnerClock(result: CallToolResult, ctx: McpCtx): Promise<CallToolResult> {
  const first = result.content[0];
  if (result.isError || first?.type !== "text") return result;
  let data: unknown;
  try {
    data = JSON.parse(first.text);
  } catch {
    return result;
  }
  const zone = ownerTimeZone(null) ?? (await withOrg(ctx.organizationId, readOwnerTimeZone));
  if (!zone) return result;
  const local = withLocalTimes(data, zone);
  if (JSON.stringify(local).length === JSON.stringify(data).length) return result;
  return { ...result, content: [{ ...first, text: JSON.stringify(local, null, 2) }, ...result.content.slice(1)] };
}

/** `input` as the registry checks it. A host that cannot tell an object or
 *  array argument from a string sends its JSON text instead, and that text is
 *  read back before the check. A field that takes the string as sent, and text
 *  that is not an object or array, reach the check unchanged. */
function readingJsonText(input: z.ZodObject<z.ZodRawShape>): z.ZodObject<z.ZodRawShape> {
  return input.extend(Object.fromEntries(Object.entries(input.shape).map(([key, field]) => [
    key,
    z.preprocess((value) => (typeof value === "string" && !field.safeParse(value).success ? jsonContainer(value) ?? value : value), field),
  ])));
}

function jsonContainer(text: string): object | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Register one tool on `server`. Called on a server whose `registerTool` is
 *  already wrapped for usage attribution, so every v2 handler is too. */
export function registerV2Tool(server: McpServer, ctx: McpCtx, tool: V2Tool): void {
  assertWellFormed(tool);
  const run = async (input: unknown, signal: AbortSignal): Promise<CallToolResult> => {
    try {
      return await onOwnerClock(
        await (tool.handler as (call: V2Call, input: unknown) => Promise<CallToolResult>)({ ctx, signal }, input),
        ctx,
      );
    } catch (error) {
      // A refused ref and any other typed domain refusal reach the agent as a
      // coded result it can act on, not as a protocol error.
      if (error instanceof AppError) {
        return errorResult(error.message, { code: error.code, status: error.status });
      }
      throw error;
    }
  };
  const config = { description: tool.description, annotations: ANNOTATIONS[tool.kind] };
  // The SDK calls a tool without an input schema as (extra), not (args, extra).
  const register = server.registerTool.bind(server) as (
    name: string,
    config: unknown,
    callback: (...args: never[]) => unknown,
  ) => unknown;
  if (tool.input) {
    register(tool.name, { ...config, inputSchema: readingJsonText(tool.input) }, (async (
      input: unknown,
      extra: { signal: AbortSignal },
    ) => run(input, extra.signal)) as never);
  } else {
    register(tool.name, config, (async (extra: { signal: AbortSignal }) =>
      run(undefined, extra.signal)) as never);
  }
}
