import { z } from "zod";
import {
  brainState,
  type BrainSlot,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { getLLM, type LLM } from "../ai/client";
import { modelFor } from "../ai/modelFor";
import { promptRef } from "../ai/prompt/ids";
import { untrusted } from "../ai/prompts";
import { lockBrainMutation } from "./mutationLock";
import { BRAIN_SLOTS } from "./slots";
import { listNotes } from "./vault";

const SLOT_IDS = BRAIN_SLOTS.map((s) => s.id) as [BrainSlot, ...BrainSlot[]];

const AssessSchema = z.object({
  slots: z.array(
    z.object({
      slot: z.enum(SLOT_IDS),
      confidence: z.number().min(0).max(1),
      missing: z.string(),
    }),
  ),
});

export type BrainAssessment = {
  slots: Record<BrainSlot, { confidence: number; missing: string }>;
  fillScore: number;
};

export type BrainAssessmentKnowledge = {
  slot: BrainSlot;
  content: string;
};

export type PrepareBrainAssessmentOpts = {
  llm?: LLM;
  /** Runs immediately before the provider call. Hosted jobs use this to stop
   * fresh model spend when their entitlement is revoked between phases. */
  beforeExternalPhase?: () => Promise<void>;
};

/**
 * Score how well each Brain slot is covered by the stored knowledge, then persist
 * the result. The system prompt contains the literal marker "brain coverage" so the
 * FakeLLM can route it in tests. `fillScore` is the mean confidence across every
 * slot in `BRAIN_SLOTS` — seven, since "product" left the coverage model for the
 * Products model (a slot the model omits counts as 0), so it reflects total
 * coverage, not just the slots that happen to have content.
 */
export async function prepareBrainAssessment(
  rows: BrainAssessmentKnowledge[],
  opts: PrepareBrainAssessmentOpts = {},
): Promise<BrainAssessment> {
  // Group content by slot for the prompt.
  const bySlot = new Map<BrainSlot, string[]>();
  for (const r of rows) {
    const arr = bySlot.get(r.slot) ?? [];
    arr.push(r.content);
    bySlot.set(r.slot, arr);
  }

  const slotsBlock = BRAIN_SLOTS.map((s) => {
    const items = bySlot.get(s.id) ?? [];
    const body = items.length
      ? items.map((c) => `  - ${c}`).join("\n")
      : "  (no knowledge yet)";
    return `SLOT "${s.id}" — ${s.description}\n${body}`;
  }).join("\n\n");

  const system = `You assess brain coverage: how well a person's stored knowledge fills each of ${BRAIN_SLOTS.length} fixed context slots used to write LinkedIn engagement in their voice.

For EACH of the ${BRAIN_SLOTS.length} slots emit:
- slot: the slot id
- confidence: 0..1, how well the stored content covers that slot (0 = nothing usable, 1 = rich + specific)
- missing: one short phrase naming what is still missing for that slot (empty if well covered)

Be strict: a slot with no content is confidence 0. Vague or generic content is low confidence.`;

  await opts.beforeExternalPhase?.();
  const out = await (opts.llm ?? getLLM()).json({
    model: modelFor("filter"),
    stage: "brain.assess",
    promptRef: promptRef("brain.assess"),
    system,
    user: untrusted("STORED KNOWLEDGE BY SLOT", slotsBlock),
    schema: AssessSchema,
    maxTokens: 800,
  });

  // Index the model's output; default any omitted slot to confidence 0.
  const byId = new Map(out.slots.map((s) => [s.slot, s]));
  const slots = {} as Record<
    BrainSlot,
    { confidence: number; missing: string }
  >;
  let total = 0;
  for (const s of BRAIN_SLOTS) {
    const got = byId.get(s.id);
    const confidence = got ? Math.max(0, Math.min(1, got.confidence)) : 0;
    slots[s.id] = { confidence, missing: got?.missing ?? "" };
    total += confidence;
  }
  const fillScore = total / BRAIN_SLOTS.length;

  return { slots, fillScore };
}

/** Persist a provider-prepared coverage assessment. This function is DB-only. */
export async function persistBrainAssessment(
  tx: Tx,
  assessment: BrainAssessment,
): Promise<void> {
  const { slots, fillScore } = assessment;

  await tx
    .insert(brainState)
    .values({ slots, fillScore, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: brainState.organizationId,
      set: { slots, fillScore, updatedAt: Date.now() },
    });
}

export async function assessBrain(tx: Tx, llm?: LLM): Promise<BrainAssessment> {
  // Legacy transaction-owned callers must take the shared advisory lock before
  // brain_state. Otherwise assess → refill can deadlock with phased apply, which
  // takes the advisory lock first and then row-locks brain_state.
  await lockBrainMutation(tx);
  const rows = (await listNotes()).map((note) => ({
    slot: note.slot,
    content: note.content,
  }));
  const assessment = await prepareBrainAssessment(rows, { llm });
  await persistBrainAssessment(tx, assessment);
  return assessment;
}
