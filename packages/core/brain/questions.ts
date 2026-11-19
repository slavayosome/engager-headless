import { desc, eq } from "drizzle-orm";
import {
  brainQuestions,
  brainState,
  type BrainSlot,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { z } from "zod";
import { getLLM, type LLM } from "../ai/client";
import { modelFor } from "../ai/modelFor";
import { promptRef } from "../ai/prompt/ids";
import { assessBrain } from "./assess";
import { lockBrainMutation } from "./mutationLock";
import { BRAIN_SLOTS } from "./slots";

const SLOT_IDS = BRAIN_SLOTS.map((s) => s.id) as [BrainSlot, ...BrainSlot[]];

const QuestionsSchema = z.object({
  questions: z.array(
    z.object({
      slot: z.enum(SLOT_IDS),
      question: z.string().min(1),
    }),
  ),
});

/** A slot at/above this confidence is "covered" and gets no auto-generated
 * questions — this is what lets the interview queue converge and rest instead of
 * refilling forever. The manual "ask me more" path passes `weakBelow: 1` to ask
 * about the weakest slots regardless. */
export const WEAK_CONFIDENCE = 0.7;

export type RefillOpts = {
  /** Hard ceiling on pending questions after the refill. */
  target?: number;
  /** Only generate questions for slots BELOW this confidence (0..1). Default
   * {@link WEAK_CONFIDENCE}; pass 1 to always ask about the weakest slots. */
  weakBelow?: number;
};

export type QuestionQueueSnapshot = {
  pendingCount: number;
  existingQuestions: string[];
  slots: Record<BrainSlot, { confidence: number; missing?: string }>;
};

export type PrepareQueueRefillOpts = RefillOpts & {
  llm?: LLM;
  /** Runs immediately before the provider call. */
  beforeExternalPhase?: () => Promise<void>;
};

export type PreparedQuestionRefill = {
  target: number;
  questions: { slot: BrainSlot; question: string }[];
};

/** Generate refill candidates from a DB snapshot. This function does no DB work. */
export async function prepareQueueRefill(
  snapshot: QuestionQueueSnapshot,
  opts: PrepareQueueRefillOpts = {},
): Promise<PreparedQuestionRefill> {
  const target = opts.target ?? 5;
  const weakBelow = opts.weakBelow ?? WEAK_CONFIDENCE;
  if (snapshot.pendingCount >= target) return { target, questions: [] };

  const weakest = BRAIN_SLOTS.map((s) => ({
    slot: s,
    confidence: snapshot.slots[s.id]?.confidence ?? 0,
    missing: snapshot.slots[s.id]?.missing ?? "",
  }))
    .filter((w) => w.confidence < weakBelow)
    .sort((a, b) => a.confidence - b.confidence)
    .slice(0, 4);
  if (weakest.length === 0) return { target, questions: [] };

  const need = target - snapshot.pendingCount;
  const slotsBlock = weakest
    .map(
      (w) =>
        `- ${w.slot.id} (${w.slot.description}); confidence ${w.confidence.toFixed(
          2,
        )}; still missing: ${w.missing || "(unspecified)"}`,
    )
    .join("\n");

  const system = `You generate brain questions: short, concrete interview questions that fill the weakest context slots about a person, so we can write LinkedIn engagement in their authentic voice.

Ask about ONE specific thing per question. Prefer questions that elicit lived detail (a real project, a stance, a number, an audience) over generic ones. Generate at most ${need} questions, targeting the weak slots listed.`;

  await opts.beforeExternalPhase?.();
  const out = await (opts.llm ?? getLLM()).json({
    model: modelFor("filter"),
    stage: "brain.questions",
    promptRef: promptRef("brain.questions"),
    system,
    user: `WEAK SLOTS (lowest confidence first):\n${slotsBlock}`,
    schema: QuestionsSchema,
    maxTokens: 600,
  });

  const seen = new Set(
    snapshot.existingQuestions.map((q) => q.trim().toLowerCase()),
  );
  const questions = out.questions
    .slice(0, need)
    .filter((q) => {
      const key = q.question.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((q) => ({ slot: q.slot, question: q.question.trim() }));

  return { target, questions };
}

/** Serialize, re-check, and persist provider-prepared questions. DB-only. */
export async function applyPreparedQueueRefill(
  tx: Tx,
  prepared: PreparedQuestionRefill,
): Promise<void> {
  await lockBrainMutation(tx);

  const pending = await tx
    .select({ id: brainQuestions.id })
    .from(brainQuestions)
    .where(eq(brainQuestions.status, "pending"));
  const remaining = prepared.target - pending.length;
  if (remaining <= 0 || prepared.questions.length === 0) return;

  const existing = await tx
    .select({ question: brainQuestions.question })
    .from(brainQuestions);
  const seen = new Set(existing.map((e) => e.question.trim().toLowerCase()));
  const toInsert = prepared.questions
    .filter((q) => {
      const key = q.question.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, remaining);

  if (toInsert.length > 0) await tx.insert(brainQuestions).values(toInsert);
}

/**
 * Top the interview queue up to `target` pending questions, but ONLY for slots
 * below `weakBelow` confidence — so a well-covered brain generates nothing and
 * the queue is allowed to drain and rest. The system prompt contains the literal
 * marker "brain questions" for test routing. New questions whose text already
 * exists (pending or answered) are skipped, so re-running never duplicates.
 */
export async function refillQueue(
  tx: Tx,
  llm?: LLM,
  opts: RefillOpts = {},
): Promise<void> {
  // Keep legacy transaction-owned callers in the same lock order as phased
  // seeding (advisory lock, then brain_state/question rows). Some legacy paths
  // may create brain_state while assessing an empty Brain.
  await lockBrainMutation(tx);
  const target = opts.target ?? 5;

  const pending = await tx
    .select({ id: brainQuestions.id })
    .from(brainQuestions)
    .where(eq(brainQuestions.status, "pending"));
  if (pending.length >= target) return;

  // Read coverage to find the weakest slots; assess if we have no state yet.
  let slots: Record<BrainSlot, { confidence: number; missing?: string }>;
  const [state] = await tx.select().from(brainState);
  if (state?.slots) {
    slots = state.slots;
  } else {
    slots = (await assessBrain(tx, llm)).slots;
  }

  const existing = await tx
    .select({ question: brainQuestions.question })
    .from(brainQuestions);
  const prepared = await prepareQueueRefill(
    {
      pendingCount: pending.length,
      existingQuestions: existing.map((e) => e.question),
      slots,
    },
    { llm, ...opts },
  );
  await applyPreparedQueueRefill(tx, prepared);
}

/** The next `n` pending interview questions (most recent first). */
export async function nextPending(tx: Tx, n = 3) {
  return tx
    .select()
    .from(brainQuestions)
    .where(eq(brainQuestions.status, "pending"))
    .orderBy(desc(brainQuestions.createdAt))
    .limit(n);
}
