import { and, desc, eq, sql } from "drizzle-orm";
import { jobs } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { enqueue } from "../jobs/queue";

/**
 * A NEW VOICE'S DESCRIPTION, DRAFTED FROM THE OWNER'S OWN WRITING ON LINKEDIN.
 *
 * Create queues it when the owner asks for it. The agent process, which holds
 * the account, runs the relearn engine for that voice
 * (`jobs/handlers/relearnVoiceDescription.ts`), and what it drafts waits on
 * the voice as a proposal for Keep or Drop — never as the description itself,
 * and never as a value How you write reads.
 */

/** One voice's draft, asked for when it was created. */
export type VoiceDescriptionDraftPayload = { voiceId: number };

/** Queue the draft for a voice just created — once per voice: a draft is
 *  asked for at Create, and a later one is a relearn. */
export async function enqueueVoiceDescriptionDraft(tx: Tx, voiceId: number): Promise<void> {
  const payload: VoiceDescriptionDraftPayload = { voiceId };
  await enqueue(tx, {
    type: "relearn_voice_description",
    payload,
    idempotencyKey: `relearn_voice_description:${voiceId}`,
    // An account read and a distillation: one retry for a passing failure,
    // never a loop of reads on the owner's account.
    maxAttempts: 2,
  });
}

/** Where a voice's draft stands: asked and not yet run, written as a
 *  proposal, or ended without one — nothing of the owner's to draft from, or
 *  a run that failed for good. Null when none was asked. */
export type VoiceDescriptionDraftState = "drafting" | "drafted" | "not_drafted" | null;

/** Read off the voice's draft job. The job queue is outside row-level
 *  security, so the org is named here. */
export async function voiceDescriptionDraftState(
  tx: Tx,
  organizationId: string,
  voiceId: number,
): Promise<VoiceDescriptionDraftState> {
  const [job] = await tx
    .select({ status: jobs.status, result: jobs.result })
    .from(jobs)
    .where(
      and(
        eq(jobs.organizationId, organizationId),
        eq(jobs.type, "relearn_voice_description"),
        sql`${jobs.payload} ->> 'voiceId' = ${String(voiceId)}`,
      ),
    )
    .orderBy(desc(jobs.id))
    .limit(1);
  if (!job) return null;
  if (job.status === "queued" || job.status === "running") return "drafting";
  const result = job.result as VoiceDescriptionDraftResult | null;
  return job.status === "done" && result?.drafted === 1 ? "drafted" : "not_drafted";
}

/** What the draft job records of its run: 1 when it wrote a proposal, 0 when
 *  it found nothing of the owner's to draft from. */
export type VoiceDescriptionDraftResult = { drafted: 0 | 1 };
