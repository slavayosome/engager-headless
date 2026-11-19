import { eq } from "drizzle-orm";
import { discoveredPosts, leads, messages, systemState, type DraftingKnobs } from "@engager/database/schema";
import { withOrg } from "@engager/database/tenant";
import type { LLM } from "../ai/client";
import { DEFAULT_DRAFTING_KNOBS } from "../learning/styleVariety";
import { getCommentDraftingContext } from "../operations/clientDrafting";
import { getCampaign } from "../operations/campaigns";
import { previewDispatch, readDispatchInputs, type DispatchPreview } from "../dispatcher/phase";
import { compileRules, writingRulesRevision, type CompiledWritingRules } from "../dispatcher/compile";
import { draftEvidence, HANDED_OFF_NOTE, KILL_SWITCH_NOTE } from "./phases";
import { previewLeadOpener } from "../leads/scout/openerDrafts";

export const PREVIEW_MAX_COUNT = 5;
export const PREVIEW_MAX_VARIANTS = 4;
export type PreviewVariant = { label: string; knobs: DraftingKnobs };
export type PreviewInput = {
  messageId?: number;
  discoveredPostId?: number;
  leadId?: number;
  signalId?: number;
  count?: number;
  variants?: PreviewVariant[];
};
export type PreviewResult = {
  post?: { discoveredPostId: number; campaignId: number; messageId: number | null };
  lead?: { leadId: number; signalId: number; campaignId: number };
  variants: Array<{ label: string; knobs: Pick<DraftingKnobs, "exemplarCount" | "rationing">; candidates: DispatchPreview[] }>;
};
export type PreviewRefusal = { refused: { code: string; message: string; status: number; recovery?: string } };
const refuse = (code: string, message: string, status: number, recovery?: string): PreviewRefusal =>
  ({ refused: { code, message, status, ...(recovery ? { recovery } : {}) } });

