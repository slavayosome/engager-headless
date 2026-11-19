import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { campaigns, jobs } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { enqueue, retireFinishedIdempotencyKey, type JobType } from "../../jobs/queue";
import { refuseWorker, type Refusal } from "../../refusal";
import { firstLookAgentFailure, firstLookFault, type FirstLookFault } from "../../workers/firstLook";

/**
 * THE WAKE: how a Find leads phase starts when work lands in its queue
 * (`queues.ts`). Each phase runs as one job per campaign, and a wake keeps it to
 * one: a phase already queued answers the wake and nothing more is queued, so ten
 * words landing in a row are one start, not ten. A phase that is running may have
 * read its queue before what woke it landed, so the wake queues one more behind
 * it, and never two. Nothing here reads LinkedIn or calls a model.
 */

/** The steps that run as jobs: Screen, Read profiles (the Research job in its
 *  `step` mode) and Judge. */
export type LeadPhase = "screen" | "read" | "judge";

/** What a `lead_screen` or `lead_judge` job is handed: the campaign whose queue
 *  it works. Everything else is read when it runs. */
export type LeadPhasePayload = { campaignId: number };

const PHASE_JOBS: Record<LeadPhase, JobType> = {
  screen: "lead_screen",
  read: "research_signals",
  judge: "lead_judge",
};

/** How long Screen or Judge waits when the owner's agent cannot answer before
 *  it is woken to ask again. */
export const LEAD_STEP_HOLD_MS = 15 * 60_000;

/**
 * The refusal a phase ends with when the owner's agent could not answer — out of
 * quota, signed out or not answering — or null for any other error. A hold is
 * the agent being away, not the words or the person being hard to judge, so it
 * counts no try against them: the phase returns this and is woken again after
 * `LEAD_STEP_HOLD_MS`, or when the quota says it lifts, whichever is later.
 */
export function agentHold(error: unknown, now: number = Date.now()): Refusal | null {
  const failure = firstLookAgentFailure(error);
  if (!failure) return null;
  return { ...refuseWorker(failure.reason), retryAt: Math.max(now + LEAD_STEP_HOLD_MS, failure.resetsAt ?? 0) };
}

/** What kept the owner's agent from answering: the faults `agentHold` holds a
 *  phase for. */
export type AgentFault = Exclude<FirstLookFault, "failed">;

/**
 * The fault holding Screen or Judge for the campaign, or null: the phase's newest
 * finished job ended on an `agentHold` refusal, and the wake it left is still
 * queued behind it. Where both are held, the newer hold answers. It asks nothing
 * of the agent.
 */
export async function agentHeld(tx: Tx, organizationId: string, campaignId: number): Promise<AgentFault | null> {
  const holds: Array<{ fault: AgentFault; at: number }> = [];
  for (const phase of ["screen", "judge"] as const) {
    const ofStep = and(
      // `jobs` is excluded from RLS, so the org predicate is explicit.
      eq(jobs.organizationId, organizationId),
      eq(jobs.type, PHASE_JOBS[phase]),
      sql`${jobs.payload} ->> 'campaignId' = ${String(campaignId)}`,
    );
    const [finished] = await tx
      .select({ id: jobs.id, at: jobs.updatedAt, code: sql<string | null>`${jobs.result} -> 'refusal' ->> 'code'` })
      .from(jobs)
      .where(and(ofStep, inArray(jobs.status, ["done", "dead"])))
      .orderBy(desc(jobs.updatedAt), desc(jobs.id))
      .limit(1);
    if (!finished) continue;
    const fault = firstLookFault(finished.code);
    if (fault === "failed") continue;
    const [later] = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(ofStep, eq(jobs.status, "queued"), gt(jobs.id, finished.id)))
      .limit(1);
    if (later) holds.push({ fault, at: finished.at });
  }
  return holds.sort((a, b) => b.at - a.at)[0]?.fault ?? null;
}

/** The key a phase's job holds while it is queued or running. */
export const leadPhaseKey = (phase: LeadPhase, campaignId: number): string => `lead-${phase}:${campaignId}`;

/** The key of the job queued behind one that is running. */
const behindKey = (phase: LeadPhase, campaignId: number): string => `${leadPhaseKey(phase, campaignId)}:next`;

