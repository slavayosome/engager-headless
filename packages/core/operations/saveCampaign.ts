import { AppError } from "@engager/common/errors";
import { ZodError } from "zod";
import type { Tx } from "@engager/database/tenant";
import { audienceProfile, editableAudience, sameAudience, type AudienceProfileInput } from "../audience/model";
import { AUDIENCE_UPDATE, changedAudience, type AudienceChange } from "../audience/change";
import { recordProposal } from "../chat/proposals";
import { products, SEARCH_DEPTHS, type SearchDepth } from "@engager/database/schema";
import { inArray } from "drizzle-orm";
import { assertPublicCampaignProductSelection, createCampaignOp, getCampaign, setCampaignStatusOp, updateCampaignOp, UnsupportedPublicCampaignFlowError, type CampaignInput, type CreateCampaignInput } from "./campaigns";
import { duplicateCampaignOp } from "./duplicateCampaign";
import { setCampaignProducts } from "./products";
import { settleCampaignVoice } from "./campaignOneEach";
import { OneProductError } from "../campaigns/oneEach";
import { compileFields, routeCompile } from "./compileRouting";
import { readPatchState, StrategyPatchError, type StrategyPatch } from "../strategy/patch";
import { awaitingStart, readCampaignStrategy } from "../strategy/read";
import { setSearchDepth, submitStrategyPatch } from "../strategy/submit";
import { CAMPAIGN_TEMPLATES, designPatch, startingPatch, templateContext, UNASKED_ANSWERS, type CampaignTemplateId } from "../strategy/templates";
import { MEET_THE_ROOM_NEEDS_DEEP, meetTheRoomOffPatch } from "../strategy/addStep";
import { currentSearchDepth } from "../strategy/searchDepth";
import { quickSearchTerms } from "../campaigns/quickSearches";
import type { CampaignDesign } from "../strategy/firstCampaignActions";

export type SaveCampaignInput = {
  id?: number; name?: string; goal?: CampaignInput["objective"]; audience?: AudienceProfileInput;
  depth?: SearchDepth; voiceId?: number | null; products?: number[]; status?: "paused" | "archived";
  recompileBrief?: boolean; duplicateFrom?: number; template?: CampaignTemplateId;
  createFields?: CreateCampaignInput; channelId?: number;
  source?: "form" | "onboarding" | "chat" | "duplicate"; actor?: "owner" | "agent";
  templateAnswers?: typeof UNASKED_ANSWERS;
  /** A new campaign's steps — a starting point's, or the owner's own from
   *  New campaign (`firstCampaignActions.ts`). */
  design?: CampaignDesign;
  strategyPatch?: (campaignId: number, state: Awaited<ReturnType<typeof readPatchState>>) => StrategyPatch;
};

/** The fields that can draw a card instead of landing, on a campaign that exists. */
const CARD_FIELDS = ["audience", "depth", "template", "design"] as const;

class Held {
  constructor(readonly drawn: readonly (typeof CARD_FIELDS)[number][]) {}
}

/**
 * A save that mixes a change waiting for the owner with changes that land
 * applies none of them and draws no card. The caller can send the other fields
 * first, then the widening on its own.
 */
export async function saveCampaign(tx: Tx, organizationId: string, input: SaveCampaignInput, approver: string) {
  try {
    return { valid: true as const, ...await tx.transaction(nested => saveUnlessMixed(nested, organizationId, input, approver)) };
  } catch (error) {
    if (error instanceof ZodError) return { valid: false as const, errors: error.issues.map(issue => ({ field: issue.path.join("."), code: issue.code, message: issue.message })) };
    if (error instanceof AppError && (error.code === "campaign_product_required" || error.code === "invalid_products" || error.code === "one_product")) return { valid: false as const, errors: [{ field: "products", code: error.code, message: error.message }] };
    if (error instanceof AppError && error.status === 400 && !(error instanceof UnsupportedPublicCampaignFlowError)) return { valid: false as const, errors: [{ field: "field" in error && typeof error.field === "string" ? error.field : null, code: error.code, message: error.message }] };
    throw error;
  }
}

export function requireSavedCampaign(result: Awaited<ReturnType<typeof saveCampaign>>) {
  if (!result.valid) throw new AppError(result.errors[0]?.code ?? "invalid_campaign", result.errors[0]?.message ?? "Invalid campaign", 400);
  return result;
}

/** Who asked and how; never a change of its own. */
const CALLER_FIELDS = ["id", "source", "actor"];

