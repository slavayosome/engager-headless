import { and, desc, eq, inArray } from "drizzle-orm";
import { campaignStrategies, campaignGuidance, type Campaign } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { parseStrategy } from "./contract";
import { writingSurfaceForStep, type WritingStep, type WritingSurface } from "../ai/writingInstructions";
import { resolveCampaignVoice } from "../voice";
import { getProfile } from "../profile";
import { strategyRegister, draftingVoiceId } from "./draftingVoice";
import { prepareKnowledgeRetrieval, type KnowledgeRetrievalSnapshot } from "../brain/knowledge";

/** Campaign and Brain prose are inherited preferences on every writing surface. */
export async function readWritingPreferences(tx: Tx, campaign: Campaign) {
  const [learned] = await tx.select().from(campaignGuidance)
    .where(eq(campaignGuidance.campaignId, campaign.id));
  return { campaign, learnedGuidance: learned?.guidance, constraints: await brainWritingPreferences(tx) };
}

/** The writing preferences the owner keeps in the Brain: its avoid notes. */
export async function brainWritingPreferences(tx: Tx, snapshot?: KnowledgeRetrievalSnapshot): Promise<string> {
  const notes = snapshot ?? await prepareKnowledgeRetrieval(tx);
  return notes.filter(note => note.slot === "avoid").map(note => note.content).join("\n");
}

/** The strategy a campaign's drafts are written from: its active version,
 *  else its newest draft. */
export async function savedStrategy(tx: Tx, campaignId: number) {
  const [active] = await tx.select().from(campaignStrategies)
    .where(and(eq(campaignStrategies.campaignId, campaignId), eq(campaignStrategies.status, "active")))
    .limit(1);
  const [latest] = active ? [active] : await tx.select().from(campaignStrategies)
    .where(and(eq(campaignStrategies.campaignId, campaignId), inArray(campaignStrategies.status, ["draft", "active"])))
    .orderBy(desc(campaignStrategies.version)).limit(1);
  if (!latest) return null;
  const parsed = parseStrategy(latest.document, { network: null });
  if (!parsed.success) throw new Error("writing_strategy_unreadable");
  return { document: parsed.data, version: latest.version };
}

/** Manual and worker drafts use the same saved strategy voice. */
export async function resolveSavedWritingVoice(
  tx: Tx, campaign: Pick<Campaign, "id" | "voiceId">,
  profile: Awaited<ReturnType<typeof getProfile>>,
  channel: "comment" | "reply" | "dm",
  options: Parameters<typeof resolveCampaignVoice>[4] = {},
) {
  const saved = await savedStrategy(tx, campaign.id);
  const resolved = await resolveCampaignVoice(tx,
    saved ? { voiceId: draftingVoiceId(saved.document.voice, campaign) } : campaign,
    profile, channel, options);
  return saved ? strategyRegister(resolved, saved.document.voice) : resolved;
}

/** Read-only binding to an exact saved step. Never guess by label or merge
 * instructions from two steps that happen to produce the same deliverable. */
export async function readWritingStep(
  tx: Tx,
  campaignId: number,
  surface: WritingSurface,
  stepId?: string,
): Promise<WritingStep | undefined> {
  const latest = await savedStrategy(tx, campaignId);
  if (!latest) {
    if (stepId) throw new Error("writing_step_missing");
    return undefined; // legacy campaign: its saved campaign guidance applies
  }
  const desired = surface === "angle" ? "comment" : surface;
  const steps = (latest.document.steps ?? []).filter(step =>
    writingSurfaceForStep(step.catalog_step) === desired && (!stepId || step.step_id === stepId));
  if (stepId && steps.length !== 1) throw new Error("writing_step_missing");
  if (steps.length > 1) throw new Error("writing_step_ambiguous: select the exact step");
  const step = steps[0];
  return step ? { id: step.step_id, instructions: step.instructions, objective: step.objective,
    strategyVersion: latest.version } : undefined;
}

