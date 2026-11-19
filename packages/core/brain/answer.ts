import { eq } from "drizzle-orm";
import { brainQuestions } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import type { LLM } from "../ai/client";
import { assessBrain } from "./assess";
import { enqueueRecompileForCampaigns } from "./compile";
import { syncVaultMirror, vaultReplicaEnabled } from "./mirror";
import { storeKnowledge } from "./knowledge";
import { lockBrainMutation } from "./mutationLock";

/**
 * Record an answer to an interview question: store it as `interview` knowledge in
 * the question's slot, mark the question answered, then re-assess coverage.
 *
 * Note: answering deliberately does NOT regenerate questions — the queue is meant
 * to drain and rest once answered. New questions come from an explicit "ask me
 * more" or the daily `refresh_brain` job (and only for slots still weak).
 *
 * Returns whether the answer actually changed the vault — what the recompile,
 * and a caller that took `deferRecompile` to own it, key on.
 */
export async function answerQuestion(
  tx: Tx,
  opts: {
    questionId: number;
    answer: string;
    llm?: LLM;
    /** Interactive phased callers refresh coverage after releasing this tx. */
    deferAssessment?: boolean;
    /** The CALLER owns the recompile wave, and must route it. `compile_campaign`
     *  is a job, so on an install with no agent process the enqueue below is an
     *  orphan row per non-archived target — one per answered question. A caller
     *  that can resolve the judgment policy takes this and calls `routeCompile`
     *  inside the same transaction, which keeps the batch boundary where it was. */
    deferRecompile?: boolean;
  },
): Promise<{ changed: boolean }> {
  // Serialize against every other vault mutation (seed/refresh/store) so the
  // note-id scan below can't race another writer onto the same id.
  await lockBrainMutation(tx);
  const [q] = await tx
    .select()
    .from(brainQuestions)
    .where(eq(brainQuestions.id, opts.questionId));
  if (!q) throw new Error(`brain question ${opts.questionId} not found`);

  const r = await storeKnowledge(tx, {
    slot: q.slot,
    content: opts.answer,
    source: "interview",
  });

  await tx
    .update(brainQuestions)
    .set({ status: "answered", answer: opts.answer, answeredAt: Date.now() })
    .where(eq(brainQuestions.id, opts.questionId));

  if (!opts.deferAssessment) await assessBrain(tx, opts.llm);

  // Batch boundary: a new answer changed the Brain → recompile active campaigns.
  if (r.changed && !opts.deferRecompile) await enqueueRecompileForCampaigns(tx);
  if (r.changed && vaultReplicaEnabled()) await syncVaultMirror(tx);
  return { changed: r.changed };
}