/** The phase's jobs for a campaign that are queued or running. */
async function livePhaseJobs(tx: Tx, organizationId: string, phase: LeadPhase, campaignId: number) {
  return tx
    .select({ id: jobs.id, key: jobs.idempotencyKey, status: jobs.status, nextRunAt: jobs.nextRunAt })
    .from(jobs)
    .where(
      and(
        // `jobs` is excluded from RLS, so the org predicate is explicit.
        eq(jobs.organizationId, organizationId),
        inArray(jobs.idempotencyKey, [leadPhaseKey(phase, campaignId), behindKey(phase, campaignId)]),
        inArray(jobs.status, ["queued", "running"]),
      ),
    )
    .orderBy(jobs.nextRunAt, jobs.id);
}

async function coalesceQueuedPhaseJobs(tx: Tx, organizationId: string, phase: LeadPhase, campaignId: number, queued: ReadonlyArray<{ id: number }>) {
  const [keep, ...duplicates] = queued;
  if (!keep || duplicates.length === 0) return keep?.id ?? null;
  await tx
    .update(jobs)
    .set({ status: "done", lastError: `coalesced behind job ${keep.id}`, updatedAt: Date.now() })
    .where(
      and(
        eq(jobs.organizationId, organizationId),
        inArray(jobs.id, duplicates.map((job) => job.id)),
        eq(jobs.status, "queued"),
      ),
    );
  return keep.id;
}

/** Whether the phase has a job queued or running for the campaign: a phase that
 *  has work and none is stalled. */
export async function phaseHasJob(tx: Tx, organizationId: string, phase: LeadPhase, campaignId: number): Promise<boolean> {
  return (await livePhaseJobs(tx, organizationId, phase, campaignId)).length > 0;
}

/**
 * Wake now the Read profiles the account's spent profile reads were holding,
 * where the owner has just raised the limit. A refused read waits for the next
 * read to age out (`readProfiles` wakes itself at that time), and a wake only
 * ever moves a queued job later, so without this a raised limit sits unused
 * until then. Every active campaign that finds leads; a job already due is
 * left as it is.
 */
export async function wakeHeldReads(tx: Tx, organizationId: string, now: number = Date.now()): Promise<void> {
  const active = await tx
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(and(eq(campaigns.organizationId, organizationId), eq(campaigns.status, "active")));
  for (const { id } of active) {
    for (const job of await livePhaseJobs(tx, organizationId, "read", id)) {
      if (job.status !== "queued" || job.nextRunAt <= now) continue;
      await tx
        .update(jobs)
        .set({ nextRunAt: now, updatedAt: now })
        .where(and(eq(jobs.organizationId, organizationId), eq(jobs.id, job.id), eq(jobs.status, "queued")));
    }
  }
}

/**
 * Wake a phase for a campaign, at `at` (now unless it says later). Returns the
 * job that will take what is waiting, or null where the campaign is gone or two
 * jobs of the phase are already running: a wake that finds the phase running
 * twice is left to the 5-minute check, which wakes it once they end.
 *
 * A job that finished is retired in the same transaction as the one queued in
 * its place, so a finished key never holds a wake off.
 */
export async function wakeLeadPhase(tx: Tx, phase: LeadPhase, campaignId: number, at: number = Date.now()): Promise<number | null> {
  const [campaign] = await tx.select({ organizationId: campaigns.organizationId }).from(campaigns).where(eq(campaigns.id, campaignId));
  if (!campaign) return null;
  const organizationId = campaign.organizationId;
  const key = leadPhaseKey(phase, campaignId);
  const behind = behindKey(phase, campaignId);
  for (const held of [key, behind]) await retireFinishedIdempotencyKey(tx, organizationId, held);

  const live = await livePhaseJobs(tx, organizationId, phase, campaignId);
  const queued = live.filter((job) => job.status === "queued");
  const queuedId = await coalesceQueuedPhaseJobs(tx, organizationId, phase, campaignId, queued);
  if (queuedId !== null) {
    // A hold reaches a job already waiting too: one due sooner waits for it.
    const kept = queued.find((job) => job.id === queuedId);
    if (kept && kept.nextRunAt < at) {
      await tx
        .update(jobs)
        .set({ nextRunAt: at, updatedAt: Date.now() })
        .where(and(eq(jobs.organizationId, organizationId), eq(jobs.id, queuedId), eq(jobs.status, "queued")));
    }
    return queuedId;
  }

  return enqueue(tx, {
    type: PHASE_JOBS[phase],
    payload: phase === "read" ? { campaignId, trigger: "step" } : { campaignId },
    // A job running under the phase's own key has the queue as it read it: the
    // wake waits behind it, on the key it does not hold.
    idempotencyKey: live.some((job) => job.key === key) ? behind : key,
    nextRunAt: at,
  });
}