async function saveUnlessMixed(tx: Tx, organizationId: string, input: SaveCampaignInput, approver: string) {
  const asked = Object.entries(input).filter(([key, value]) => value !== undefined && !CALLER_FIELDS.includes(key)).map(([key]) => key);
  if (!input.id || !asked.some(key => (CARD_FIELDS as readonly string[]).includes(key))) {
    return saveCampaignIn(tx, organizationId, input, approver);
  }
  try {
    return await tx.transaction(async attempt => {
      const result = await saveCampaignIn(attempt, organizationId, input, approver);
      const drawn = CARD_FIELDS.filter(field => drawsCard(result, field));
      if (drawn.length && asked.length > 1) throw new Held(drawn);
      return result;
    });
  } catch (error) {
    if (!(error instanceof Held)) throw error;
    const widening = error.drawn[0]!;
    const others = asked.filter(key => key !== widening);
    throw new AppError("mixed_change", `Nothing changed. Widening: ${widening}; other fields: ${others.join(", ")}. Send the other fields first, then the widening alone.`, 409);
  }
}

type Saved = Awaited<ReturnType<typeof saveCampaignIn>>;
function drawsCard(result: Saved, field: (typeof CARD_FIELDS)[number]): boolean {
  if (field === "audience") return !!result.proposals?.some(card => card && "kind" in card && card.kind === AUDIENCE_UPDATE);
  const outcome = field === "depth" ? result.depth?.strategy : field === "design" ? result.design : result.template;
  return !!outcome && "proposed" in outcome;
}

