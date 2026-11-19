import { asc, eq, inArray } from "drizzle-orm";
import {
  workerRuns,
  conversations,
  stepRuns,
  stepToolCalls,
  type StepRunRow,
  type StepWait,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { personKey } from "../people/key";
import { conversationPersonName } from "./wakes";

/**
 * THE RUN OVERLAY's data (spec §02 "the UI never exposes private
 * chain-of-thought"): for one run, each step it worked on each conversation, how
 * that step stands, the evidence it cited, the summary it gave and what the
 * server did with every call it proposed. Phase 41's overlay toggle and
 * Phase 40's Runs tab render it; nothing here decides anything.
 *
 * The step's own words are `rationale_summary` and nothing else — no field of
 * this shape carries a model's reasoning, because none was kept.
 *
 *   completed  the step achieved its objective as it first proposed
 *   adapted    it got there another way — a call of its own was discarded on
 *              the way — or the server ended it at a budget
 *   waiting    on the person, or on the owner's yes
 *   blocked    it could not proceed: a guard, a barrier, a stale fact
 *   running    a wake is working it now, or crashed in it and the next one
 *              will adopt it
 */

export type OverlayStatus = "completed" | "adapted" | "waiting" | "blocked" | "running";

export type RunOverlayStep = {
  stepRunId: number;
  conversationId: number;
  /** Who the conversation is with, by the name their latest reply carried —
   *  what tells one step's decisions apart on a run that worked several. */
  person: string | null;
  /** …and by their key (`people/key.ts`), which every name links by. */
  personKey: string | null;
  stepId: string;
  status: OverlayStatus;
  /** Where the server ended it, when a model did not: `stale_fact:fact:12`. */
  endedBy: string | null;
  evidence_refs: string[];
  rationale_summary: string | null;
  iterations: number;
  wait: Pick<StepWait, "event" | "expiresAt" | "onTimeout" | "consumedBy"> | null;
  calls: Array<{
    iteration: number;
    tool: string;
    target: string | null;
    outcome: "dispatched" | "discarded";
    reason: string | null;
    resultRef: string | null;
  }>;
};

export type RunOverlay = {
  runId: number;
  servedStepIds: string[];
  steps: RunOverlayStep[];
};

/** How a checkpoint reads on the overlay. Pure. */
export function overlayStatus(
  checkpoint: Pick<StepRunRow, "status">,
  discarded: number,
): OverlayStatus {
  switch (checkpoint.status) {
    case "running":
      return "running";
    case "achieved":
      return discarded > 0 ? "adapted" : "completed";
    case "budget_exhausted":
      return "adapted";
    case "waiting":
    case "needs_approval":
      return "waiting";
    case "blocked":
      return "blocked";
  }
}

/** One run's overlay, or null when the run is not this org's. */
export async function readRunOverlay(tx: Tx, runId: number): Promise<RunOverlay | null> {
  const [run] = await tx
    .select({ id: workerRuns.id, servedStepIds: workerRuns.servedStepIds })
    .from(workerRuns)
    .where(eq(workerRuns.id, runId));
  if (!run) return null;
  const rows = await tx
    .select({ checkpoint: stepRuns, person: conversationPersonName, profileId: conversations.authorProfileId })
    .from(stepRuns)
    .innerJoin(conversations, eq(conversations.id, stepRuns.conversationId))
    .where(eq(stepRuns.runId, runId))
    .orderBy(asc(stepRuns.id));
  const checkpoints = rows.map((row) => row.checkpoint);
  const people = new Map(
    rows.map((row) => [row.checkpoint.id, { name: row.person, key: personKey({ profileId: row.profileId }) }]),
  );
  const calls =
    checkpoints.length === 0
      ? []
      : await tx
          .select()
          .from(stepToolCalls)
          .where(inArray(stepToolCalls.stepRunId, checkpoints.map((checkpoint) => checkpoint.id)))
          .orderBy(asc(stepToolCalls.id));
  return {
    runId: run.id,
    servedStepIds: run.servedStepIds,
    steps: checkpoints.map((checkpoint) => {
      const own = calls.filter((call) => call.stepRunId === checkpoint.id);
      return {
        stepRunId: checkpoint.id,
        conversationId: checkpoint.conversationId,
        person: people.get(checkpoint.id)?.name ?? null,
        personKey: people.get(checkpoint.id)?.key ?? null,
        stepId: checkpoint.stepId,
        status: overlayStatus(
          checkpoint,
          own.filter((call) => call.outcome === "discarded").length,
        ),
        endedBy: checkpoint.blockedReason,
        evidence_refs: checkpoint.evidenceRefs,
        rationale_summary: checkpoint.rationaleSummary,
        iterations: checkpoint.iterations,
        wait: checkpoint.wait
          ? {
              event: checkpoint.wait.event,
              expiresAt: checkpoint.wait.expiresAt,
              onTimeout: checkpoint.wait.onTimeout,
              consumedBy: checkpoint.wait.consumedBy,
            }
          : null,
        calls: own.map((call) => ({
          iteration: call.iteration,
          tool: call.tool,
          target: call.targetKind && call.targetRef ? `${call.targetKind}:${call.targetRef}` : null,
          outcome: call.outcome,
          reason: call.reason,
          resultRef: call.resultRef,
        })),
      };
    }),
  };
}
