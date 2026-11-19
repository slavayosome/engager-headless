import { and, desc, eq, ne } from "drizzle-orm";
import {
  campaignGuidance,
  campaigns,
  incomingComments,
  type Campaign,
  type Lead,
} from "@engager/database/schema";
import type { LLM } from "../ai/client";
import type { ProductContext, VoiceProfile } from "../ai/writer";
import { intentGate, productsWithin } from "../campaigns/intentGate";
import {
  finalizeBrainForWriter,
  prepareBrainForWriter,
  type BrainWriterPreparation,
  type DraftCtx,
} from "../draft";
import { getProfile } from "../profile";
import { loadCampaignProductContext } from "../products/queries";
import { assembleReplyContext, type ReplyThreadContext } from "../replyContext";
import {
  getVoiceForCampaign,
  resolveCampaignVoice,
  resolveVoiceV2,
} from "../voice";

/**
 * Everything the DM writer drafts from — assembled from the SAME seams the
 * reply writer uses: the trigger conversation via
 * assembleReplyContext, the lead's CAMPAIGN (its attached products, objective,
 * compiled brief + slot-aware Brain knowledge via brainForWriter, guidance,
 * voice), and the person's own engagement history. The one rule that exists
 * because of a real shipped bug: when the lead has no campaign or the campaign
 * has no attached product, `products` is EMPTY and the DM mentions no product —
 * NEVER a fallback to some org-wide products row (that pitched Papatime to an
 * Engager lead).
 */
export type LeadDmContext = {
  /** The conversation that produced the lead (undefined if the trigger row is gone). */
  thread?: ReplyThreadContext;
  /** The trigger comment's full text. */
  theirText: string | null;
  campaign?: Campaign;
  /** The campaign's attached products — empty means: mention NO product. */
  products: ProductContext[];
  /** The campaign objective's description ("the goal" line). */
  objective?: string;
  /** Compiled campaign brief (kill-switch-gated inside brainForWriter). */
  brief?: string;
  /** Slot-aware Brain knowledge relevant to their words. */
  knowledge?: string;
  /** Hard avoid-slot constraints — never violated, DM or not. */
  constraints?: string;
  /** Learned campaign guidance bullets. */
  guidance?: string;
  voice: VoiceProfile;
  person: {
    name: string | null;
    headline: string | null;
    followers: number | null;
    touchCount: number;
    /** What they said in OTHER thread replies (newest first, capped). */
    priorRemarks: string[];
  };
};

export type LeadDmContextPreparation = {
  base: Omit<LeadDmContext, "brief" | "knowledge" | "constraints">;
  brain: {
    queryText: string;
    prepared: BrainWriterPreparation;
  } | null;
};

/**
 * DB-only half of lead-DM context assembly. Every value needed by the optional
 * fact reranker is detached before the tenant transaction is released.
 */
export async function prepareLeadDmContext(
  tx: DraftCtx["db"],
  lead: Lead,
): Promise<LeadDmContextPreparation> {
  // --- The conversation that produced the lead ------------------------------
  const [inc] = lead.triggerIncomingCommentId
    ? await tx
        .select()
        .from(incomingComments)
        .where(eq(incomingComments.id, lead.triggerIncomingCommentId))
    : [undefined];
  const thread = inc ? await assembleReplyContext(tx, inc) : undefined;

  // --- The campaign whose engagement this is --------------------------------
  const campaignId = lead.campaignId ?? inc?.campaignId ?? null;
  const [campaign] = campaignId
    ? await tx.select().from(campaigns).where(eq(campaigns.id, campaignId))
    : [undefined];

  let products: ProductContext[] = [];
  let objective: string | undefined;
  let guidance: string | undefined;
  let brain: LeadDmContextPreparation["brain"] = null;
  if (campaign) {
    products = await loadCampaignProductContext(tx, campaign.id);
    // In lead mode the lead's own intent decides what the DM may say, in
    // place of the Goal: its framing, and a product only where one may come up.
    const intent = intentGate(lead.intent, products.length > 0);
    products = productsWithin(intent, products);
    objective = intent.framing;
    const queryText = inc?.text ?? lead.evidenceQuote ?? "";
    brain = {
      queryText,
      prepared: await prepareBrainForWriter(tx, campaign),
    };
    const [g] = await tx
      .select({ g: campaignGuidance.guidance })
      .from(campaignGuidance)
      .where(eq(campaignGuidance.campaignId, campaign.id));
    guidance = g?.g ?? undefined;
  }

  // --- Voice: the campaign's DM description, else the org default's --------
  const prof = await getProfile(tx);
  const voice: VoiceProfile = campaign
    ? await resolveCampaignVoice(tx, campaign, prof, "dm")
    : resolveVoiceV2({
        voice:
          (await getVoiceForCampaign(tx, { voiceId: null }))?.voice ?? null,
        attached: false,
        profile: prof,
        channel: "dm",
      });

  // --- The person's own words across other campaign threads -----------------
  const priorRemarks = lead.profileId
    ? (
        await tx
          .select({ text: incomingComments.text })
          .from(incomingComments)
          .where(
            and(
              eq(incomingComments.authorProfileId, lead.profileId),
              eq(incomingComments.source, "our_comment_thread"),
              ...(inc ? [ne(incomingComments.id, inc.id)] : []),
            ),
          )
          .orderBy(desc(incomingComments.receivedAt))
          .limit(4)
      ).map((r) => r.text)
    : [];

  return {
    base: {
      thread,
      theirText: inc?.text ?? null,
      campaign,
      products,
      objective,
      guidance,
      voice,
      person: {
        name: lead.name,
        headline: lead.headline,
        followers: lead.followers,
        touchCount: lead.touchCount,
        priorRemarks,
      },
    },
    brain,
  };
}

/** Provider-capable half. It receives no database handle by construction. */
export async function finalizeLeadDmContext(
  preparation: LeadDmContextPreparation,
  opts: { llm?: LLM | null },
): Promise<LeadDmContext> {
  const brain = preparation.brain
    ? await finalizeBrainForWriter(preparation.brain.prepared, {
        queryText: preparation.brain.queryText,
        llm: opts.llm,
      })
    : null;
  return {
    ...preparation.base,
    brief: brain?.brief,
    knowledge: brain?.knowledge || undefined,
    constraints: brain?.constraints,
  };
}

/** Compatibility seam for existing worker/MCP callers. */
export async function assembleLeadDmContext(
  ctx: DraftCtx,
  lead: Lead,
): Promise<LeadDmContext> {
  const preparation = await prepareLeadDmContext(ctx.db, lead);
  return finalizeLeadDmContext(preparation, {
    llm: ctx.llm,
  });
}
