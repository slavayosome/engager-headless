import { getLLM } from "../../ai/client";
import {
  redraftAskedComments,
  type CommentRedraftPayload,
} from "../../workers/commentRedraft";
import type { JobResult, SelfScopedCtx } from "../worker";

/**
 * The owner asked for a comment again: every comment still asked for on the
 * campaign is written again by its Ambassador's writer and waits for a yes
 * (`workers/commentRedraft.ts`). Queued with one attempt: a rewrite that comes
 * to nothing says why on its comment and waits for the owner to ask again.
 */
export async function handleRedraftComments(
  ctx: SelfScopedCtx,
  payload: CommentRedraftPayload,
): Promise<JobResult> {
  const outcome = await redraftAskedComments(
    // Tests inject an LLM; production resolves the owner's own agent CLI, as
    // a worker run does.
    { organizationId: ctx.organizationId, llm: ctx.llm ?? getLLM() },
    payload.campaignId,
  );
  return {
    redrafted: outcome.redrafted.length,
    not_written: outcome.notWritten.length,
  };
}
