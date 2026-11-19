import { eq } from "drizzle-orm";
import { brainQuestions, brainState } from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import {
  persistBrainAssessment,
  prepareBrainAssessment,
  type BrainAssessmentKnowledge,
} from "../../brain/assess";
import { materializeVaultMirror } from "../../brain/mirror";
import { lockBrainMutation } from "../../brain/mutationLock";
import {
  applyPreparedQueueRefill,
  prepareQueueRefill,
} from "../../brain/questions";
import { listNotes } from "../../brain/vault";
import type { SelfScopedCtx } from "../worker";
import {
  assertHostedJobSpendStillAllowed,
  assertHostedJobSpendStillAllowedInTx,
} from "../spendAccess";

const MAX_SNAPSHOT_RETRIES = 3;

type RefreshBrainSnapshot = {
  knowledge: BrainAssessmentKnowledge[];
  knowledgeVersion: number;
  /** The replica version the notes below were materialized at, or `null` off a
   *  replica — where there is no second counter and the single-process
   *  assumption below is simply true. */
  mirrorVersion: number | null;
  pendingQuestions: number;
  existingQuestions: string[];
};

export type RefreshBrainOrgScope = <T>(
  work: (tx: Tx) => Promise<T>,
) => Promise<T>;

export type RefreshBrainHooks = {
  /** Test-only interleaving seam after the version read, before knowledge. */
  afterVersionRead?: () => Promise<void>;
};

export class RefreshBrainStaleSnapshotError extends Error {
  constructor() {
    super("brain changed repeatedly while preparing a refresh");
    this.name = "RefreshBrainStaleSnapshotError";
  }
}

async function refreshSnapshot(
  tx: Tx,
  hooks: RefreshBrainHooks,
): Promise<RefreshBrainSnapshot> {
  // On a replica the files are the ROWS' derivative, so they must be brought to
  // the mirror's version before the version that will fence them is read.
  const mirrorVersion = await materializeVaultMirror(tx);
  // READ COMMITTED gives each statement its own snapshot. Read the monotonic
  // version BEFORE the rows it guards: if a knowledge writer commits between
  // these statements, the apply phase observes a newer version and retries.
  // Reading rows first could pair old knowledge with the writer's new version,
  // allowing a stale assessment to pass the final equality check.
  const [state] = await tx
    .select({ knowledgeVersion: brainState.knowledgeVersion })
    .from(brainState);
  await hooks.afterVersionRead?.();
  const rows = (await listNotes()).map((note) => ({
    slot: note.slot,
    content: note.content,
  }));
  const pending = await tx
    .select({ id: brainQuestions.id })
    .from(brainQuestions)
    .where(eq(brainQuestions.status, "pending"));
  const existing = await tx
    .select({ question: brainQuestions.question })
    .from(brainQuestions);
  return {
    knowledge: rows,
    knowledgeVersion: state?.knowledgeVersion ?? 0,
    mirrorVersion,
    pendingQuestions: pending.length,
    existingQuestions: existing.map((row) => row.question),
  };
}

async function assertRefreshMayContinue(ctx: SelfScopedCtx): Promise<void> {
  if (ctx.signal?.aborted) throw new Error("refresh brain aborted");
  await assertHostedJobSpendStillAllowed(ctx);
}

/**
 * Daily per-org "come back later" pass: re-score coverage as knowledge grows and
 * top the interview queue up ONLY for slots still genuinely weak (so a covered
 * brain rests). Skips orgs with no knowledge yet — we don't pester anyone who
 * hasn't started a brain.
 */
export async function handleRefreshBrain(
  ctx: SelfScopedCtx,
  _payload: unknown = {},
  orgScope: RefreshBrainOrgScope = (work) => withOrg(ctx.organizationId, work),
  hooks: RefreshBrainHooks = {},
): Promise<void> {
  for (let attempt = 0; attempt < MAX_SNAPSHOT_RETRIES; attempt += 1) {
    const snapshot = await orgScope((tx) => refreshSnapshot(tx, hooks));
    if (snapshot.knowledge.length === 0) return;

    const assessment = await prepareBrainAssessment(snapshot.knowledge, {
      llm: ctx.llm,
      beforeExternalPhase: () => assertRefreshMayContinue(ctx),
    });
    const questions = await prepareQueueRefill(
      {
        pendingCount: snapshot.pendingQuestions,
        existingQuestions: snapshot.existingQuestions,
        slots: assessment.slots,
      },
      {
        llm: ctx.llm,
        beforeExternalPhase: () => assertRefreshMayContinue(ctx),
      },
    );

    if (ctx.signal?.aborted) throw new Error("refresh brain aborted");
    const applied = await orgScope(async (tx) => {
      await assertHostedJobSpendStillAllowedInTx(tx, ctx);
      // Match every other phased Brain writer: advisory lock first, then the
      // brain_state row. The version fence rejects an assessment prepared from
      // knowledge that changed while either provider call was in flight.
      await lockBrainMutation(tx);
      await tx
        .insert(brainState)
        .values({ knowledgeVersion: 0 })
        .onConflictDoNothing();
      const [state] = await tx
        .select({
          knowledgeVersion: brainState.knowledgeVersion,
          mirrorVersion: brainState.mirrorVersion,
        })
        .from(brainState)
        .for("update");
      if ((state?.knowledgeVersion ?? 0) !== snapshot.knowledgeVersion) {
        return false;
      }
      // A sync landing between the materialization and the version read hands
      // the assessment newer FILES than it was fenced on — a hazard the single
      // knowledge version cannot see, and one that does not exist off a replica
      // (hence the null guard, which keeps the laptop byte-for-byte as it was).
      if (
        snapshot.mirrorVersion !== null &&
        (state?.mirrorVersion ?? 0) !== snapshot.mirrorVersion
      ) {
        return false;
      }
      await persistBrainAssessment(tx, assessment);
      await applyPreparedQueueRefill(tx, questions);
      return true;
    });
    if (applied) return;
  }

  throw new RefreshBrainStaleSnapshotError();
}
