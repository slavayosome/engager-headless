import { eq } from "drizzle-orm";
import { campaignGuidance, type Campaign } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { prepareKnowledgeRetrieval } from "../brain/knowledge";
import { resolveWritingInstructions, writingSurfaceForStep, type WritingInstructions } from "../ai/writingInstructions";
import { learnedEditsBlock, voiceInstructionText } from "../ai/writer";
import { resolveCampaignVoice } from "../voice";
import { getProfile } from "../profile";
import type { CampaignAgentStrategy, StrategyStep } from "./contract";
import { strategyRegister, draftingVoiceId } from "./draftingVoice";

/** Read the same inherited sources as drafting, without a model/provider call.
 * The client substitutes unsaved step text locally, so preview never saves. */
export async function readInstructionPreview(
  tx: Tx, campaign: Campaign, step: StrategyStep,
  strategy: CampaignAgentStrategy, version: number | undefined,
): Promise<WritingInstructions | null> {
  const surface = writingSurfaceForStep(step.catalog_step);
  if (!surface) return null;
  const channel = surface === "invitation" || surface === "dm" ? "dm" : surface === "comment" || surface === "angle" ? "comment" : "reply";
  const voice = strategyRegister(await resolveCampaignVoice(tx,
    { voiceId: draftingVoiceId(strategy.voice, campaign) }, await getProfile(tx),
    channel), strategy.voice);
  const [learned] = await tx.select().from(campaignGuidance)
    .where(eq(campaignGuidance.campaignId, campaign.id));
  const brain = await prepareKnowledgeRetrieval(tx);
  return resolveWritingInstructions({
    surface, campaign, step: { id: step.step_id, instructions: step.instructions,
      objective: step.objective, strategyVersion: version },
    voice: voiceInstructionText(voice, channel),
    learned: [learned?.guidance, learnedEditsBlock(voice.channelEdits, channel)].filter(Boolean).join("\n\n"),
    brainPreferences: brain.filter(note => note.slot === "avoid").map(note => note.content).join("\n"),
  });
}

