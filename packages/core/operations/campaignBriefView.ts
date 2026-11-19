import { brainState, type BrainSlot } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { getCampaign } from "./campaigns";

/** The same brief and thin-slot advice shown by the campaign brief read. */
export async function campaignBriefView(tx: Tx, campaignId: number) {
  const campaign = await getCampaign(tx, campaignId);
  if (!campaign) return null;
  const brief = campaign.compiledBrief;
  const [brain] = await tx.select({ slots: brainState.slots }).from(brainState);
  const relevant: BrainSlot[] = brief?.preferredSlots?.length ? brief.preferredSlots : ["positions", "stories", "expertise"];
  return {
    campaignId, compiled: !!brief, coldStart: brief?.coldStart ?? null, brief: brief?.brief ?? null,
    preferredSlots: brief?.preferredSlots ?? [], anchorKnowledgeIds: brief?.anchorKnowledgeIds ?? [],
    compiledAt: brief?.compiledAt ?? null, basedOnFillScore: brief?.basedOnFillScore ?? null,
    thinSlots: brain?.slots ? relevant.filter(slot => slot !== "avoid" && (brain.slots?.[slot]?.confidence ?? 0) < 0.34) : [],
  };
}
