import type { Tx } from "@engager/database/tenant";
import { and, eq, inArray } from "drizzle-orm";
import { searches } from "@engager/database/schema";
import { NETWORK_CATALOGS } from "../strategy/catalog";
import { parseStrategy } from "../strategy/contract";
import { draftingVoiceId } from "../strategy/draftingVoice";
import { duplicatePatch } from "../strategy/duplicate";
import { readPatchState } from "../strategy/patch";
import { readCampaignStrategy } from "../strategy/read";
import { readSearchDepth } from "../strategy/searchDepth";
import { submitStrategyPatch } from "../strategy/submit";
import { campaignProductId } from "../products/queries";
import { getCampaign } from "./campaigns";
import { getVoice } from "./voices";
import { requireSavedCampaign, saveCampaign } from "./saveCampaign";
import { editableAudience } from "../audience/model";

/**
 * DUPLICATING A CAMPAIGN — a new one, Not started, to try a variant without
 * rebuilding its setup or touching the original.
 *
 * The copy is created like every campaign (`createCampaignOp`): on its
 * strategy, Paused, on the original's account, with a Scout of its own. It
 * takes what the original is FOR — its goal, audience, voice (the one its
 * drafts are written in, as the copy's campaign voice) and oldest post age, its
 * search depth, the searches the owner set (`discover`, and the ones added by
 * hand on Searches), its product — and its strategy, the version in
 * force or else its draft, as the copy's draft (`duplicatePatch`), steps and
 * modes as they are, Research with them, so a Deep original's copy is Deep.
 * The copy finds leads, as every campaign created does: an original whose
 * Scout still finds posts is copied with Find leads in its place, its
 * Instructions and its depth kept (`switchedDocument`).
 *
 * It takes nothing the original DID: no posts, drafts, runs, people, changes
 * or search history, so its week starts at zero. Nothing in it wakes until its
 * own Start, and the original is only read. Null for a campaign that no longer
 * stands.
 */
export async function duplicateCampaignOp(
  tx: Tx,
  campaignId: number,
  options: { approver: string; now: number },
): Promise<number | null> {
  const { now } = options;
  const source = await getCampaign(tx, campaignId);
  if (!source) return null;
  const searchDepth = await readSearchDepth(tx, source);
  // The copy offers what the source's drafts use, the one product.
  const product = await campaignProductId(tx, campaignId);
  const strategy = await readCampaignStrategy(tx, campaignId);
  const parsed = strategy && parseStrategy(strategy.strategy.document, {
    network: strategy.network ? NETWORK_CATALOGS[strategy.network] : null,
  });
  if (parsed && !parsed.success) {
    throw new Error(`campaign ${campaignId}'s strategy fails the contract: ${parsed.error.message}`);
  }
  const document = parsed?.data ?? null;
  const named = document ? draftingVoiceId(document.voice, source) : source.voiceId;
  // A strategy voice since deleted from Voice leaves the copy on the campaign's.
  const voiceId = named !== null && named !== source.voiceId && !(await getVoice(tx, named)) ? source.voiceId : named;
  const copy = await saveCampaign(tx, source.organizationId, {
    createFields: {
      name: `${source.name} (copy)`,
      objective: source.objective,
      ...(source.aiFilter ? { aiFilter: source.aiFilter } : {}),
      ...(source.audienceProfile ? { audienceProfile: editableAudience(source.audienceProfile) } : {}),
      ...(source.discovery ? { discovery: source.discovery } : {}),
      voiceId,
      maxPostAgeDays: source.maxPostAgeDays,
    },
    goal: source.objective, depth: searchDepth, products: product === null ? [] : [product], source: "duplicate", actor: "owner",
    ...(source.channelId === null ? {} : { channelId: source.channelId }),
  }, options.approver);
  const copyId = requireSavedCampaign(copy).campaign!.id;
  // The owner's own searches start fresh on the copy — from their first page,
  // with no history behind them — and read as they were set to: the depth,
  // the sort and the window.
  const sourceSearches = await tx.select().from(searches).where(and(
    eq(searches.campaignId, campaignId),
    inArray(searches.status, ["active", "parked"]),
  ));
  for (const search of sourceSearches) {
    await tx.insert(searches).values({
      campaignId: copyId,
      sourceKey: search.sourceKey, lane: search.lane, term: search.term,
      displayName: search.displayName, targetRef: search.targetRef,
      languageType: search.languageType, painId: search.painId,
      origin: search.origin, sourceRole: search.sourceRole, status: search.status,
      refusedAt: search.refusedAt, pinned: search.pinned, rationale: search.rationale,
      pagesPerSweep: search.pagesPerSweep, sort: search.sort, datePosted: search.datePosted,
      createdAt: now, updatedAt: now,
    });
  }
  if (document) {
    const draft = await readPatchState(tx, copyId, { lock: true });
    // The voice it names is the copy's campaign voice, so its steps name none.
    const patch = duplicatePatch({
      campaignId: copyId,
      expectedBaseVersion: draft.active.version,
      base: draft.base,
      source: { ...document, voice: { ...document.voice, voice_profile_id: null } },
      instruction: `Duplicate ${source.name}`,
    });
    if (patch.ops.length > 0 || patch.requestedGrants) {
      // Its Research is the depth the create already told.
      await submitStrategyPatch(tx, source.organizationId, patch, {
        approver: options.approver,
        now,
        draft: true,
        reportedDepth: searchDepth,
      });
    }
  }
  return copyId;
}
