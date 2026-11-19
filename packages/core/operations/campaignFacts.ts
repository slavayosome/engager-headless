import { z } from "zod";
import type { CampaignObjective } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { OBJECTIVES } from "../campaigns/objectives";
import { routeCompile } from "./compileRouting";
import { getCampaign, updateCampaignOp } from "./campaigns";
import { setCampaignProducts } from "./products";
import type { AudienceProfileInput } from "../audience/model";

/**
 * WHAT A CAMPAIGN IS FOR — its name, its goal, the audience Find posts looks
 * for, the products its drafts may draw on, the voice its drafts are written
 * in and the oldest post it joins — written through the campaign row's own
 * operation, the one `save_campaign` writes them with, and its products
 * through the one `save_campaign` reconciles them with. Settings' Save and
 * the owner's yes to a change chat proposed (`chat/proposalKinds.ts`) both
 * land here, so the two cannot write them differently.
 *
 * The goal, the audience and the products are what its brief is compiled
 * from, so a write that moves any of them routes the brief: the next draft and
 * the next triage read the new one, not the nightly self-heal's. In a
 * savepoint of its own, so a compile that could not be routed never takes the
 * write down with it — not even one whose failed statement aborted the
 * transaction. Nothing already drafted is rewritten either way.
 */
export type CampaignFacts = {
  name?: string;
  objective?: CampaignObjective;
  /** Find posts' relevance test in the owner's words; empty for none. */
  audience?: string;
  audienceProfile?: AudienceProfileInput;
  baseRevision?: number;
  restoredFrom?: number;
  /** The attached set, whole: omitted leaves it as it is. */
  productIds?: readonly number[];
  voiceId?: number | null;
  maxPostAgeDays?: number;
};

/** Write what is given and leave the rest as it is. `ok` is false for a
 *  campaign that is not there, deleted included. */
export async function writeCampaignFacts(
  tx: Tx,
  organizationId: string,
  campaignId: number,
  facts: CampaignFacts,
): Promise<{ ok: boolean }> {
  const before = await getCampaign(tx, campaignId);
  const audience = facts.audience?.trim();
  const { productIds } = facts;
  const otherEdits = before !== undefined && (
    (facts.name !== undefined && facts.name !== before.name) ||
    (facts.objective !== undefined && facts.objective !== before.objective) ||
    (facts.voiceId !== undefined && facts.voiceId !== before.voiceId) ||
    (facts.maxPostAgeDays !== undefined && facts.maxPostAgeDays !== before.maxPostAgeDays) ||
    productIds !== undefined);
  // The row first, told the set it will have, so a goal moving onto Product
  // promotion is checked against the products saved with it; then the set,
  // which refuses leaving a Product promotion campaign with none.
  const updated = await updateCampaignOp(
    tx,
    campaignId,
    {
      ...(facts.name === undefined ? {} : { name: facts.name }),
      ...(facts.objective === undefined ? {} : { objective: facts.objective }),
      ...(audience === undefined ? {} : { aiFilter: { instruction: audience } }),
      ...(facts.audienceProfile === undefined ? {} : { audienceProfile: facts.audienceProfile, baseRevision: facts.baseRevision }),
      ...(facts.voiceId === undefined ? {} : { voiceId: facts.voiceId }),
      ...(facts.maxPostAgeDays === undefined ? {} : { maxPostAgeDays: facts.maxPostAgeDays }),
    },
    { ...(productIds === undefined ? {} : { productIds }), audienceWrite: { reason: "owner_edit", changedBy: "owner", restoredFrom: facts.restoredFrom, otherEdits } },
  );
  if (!updated.ok) return updated;
  const productsMoved = productIds !== undefined && (await setCampaignProducts(tx, campaignId, [...productIds]));
  const briefMoved =
    before !== undefined &&
    ((facts.objective !== undefined && before.objective !== facts.objective) ||
      (audience !== undefined && (before.aiFilter?.instruction ?? "") !== audience) ||
      facts.audienceProfile !== undefined ||
      productsMoved);
  if (briefMoved) await routeBriefAside(tx, organizationId, campaignId);
  return updated;
}

async function routeBriefAside(tx: Tx, organizationId: string, campaignId: number): Promise<void> {
  try {
    await tx.transaction((savepoint) => routeCompile(savepoint, organizationId, { kind: "campaign", campaignId }));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[campaigns] brief compile not routed:", {
      campaignId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** A card asking the owner to change what one campaign is for — its name, its
 *  goal or its audience — on its Settings. Chat draws it
 *  (`chat/campaignFacts.ts`) and never writes the fields itself: chat reads
 *  third-party text. */
export const CAMPAIGN_FACTS = "campaign_facts.update";

/** The goals a campaign can be given today, as its Settings offers them. */
const AVAILABLE_OBJECTIVES = OBJECTIVES.filter((objective) => objective.available).map(
  (objective) => objective.id,
) as [CampaignObjective, ...CampaignObjective[]];

/** The three fields as a proposal may set them, with the bounds Settings'
 *  own save holds them to. */
export const campaignFactsPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    objective: z.enum(AVAILABLE_OBJECTIVES).optional(),
    audience: z.string().trim().max(2000).optional(),
  })
  .strict();
export type CampaignFactsPatch = z.infer<typeof campaignFactsPatchSchema>;

/** The change: which campaign, and the fields it sets. What they say now is
 *  the server's read (`readCampaignFactsBase`), never the model's. */
export const campaignFactsSchema = z
  .object({
    kind: z.literal(CAMPAIGN_FACTS),
    campaignId: z.number().int().positive(),
    patch: campaignFactsPatchSchema,
  })
  .strict();
export type CampaignFactsChange = z.infer<typeof campaignFactsSchema>;

/** The three fields as they stand — what a card is drawn over, what a click
 *  is measured against, and what Settings shows beside a proposed value. */
export const campaignFactsBaseSchema = z
  .object({ name: z.string(), objective: z.string(), audience: z.string() })
  .strict();
export type CampaignFactsBase = z.infer<typeof campaignFactsBaseSchema>;

/** The three fields as they stand. Undefined for a campaign that is not
 *  there. */
export async function readCampaignFactsBase(
  tx: Tx,
  campaignId: number,
): Promise<CampaignFactsBase | undefined> {
  const campaign = await getCampaign(tx, campaignId);
  if (!campaign) return undefined;
  return { name: campaign.name, objective: campaign.objective, audience: campaign.aiFilter?.instruction ?? "" };
}
