import { withOrg, type Tx } from "@engager/database/tenant";
import {
  applyPreparedCampaignDistillation,
  prepareCampaignDistillation,
  writePreparedCampaignDistillation,
} from "../../learning/distill";
import { jobGuardedLlm } from "../providerGuard";
import { assertHostedJobSpendStillAllowedInTx } from "../spendAccess";
import type { SelfScopedCtx } from "../worker";

export class DistillStaleSnapshotError extends Error {
  constructor() {
    super("feedback or guidance changed while distillation was in flight");
    this.name = "DistillStaleSnapshotError";
  }
}

export type DistillOrgScope = <T>(work: (tx: Tx) => Promise<T>) => Promise<T>;

/** Canonical worker path: snapshot -> release -> LLM -> lease-fenced CAS. */
export async function handleDistillPhased(
  ctx: SelfScopedCtx,
  payload: { campaignId: number },
  orgScope: DistillOrgScope = (work) => withOrg(ctx.organizationId, work),
): Promise<void> {
  const prepared = await orgScope(async (tx) => {
    await assertHostedJobSpendStillAllowedInTx(tx, ctx);
    return prepareCampaignDistillation(tx, payload.campaignId);
  });
  if (!prepared) return;
  const guidance = await writePreparedCampaignDistillation(
    prepared,
    jobGuardedLlm(ctx),
  );
  if (!guidance) return;
  const applied = await orgScope(async (tx) => {
    await assertHostedJobSpendStillAllowedInTx(tx, ctx);
    return applyPreparedCampaignDistillation(tx, prepared, guidance);
  });
  if (!applied) throw new DistillStaleSnapshotError();
}
