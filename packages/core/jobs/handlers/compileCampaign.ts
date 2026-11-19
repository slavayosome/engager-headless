import { getLLM } from "../../ai/client";
import { compileCampaignBrief } from "../../brain/compile";
import { warmCompiledRules } from "../../dispatcher/phase";
import type { SelfScopedCtx } from "../worker";
import { assertHostedJobSpendStillAllowed } from "../spendAccess";

/**
 * Compile a campaign's focus brief from the org-wide Brain, then its writing
 * rules where they changed, so no draft waits on either. SELF-SCOPED: unlike
 * the other handlers it is NOT wrapped in `withOrg` by the worker — it manages
 * its own short read/write txs around each model call so the pooled connection
 * is released across it (the snapshot→release→LLM→short-write-CAS dance,
 * 133f979).
 */
export async function handleCompileCampaign(
  ctx: SelfScopedCtx,
  payload: { campaignId: number },
): Promise<void> {
  await compileCampaignBrief(ctx.organizationId, payload.campaignId, {
    llm: ctx.llm,
    beforeExternalPhase: () => assertHostedJobSpendStillAllowed(ctx),
  });
  await assertHostedJobSpendStillAllowed(ctx);
  await warmCompiledRules(ctx.organizationId, ctx.llm ?? getLLM(), payload.campaignId);
}
