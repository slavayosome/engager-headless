import type { ActionRedraftPayload } from "../../actions/ledger";
import { getLLM } from "../../ai/client";
import { abandonAskedRedraft, redraftAskedAction } from "../../agentStep/redraft";
import { trackDraftDelivered } from "../../telemetry/emit";
import type { JobResult, SelfScopedCtx } from "../worker";

/**
 * The owner asked for a DM or follow-up again: its step's writer writes it
 * again from their conversation as it stands, and it waits for their yes
 * (`agentStep/redraft.ts` `redraftAskedAction`). One model call, made with no
 * transaction held; queued with one attempt, since a rewrite that comes to
 * nothing says so on the draft and waits for the owner to ask again —
 * whatever stopped it, a failure here closes the ask as not written first,
 * so the draft never reads "Redrafting…" for a rewrite that is not coming.
 */
export async function handleRedraftAction(
  ctx: SelfScopedCtx,
  payload: ActionRedraftPayload,
): Promise<JobResult> {
  const started = Date.now();
  try {
    const outcome = await redraftAskedAction(
      // Tests inject an LLM; production resolves the owner's own agent CLI,
      // as a worker run does.
      { organizationId: ctx.organizationId, llm: ctx.llm ?? getLLM() },
      payload.actionId,
    );
    trackDraftDelivered({
      kind: "redraft",
      outcome: outcome === "redrafted" ? "ok" : "failed",
      durationMs: Date.now() - started,
    });
    return { [outcome]: 1 };
  } catch (error) {
    trackDraftDelivered({ kind: "redraft", outcome: "failed", durationMs: Date.now() - started });
    await abandonAskedRedraft(ctx.organizationId, payload.actionId);
    throw error;
  }
}