export async function previewCommentDrafts(
  organizationId: string,
  input: PreviewInput,
  llm: LLM,
  opts: { beforeExternalPhase?: () => Promise<void>; now?: number } = {},
): Promise<PreviewResult | PreviewRefusal> {
  const now = opts.now ?? Date.now();
  const count = Math.min(Math.max(input.count ?? 1, 1), PREVIEW_MAX_COUNT);
  const variants = input.variants?.length ? input.variants.slice(0, PREVIEW_MAX_VARIANTS) : [{ label: "current", knobs: {} }];
  if (variants.some(({ knobs }) => Object.keys(knobs).some((key) => key !== "exemplarCount" && key !== "rationing"))) {
    return refuse("invalid_knobs", "Accepted knobs: exemplarCount and rationing.", 400);
  }
  if (input.leadId != null) {
    if (input.signalId == null || input.messageId != null || input.discoveredPostId != null)
      return refuse("preview_target_required", "Name one lead and its signal, or one post.", 400);
    const lead = await withOrg(organizationId, async (tx) => {
      const [safety] = await tx.select().from(systemState);
      if (safety?.killSwitch) return refuse("account_stopped", `Nothing is drafted while ${KILL_SWITCH_NOTE}.`, 409);
      if (safety?.transferPaused || safety?.cloudPaused) return refuse("handed_off", `Nothing is drafted: ${HANDED_OFF_NOTE}.`, 409);
      const [row] = await tx.select().from(leads).where(eq(leads.id, input.leadId!));
      const campaign = row?.campaignId == null ? null : await getCampaign(tx, row.campaignId);
      return campaign ? { campaign } : refuse("lead_not_found", "A served campaign lead was not found.", 404);
    });
    if ("refused" in lead) return lead;
    await opts.beforeExternalPhase?.();
    const result: PreviewResult["variants"] = [];
    // One compile for the whole preview: the knobs never reach its inputs,
    // and a candidate whose rules moved recompiles by the revision check.
    let compiled: (CompiledWritingRules & { revision: string }) | undefined;
    for (const variant of variants) {
      const candidates: DispatchPreview[] = [];
      let knobs: Pick<DraftingKnobs, "exemplarCount" | "rationing"> = {};
      for (let i = 0; i < count; i++) {
        const preview = await previewLeadOpener({ organizationId, campaign: lead.campaign, llm, leadIds: [input.leadId], runId: null, now }, input.signalId, variant.knobs, compiled);
        if (!preview) return refuse("lead_signal_unavailable", "The signal is not the lead's current post opener.", 409);
        compiled = preview.compiled;
        knobs = preview.knobs;
        candidates.push(preview.result);
      }
      result.push({ label: variant.label, knobs, candidates });
    }
    return { lead: { leadId: input.leadId, signalId: input.signalId, campaignId: lead.campaign.id }, variants: result };
  }
  if (input.signalId != null) return refuse("preview_target_required", "Name one lead and its signal, or one post.", 400);
  const snapshot = await withOrg(organizationId, async (tx) => {
    const [safety] = await tx.select().from(systemState);
    if (safety?.killSwitch) return refuse("account_stopped", `Nothing is drafted while ${KILL_SWITCH_NOTE}.`, 409,
      "The owner turns the stop off in Engager; preview again after that.");
    if (safety?.transferPaused || safety?.cloudPaused) return refuse("handed_off", `Nothing is drafted: ${HANDED_OFF_NOTE}.`, 409);
    let postId = input.discoveredPostId;
    let messageId: number | null = null;
    if (input.messageId != null) {
      const [message] = await tx.select({ kind: messages.kind, discoveredPostId: messages.discoveredPostId })
        .from(messages).where(eq(messages.id, input.messageId));
      if (!message || message.kind !== "comment" || message.discoveredPostId == null)
        return refuse("message_not_found", `comment ${input.messageId} on a post was not found`, 404);
      messageId = input.messageId;
      postId = message.discoveredPostId;
    }
    const [post] = postId == null ? [] : await tx.select().from(discoveredPosts).where(eq(discoveredPosts.id, postId));
    if (!post) return refuse("discovered_post_not_found", `discovered_post ${postId} was not found`, 404);
    const campaign = await getCampaign(tx, post.campaignId);
    if (!campaign) return refuse("campaign_not_found", `campaign ${post.campaignId} was not found`, 404);
    const prepared = [];
    for (const variant of variants) {
      const context = await getCommentDraftingContext(tx, campaign, { discoveredPostId: post.id, llm: null, knobs: variant.knobs });
      if (!context.ok) return refuse("drafting_context_unavailable", context.error, 409);
      const dispatch = await readDispatchInputs(tx, campaign, [post], new Map([[post.id, context.data]]), now);
      const knobs = { ...DEFAULT_DRAFTING_KNOBS, ...context.data.voice.styleRules.knobs, ...variant.knobs };
      dispatch.rationing = knobs.rationing;
      dispatch.facts.examplesMax = knobs.exemplarCount;
      prepared.push({ label: variant.label, knobs: { exemplarCount: knobs.exemplarCount, rationing: knobs.rationing }, dispatch, evidence: draftEvidence(post, context.data) });
    }
    return { post, messageId, prepared };
  });
  if ("refused" in snapshot) return snapshot;
  await opts.beforeExternalPhase?.();
  // One compile for the whole preview: every variant's snapshot carries the
  // same rules, and the revision check in previewDispatch recompiles if not.
  const first = snapshot.prepared[0]!.dispatch;
  const compileInput = { channel: "comment" as const, voiceRules: first.voiceRules, campaignRules: first.campaignRules };
  const compiled = { ...(await compileRules(llm, compileInput)), revision: writingRulesRevision(compileInput) };
  const result = [];
  for (const variant of snapshot.prepared) {
    const candidates = [];
    for (let i = 0; i < count; i++) candidates.push(await previewDispatch(llm, variant.dispatch, snapshot.post, variant.evidence, now, compiled));
    result.push({ label: variant.label, knobs: variant.knobs, candidates });
  }
  return { post: { discoveredPostId: snapshot.post.id, campaignId: snapshot.post.campaignId, messageId: snapshot.messageId }, variants: result };
}

export function isPreviewRefusal(outcome: PreviewResult | PreviewRefusal): outcome is PreviewRefusal {
  return "refused" in outcome;
}
