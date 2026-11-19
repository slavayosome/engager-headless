import { z } from "zod";
import { AppError } from "@engager/common/errors";
import type { Tx } from "@engager/database/tenant";
import { llmWithSignal } from "../../ai/client";
import { readLookalike, requestLookalike } from "../../discovery/lookalike";
import { judgeHostLookalike } from "../../jobs/handlers/searchLookalike";
import { PostThreadSchema } from "../../linkedin/browser-use/protocol";
import { postUrnFromUrl } from "../../linkedin/postUrl";
import type { McpCtx } from "../context";
import { assertHostedMcpExternalPhase, withHostedMcpScope } from "./hostedSpend";

export const PROPOSE_SEARCHES_FROM_POST = "propose_searches_from_post";
export const lookalikeToolInput = z.object({
  campaignId: z.number().int().positive(), url: z.string().trim().min(1).max(3000).optional(),
  lookalikeId: z.number().int().positive().optional(), thread: PostThreadSchema.optional(),
}).strict();

export async function requestAndWaitLookalike(ctx: McpCtx, signal: AbortSignal,
  input: z.infer<typeof lookalikeToolInput>, options: { waitMs?: number; sleep?: (ms: number) => Promise<void> } = {}) {
  const scope = <T>(work: (tx: Tx) => Promise<T>) => withHostedMcpScope(ctx, signal, "messages:write", work);
  const beforeExternal = () => assertHostedMcpExternalPhase(ctx, signal, "messages:write");
  if (input.lookalikeId !== undefined) {
    if (input.url !== undefined || input.thread !== undefined) throw new AppError("invalid_lookalike_request", "Read a saved request by its id, without another link or thread.", 400);
    return scope((tx) => readLookalike(tx, input.campaignId, input.lookalikeId!));
  }
  if (!input.url || !postUrnFromUrl(input.url)) throw new AppError("not_a_post", "This isn't a LinkedIn post link.", 400);
  if (input.thread && input.thread.postUrn !== postUrnFromUrl(input.url)) {
    throw new AppError("lookalike_thread_mismatch", "That thread belongs to a different post.", 400);
  }
  const row = await scope((tx) => requestLookalike(tx, input.campaignId, input.url!, { hostRead: !!input.thread }));
  if (row.status === "reading" && row.reader === "agent" && input.thread) {
    await judgeHostLookalike({ campaignId: input.campaignId, lookalikeId: row.id, thread: input.thread,
      llm: llmWithSignal(ctx.llm, signal), scope, beforeExternal });
  }
  const deadline = Date.now() + Math.min(90_000, Math.max(0, options.waitMs ?? 90_000));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new AppError("request_cancelled", "The room request is still saved; no extra read was requested.", 409)); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  }));
  while (true) {
    const current = await scope((tx) => readLookalike(tx, input.campaignId, row.id));
    if (current.status !== "reading" || Date.now() >= deadline) return current;
    await sleep(Math.min(3000, deadline - Date.now()));
  }
}
