import { getLLM } from "../../ai/client";
import { redraftForVoice, type VoiceRedraftPayload } from "../../agentStep/redraft";
import type { JobResult, SelfScopedCtx } from "../worker";

/**
 * A campaign's voice moved: its drafts still waiting are written again in the
 * voice its active version states (`agentStep/redraft.ts`). Every model call
 * is made with no transaction held, and each draft is written back in its own
 * short one.
 */
export async function handleRedraftForVoice(
  ctx: SelfScopedCtx,
  payload: VoiceRedraftPayload,
): Promise<JobResult> {
  const outcome = await redraftForVoice(
    // Tests inject an LLM; production resolves the owner's own agent CLI, as
    // a worker run does.
    { organizationId: ctx.organizationId, llm: ctx.llm ?? getLLM() },
    payload.campaignId,
  );
  return {
    replies: outcome.replies.length,
    actions: outcome.actions.length,
    checkpoints: outcome.checkpoints.length,
    invalidated_approvals: outcome.invalidatedApprovals,
  };
}
