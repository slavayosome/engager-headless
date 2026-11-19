import { asc, eq } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import { campaignProducts, products, type Campaign } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { productInUse, voiceName } from "../campaigns/oneEach";
import { draftingVoiceId } from "../strategy/draftingVoice";
import { readPatchState, STRATEGY_PATCH } from "../strategy/patch";
import { submitStrategyPatch } from "../strategy/submit";
import { savedStrategy } from "../strategy/writingInstructions";
import { writeCampaignFacts } from "./campaignFacts";
import { getVoice } from "./voices";

const ONE_VOICE_COMPILER_VERSION = "campaign-one-voice/1";

type Named = { id: number; name: string };
type NamedVoice = { id: number | null; name: string };

/**
 * A CAMPAIGN'S ONE PRODUCT AND ONE VOICE, as its drafts use them
 * (`products/queries.ts` `campaignProductId`, `strategy/draftingVoice.ts`),
 * with what is still the owner's to pick: the products of an older campaign
 * that has several, and the voice its row names while its strategy writes in
 * another. The Ambassador's setup and `get_campaign` both read it, so what
 * they say is what the worker uses.
 */
export type CampaignOneEach = {
  /** The product drafts use, or null for nothing to offer. */
  product: Named | null;
  /** Every product attached, while there are several. */
  attached: Named[] | null;
  /** The voice drafts are written in. */
  voice: NamedVoice;
  /** The voice the campaign names, while its strategy writes in another. */
  campaignVoice: NamedVoice | null;
};

export async function campaignOneEach(tx: Tx, campaign: Pick<Campaign, "id" | "voiceId">): Promise<CampaignOneEach> {
  const attached = await tx
    .select({ id: products.id, name: products.name })
    .from(campaignProducts)
    .innerJoin(products, eq(products.id, campaignProducts.productId))
    .where(eq(campaignProducts.campaignId, campaign.id))
    .orderBy(asc(products.id));
  const inUse = productInUse(attached.map((product) => product.id));
  const saved = await savedStrategy(tx, campaign.id);
  const voiceId = saved ? draftingVoiceId(saved.document.voice, campaign) : campaign.voiceId;
  return {
    product: attached.find((product) => product.id === inUse) ?? null,
    attached: attached.length > 1 ? attached : null,
    voice: { id: voiceId, name: await voiceName(tx, voiceId) },
    campaignVoice:
      voiceId === campaign.voiceId ? null : { id: campaign.voiceId, name: await voiceName(tx, campaign.voiceId) },
  };
}

/** The owner's pick of the one product, or none: the campaign offers that,
 *  whatever it had attached. */
export async function pickCampaignProduct(
  tx: Tx,
  organizationId: string,
  campaignId: number,
  productId: number | null,
): Promise<{ ok: boolean }> {
  if (productId !== null) {
    const [found] = await tx.select({ id: products.id }).from(products).where(eq(products.id, productId));
    if (!found) throw new AppError("invalid_products", "That product is no longer in Brain.", 400);
  }
  return writeCampaignFacts(tx, organizationId, campaignId, { productIds: productId === null ? [] : [productId] });
}

/** The owner's pick of the campaign's one voice: the campaign row names it
 *  and its strategy writes in no other (`settleCampaignVoice`). */
export async function pickCampaignVoice(
  tx: Tx,
  organizationId: string,
  campaignId: number,
  voiceId: number | null,
  options: { approver: string; now: number },
): Promise<{ ok: boolean }> {
  if (voiceId !== null && !(await getVoice(tx, voiceId))) {
    throw new AppError("invalid_voice", "That voice is no longer on Voice.", 400);
  }
  const written = await writeCampaignFacts(tx, organizationId, campaignId, { voiceId });
  if (written.ok) await settleCampaignVoice(tx, organizationId, campaignId, options);
  return written;
}

/**
 * Clears a voice the campaign's strategy names of its own
 * (`voice.voice_profile_id`), in one version, so its drafts are written in
 * the voice its row names. Nothing when it names none.
 */
export async function settleCampaignVoice(
  tx: Tx,
  organizationId: string,
  campaignId: number,
  options: { approver: string; now: number },
): Promise<void> {
  const saved = await savedStrategy(tx, campaignId);
  if (!saved || saved.document.voice.voice_profile_id === null) return;
  const state = await readPatchState(tx, campaignId, { lock: true });
  const path = "/voice/voice_profile_id";
  const outcome = await submitStrategyPatch(tx, organizationId, {
    kind: STRATEGY_PATCH,
    campaignId,
    expectedBaseVersion: state.active.version,
    ops: [{ op: "replace", path, value: null }],
    dependencyVersions: { voice: null, knowledge: null, memory: null },
    provenance: {
      instruction: "Write in the campaign's voice",
      recognizedIntent: { summary: "One voice for the whole campaign", paths: [path] },
      scope: { stepId: null },
      compilerVersion: ONE_VOICE_COMPILER_VERSION,
    },
  }, { ...options, draft: true });
  if (!("applied" in outcome)) throw new AppError("voice_not_settled", "The campaign's voice could not be saved. Try again.", 409);
}
