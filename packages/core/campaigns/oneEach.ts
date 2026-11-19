import { eq } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import { campaigns, voices } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import type { CampaignAgentStrategy } from "../strategy/contract";
import { draftingVoiceId } from "../strategy/draftingVoice";

/**
 * ONE PRODUCT, OR NONE, AND ONE VOICE PER CAMPAIGN (US-SIM-B12, US-SIM-M02).
 * The Ambassador's setup holds both; `save_campaign` takes both; a step has
 * no voice of its own. The refusals are worded here once, so the page and
 * the tools refuse the same things in the same words.
 *
 * A campaign made before the rule may still have several products attached:
 * its drafts use the first one added to Brain ({@link productInUse}) until the
 * owner picks one, and every surface says so.
 */

export const ONE_PRODUCT = "A campaign offers one product, or none. Pick one.";

/** A write that would leave a campaign offering more than one product. */
export class OneProductError extends AppError {
  readonly field = "products";
  readonly recovery = "Send one productId, or null for nothing to offer.";

  constructor() {
    super("one_product", ONE_PRODUCT, 400);
  }
}

/** How a voice is named to the owner; null is their own. */
export const OWN_VOICE = "Your voice";

export function oneVoiceRefusal(voiceName: string): string {
  return `This campaign writes in one voice, ${voiceName}, on every step. Change the campaign's voice instead.`;
}

/** A strategy patch that would give the campaign's steps a voice of their own. */
export class OneVoiceError extends AppError {
  readonly recovery = "Set the campaign's voice with save_campaign voiceId; the owner sets it on the Ambassador's Voice row.";

  constructor(voiceName: string) {
    super("one_voice", oneVoiceRefusal(voiceName), 409);
  }
}

/** The product a campaign's drafts use of those attached: the one, or, while
 *  an older campaign still has several, the first added to Brain. */
export function productInUse(attached: readonly number[]): number | null {
  return attached.length === 0 ? null : Math.min(...attached);
}

/** A voice row's name, or the owner's own for none (or one since deleted). */
export async function voiceName(tx: Tx, voiceId: number | null): Promise<string> {
  if (voiceId === null) return OWN_VOICE;
  const [row] = await tx.select({ name: voices.name }).from(voices).where(eq(voices.id, voiceId));
  return row?.name ?? OWN_VOICE;
}

/**
 * Refuses a version that sets a voice in the strategy document
 * (`voice.voice_profile_id`) — the step voice a patch could carry. Clearing it
 * lands, and so does every other change on a campaign that still has one,
 * which its voice row asks the owner to settle.
 */
export async function refuseStepVoice(
  tx: Tx,
  campaignId: number,
  before: CampaignAgentStrategy,
  after: CampaignAgentStrategy,
): Promise<void> {
  const set = after.voice.voice_profile_id;
  if (set === null || set === before.voice.voice_profile_id) return;
  const [campaign] = await tx.select({ voiceId: campaigns.voiceId }).from(campaigns).where(eq(campaigns.id, campaignId));
  throw new OneVoiceError(await voiceName(tx, draftingVoiceId(before.voice, { voiceId: campaign?.voiceId ?? null })));
}