async function saveCampaignIn(tx: Tx, organizationId: string, input: SaveCampaignInput, approver: string) {
  const now = Date.now();
  if (input.id && input.duplicateFrom) throw new AppError("invalid_campaign", "A duplicate creates a new campaign; omit id.", 400);
  if (input.status !== undefined && input.status !== "paused" && input.status !== "archived") throw new AppError("owner_start_required", "Start the campaign in Engager.", 403);
  if (!input.id && input.status === "archived") throw new AppError("invalid_status", "A new campaign is created paused.", 400);
  if (input.template && !(input.template in CAMPAIGN_TEMPLATES)) throw new AppError("invalid_template", "Unknown campaign template.", 400);
  if (input.template && input.design) throw new AppError("invalid_template", "Give a starting point or a template, not both.", 400);
  if (input.products?.length) {
    const ids = [...new Set(input.products)];
    if (ids.length > 1) throw new OneProductError();
    const found = await tx.select({ id: products.id }).from(products).where(inArray(products.id, ids));
    if (found.length !== ids.length) {
      throw new AppError("invalid_products", "One or more products are unavailable.", 400);
    }
  }
  let campaignId = input.id;
  if (input.duplicateFrom) {
    campaignId = (await duplicateCampaignOp(tx, input.duplicateFrom, { approver, now })) ?? undefined;
    if (!campaignId) throw new AppError("campaign_not_found", "The campaign to duplicate was not found.", 404);
  } else if (!campaignId) {
    assertPublicCampaignProductSelection(input.products ?? [], input.goal ?? input.createFields?.objective);
    const audience = input.audience ?? input.createFields?.audienceProfile;
    const depth = input.depth ?? input.createFields?.searchDepth;
    // A Quick campaign designed here starts with its pains' keyword searches,
    // so its first look reads something.
    const searches = input.design && depth === "quick" && audience && !input.createFields?.discovery ? quickSearchTerms(audience) : [];
    campaignId = await createCampaignOp(tx, {
      ...input.createFields,
      ...(searches.length > 0 && { discovery: { keywords: searches } }),
      name: input.name ?? input.createFields?.name,
      objective: input.goal ?? input.createFields?.objective,
      audienceProfile: audience,
      searchDepth: depth,
      voiceId: input.voiceId ?? input.createFields?.voiceId,
    }, now, { source: input.source ?? "chat", actor: input.actor ?? "agent", channelId: input.channelId });
  }
  const current = await getCampaign(tx, campaignId);
  if (!current) throw new AppError("campaign_not_found", `campaign ${campaignId} not found`, 404);
  // The depth this save leaves the campaign at, read before anything here
  // moves it: what Meet the room is held to, and what a lowered depth left.
  const depthBefore = input.id && (input.design || input.depth) ? await currentSearchDepth(tx, campaignId) : null;
  const depthAfter = input.depth ?? depthBefore ?? "standard";
  if (input.design?.steps.meet_the_room && depthAfter !== "deep") {
    throw new AppError("meet_the_room_needs_deep", MEET_THE_ROOM_NEEDS_DEEP.switchOn, 400);
  }
  let audienceProposal: Awaited<ReturnType<typeof recordProposal>> | null = null;
  if (input.id || input.duplicateFrom) {
    const draftAudience = input.audience && await awaitingStart(tx, current) ? input.audience : undefined;
    if (input.audience && !draftAudience) {
      const before = audienceProfile(current);
      if (!sameAudience(editableAudience(before), input.audience)) {
        const prior = editableAudience(before);
        const change: AudienceChange = { kind: AUDIENCE_UPDATE, campaignId,
          ...(JSON.stringify(prior.who) !== JSON.stringify(input.audience.who) && { who: input.audience.who }),
          ...(JSON.stringify(prior.notThem) !== JSON.stringify(input.audience.notThem) && { notThem: input.audience.notThem }),
          ...(JSON.stringify(prior.pains) !== JSON.stringify(input.audience.pains) && { pains: input.audience.pains.map(({ id, text, phrases }) => ({ id, text, phrases })) }) };
        let resolved: AudienceProfileInput;
        try { resolved = changedAudience(before, change); }
        catch { throw new AppError("needs_owner_confirmation", "This audience change must be made in Engager.", 409); }
        if (!sameAudience(resolved, input.audience)) throw new AppError("needs_owner_confirmation", "This audience change cannot be represented by the confirmation card; change it in Engager.", 409);
        audienceProposal = await recordProposal(tx, organizationId, change, { sessionId: null, turnId: null }, now);
      }
    }
    const fields: CampaignInput = {
      ...input.createFields,
      ...(input.name !== undefined && { name: input.name }),
      ...(input.goal !== undefined && { objective: input.goal }),
      ...(draftAudience !== undefined && { audienceProfile: draftAudience, baseRevision: current.audienceRevision }),
      ...(input.voiceId !== undefined && { voiceId: input.voiceId }),
    };
    if (fields.audienceProfile) fields.baseRevision = current.audienceRevision;
    if (Object.keys(fields).length || input.products !== undefined) await updateCampaignOp(tx, campaignId, fields, { productIds: input.products, actor: input.actor ?? "agent" });
  }
  if (input.status !== undefined) await setCampaignStatusOp(tx, campaignId, input.status, now, { actor: input.actor ?? "agent" });
  if (input.products !== undefined) await setCampaignProducts(tx, campaignId, input.products);
  if (input.id && input.voiceId !== undefined) await settleCampaignVoice(tx, organizationId, campaignId, { approver, now });
  const template = input.template ?? (!input.id && !input.duplicateFrom && !input.strategyPatch && !input.design && input.source !== "duplicate" && input.depth === "quick" ? "discover_and_draft" : undefined);
  let templateResult = null;
  if (template) {
    const state = await readPatchState(tx, campaignId, { lock: true });
    templateResult = await submitStrategyPatch(tx, organizationId, designPatch({ campaignId, expectedBaseVersion: state.active.version, base: state.base, template, answers: input.templateAnswers ?? UNASKED_ANSWERS, context: templateContext(state), instruction: `Use ${CAMPAIGN_TEMPLATES[template].label}` }), { approver, now, draft: true });
  }
  let designResult = null;
  if (input.design) {
    const state = await readPatchState(tx, campaignId, { lock: true });
    designResult = await submitStrategyPatch(tx, organizationId, startingPatch({ campaignId, expectedBaseVersion: state.active.version, base: state.base, design: input.design, context: templateContext(state), instruction: "Design the campaign from New campaign" }), { approver, now, draft: true });
  }
  if (input.strategyPatch) {
    const state = await readPatchState(tx, campaignId, { lock: true });
    const patch = input.strategyPatch(campaignId, state);
    if (patch.ops.length || patch.requestedGrants) {
      try { await submitStrategyPatch(tx, organizationId, patch, { approver, now, draft: true }); }
      catch (error) { if (!input.id || !(error instanceof StrategyPatchError) || error.code !== "proposal_is_a_no_op") throw error; }
    }
  }
  let depthResult = null;
  let switchedOff = null;
  if (input.depth && (input.id || input.duplicateFrom || input.depth === "deep")) {
    // Meet the room needs Deep: a depth lowered here switches it off with
    // the depth's own change, and the answer says so.
    let alongside = null;
    if (depthBefore && SEARCH_DEPTHS.indexOf(input.depth) < SEARCH_DEPTHS.indexOf(depthBefore)) {
      const state = await readPatchState(tx, campaignId, { lock: true });
      alongside = meetTheRoomOffPatch({ campaignId, expectedBaseVersion: state.active.version, document: state.base, instruction: `Set search depth to ${input.depth}` });
      if (alongside) switchedOff = { step: "meet_the_room", message: MEET_THE_ROOM_NEEDS_DEEP.switchedOff };
    }
    depthResult = await setSearchDepth(tx, organizationId, campaignId, input.depth, { approver, now, instruction: `Set search depth to ${input.depth}`, alongside, ...(!input.id && { reportedDepth: input.depth }) });
  }
  const compile = input.recompileBrief || (!input.id && !input.duplicateFrom) || Object.keys(input).some(key => ["goal", "products"].includes(key) || (key === "audience" && !audienceProposal))
    ? compileFields(await routeCompile(tx, organizationId, { kind: "campaign", campaignId })) : null;
  const proposals = [depthResult?.strategy, templateResult, designResult, audienceProposal && { proposed: true, status: "pending", ...audienceProposal }].filter(result => result && "proposed" in result && result.proposed);
  return { campaign: await getCampaign(tx, campaignId), strategy: await readCampaignStrategy(tx, campaignId), depth: depthResult, template: templateResult, design: designResult, compile, ...(switchedOff && { switchedOff }), ...(proposals.length && { proposed: true, proposals }) };
}
