import { eq } from "drizzle-orm";
import { brainQuestions, brainState } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import type { LLM } from "../ai/client";
import {
  persistBrainAssessment,
  prepareBrainAssessment,
  type BrainAssessment,
  type BrainAssessmentKnowledge,
} from "./assess";
import { lockBrainMutation } from "./mutationLock";
import {
  applyPreparedQueueRefill,
  prepareQueueRefill,
  type RefillOpts,
} from "./questions";
import { listNotes } from "./vault";
import { externalJudgmentActive } from "../tasks/judgment";

const MAX_SNAPSHOT_RETRIES = 3;

export type BrainRefreshOrgScope = <T>(
  work: (tx: Tx) => Promise<T>,
) => Promise<T>;

export type BrainRefreshOptions = {
  llm?: LLM;
  /** Omit to refresh coverage only; provide to also refill questions. */
  refill?: RefillOpts;
  /** Jobs use this to avoid questioning an org that has not started its Brain. */
  skipWhenEmpty?: boolean;
  /** Re-authorize immediately before every model call. */
  beforeExternalPhase?: () => Promise<void>;
  /** Re-authorize after preparation and before the fenced DB apply. */
  beforeApplyPhase?: () => Promise<void>;
  /** Test-only interleaving seam after version, before guarded rows. */
  afterVersionRead?: () => Promise<void>;
};

type BrainRefreshSnapshot = {
  knowledge: BrainAssessmentKnowledge[];
  knowledgeVersion: number;
  pendingQuestions: number;
  existingQuestions: string[];
};

export class BrainRefreshStaleSnapshotError extends Error {
  constructor() {
    super("brain changed repeatedly while preparing a refresh");
    this.name = "BrainRefreshStaleSnapshotError";
  }
}

async function brainRefreshSnapshot(
  tx: Tx,
  opts: BrainRefreshOptions,
): Promise<BrainRefreshSnapshot> {
  // READ COMMITTED snapshots each statement independently. Read the monotonic
  // version first: a writer that commits before the guarded rows are read makes
  // the later apply reject this mixed snapshot and retry from a fresh version.
  const [state] = await tx
    .select({ knowledgeVersion: brainState.knowledgeVersion })
    .from(brainState);
  await opts.afterVersionRead?.();
  const rows = (await listNotes()).map((note) => ({
    slot: note.slot,
    content: note.content,
  }));
  const pending = opts.refill
    ? await tx
        .select({ id: brainQuestions.id })
        .from(brainQuestions)
        .where(eq(brainQuestions.status, "pending"))
    : [];
  const existing = opts.refill
    ? await tx
        .select({ question: brainQuestions.question })
        .from(brainQuestions)
    : [];
  return {
    knowledge: rows,
    knowledgeVersion: state?.knowledgeVersion ?? 0,
    pendingQuestions: pending.length,
    existingQuestions: existing.map((row) => row.question),
  };
}

/**
 * Connection-disciplined coverage/question refresh for interactive callers.
 * Every provider call runs between short org scopes; the apply transaction
 * locks the Brain mutation lane and rejects work prepared from stale knowledge.
 */
export async function refreshBrainPhased(
  orgScope: BrainRefreshOrgScope,
  opts: BrainRefreshOptions = {},
): Promise<BrainAssessment | null> {
  // Coverage is a CACHE over rows the caller can already read (INV-2): the
  // assessment phrase is the only part a model writes. Under the
  // external-judgment policy there is nobody here to write it, and a
  // `brain_notes` task prepared from the vault's own notes would ask the
  // owner's agent to re-extract facts it already stored. So the refresh is a
  // no-op and the caller returns derived coverage — a staler phrase beside
  // current numbers, never a refusal and never a duplicate note.
  if (externalJudgmentActive()) return null;

  for (let attempt = 0; attempt < MAX_SNAPSHOT_RETRIES; attempt += 1) {
    const snapshot = await orgScope((tx) => brainRefreshSnapshot(tx, opts));
    if (opts.skipWhenEmpty && snapshot.knowledge.length === 0) return null;

    const assessment = await prepareBrainAssessment(snapshot.knowledge, {
      llm: opts.llm,
      beforeExternalPhase: opts.beforeExternalPhase,
    });
    const questions = opts.refill
      ? await prepareQueueRefill(
          {
            pendingCount: snapshot.pendingQuestions,
            existingQuestions: snapshot.existingQuestions,
            slots: assessment.slots,
          },
          {
            llm: opts.llm,
            ...opts.refill,
            beforeExternalPhase: opts.beforeExternalPhase,
          },
        )
      : null;

    await opts.beforeApplyPhase?.();
    const applied = await orgScope(async (tx) => {
      await lockBrainMutation(tx);
      await tx
        .insert(brainState)
        .values({ knowledgeVersion: 0 })
        .onConflictDoNothing();
      const [state] = await tx
        .select({ knowledgeVersion: brainState.knowledgeVersion })
        .from(brainState)
        .for("update");
      if ((state?.knowledgeVersion ?? 0) !== snapshot.knowledgeVersion) {
        return false;
      }

      await persistBrainAssessment(tx, assessment);
      if (questions) await applyPreparedQueueRefill(tx, questions);
      return true;
    });
    if (applied) return assessment;
  }

  throw new BrainRefreshStaleSnapshotError();
}
