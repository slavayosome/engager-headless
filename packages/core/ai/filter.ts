import { z } from "zod";
import type { Campaign } from "@engager/database/schema";
import { audienceProfile, type AudienceCampaign } from "../audience/model";
import { placesBind } from "../audience/geography";
import type { ConnectorDeclaration } from "../connector/capabilities";
import { getLLM, type LLM } from "./client";
import { modelFor } from "./modelFor";
import { promptRef } from "./prompt/ids";
import { untrusted } from "./prompts";

export const FilterVerdict = z.object({
  go: z.boolean(),
  reason: z.string().optional(),
  matches_topic: z.boolean(),
  sentiment_ok: z.boolean(),
  // Whether this post is an appropriate context for a light product mention. REQUIRED
  // (not optional): it is a safety veto, and "promo allowed" is the unsafe default — an
  // omitted field would silently let promos through on raw/sensitive posts. Independent
  // of `go`: a post can be relevant (go=true) yet promo_safe=false (comment, but neutral).
  promo_safe: z.boolean(),
  confidence: z.number().int().min(0).max(3),
});
export type FilterVerdict = z.infer<typeof FilterVerdict>;

export type FilterInput = {
  contentText: string;
  authorName?: string | null;
  detectedLanguage?: string | null;
};

export type FilterResult = {
  pass: boolean;
  score: number; // 0..1
  reason: string;
  verdict?: FilterVerdict;
};

/** The relevance-gate rubric. Exported so the client-drafting skill ships the exact
 *  same judgment criteria the server pipeline applies. */
export const FILTER_SYSTEM = `You are a strict relevance gate for a LinkedIn engagement campaign.
You decide whether ONE post is eligible for the campaign to comment on. You do NOT write comments.
Apply the campaign's targeting instruction literally and conservatively. When in doubt, reject (go=false).
Judge only topic match and sentiment fit — language is handled in code.
Also judge promo_safe: whether this post is an appropriate moment for a light, tasteful product mention.
Set promo_safe=false when the post is about grief, loss, illness, a layoff, a death, a raw personal
struggle, or any moment where promoting anything would read as tone-deaf — even when the topic matches and
the post is otherwise eligible (go can still be true). When unsure, set promo_safe=false.
Return a short factual reason and per-criterion booleans.`;

/** The code-enforced language gate, then the model judges topic + sentiment. */
export async function runFilter(opts: {
  post: FilterInput;
  campaign: Campaign;
  llm?: LLM;
}): Promise<FilterResult> {
  const f = opts.campaign.aiFilter;
  const { post } = opts;

  // 1. deterministic language gate (only when we actually know the language)
  if (f?.target_language && post.detectedLanguage) {
    if (post.detectedLanguage.toLowerCase() !== f.target_language.toLowerCase()) {
      return {
        pass: false,
        score: 0,
        reason: `language ${post.detectedLanguage} != ${f.target_language}`,
      };
    }
  }

  // 2. model topic/sentiment judgment
  const instruction = f?.instruction?.trim() || "Posts relevant to the campaign.";
  const llm = opts.llm ?? getLLM();
  const user = [
    `CAMPAIGN_INSTRUCTION: ${instruction}`,
    post.authorName ? `AUTHOR: ${post.authorName}` : "",
    untrusted("POST", post.contentText),
  ]
    .filter(Boolean)
    .join("\n");

  const verdict = await llm.json({
    model: modelFor("filter"),
    stage: "filter",
    promptRef: promptRef("judge.filter"),
    system: FILTER_SYSTEM,
    user,
    schema: FilterVerdict,
    maxTokens: 200,
  });

  const minConf = opts.campaign.aiFilter?.min_confidence ?? 0;
  const pass = verdict.go && verdict.confidence >= minConf;
  return {
    pass,
    score: verdict.confidence / 3,
    reason: verdict.reason ?? "",
    verdict,
  };
}

/** A targeting facet that is configured on a campaign but never arrives. */
export type TargetingFacet = "geo" | "language";

/**
 * The facets a campaign targets that this connector never feeds it.
 *
 * Language is gated on the post, and only when the post carries it — the
 * deliberate choice, because rejecting a post for an unknown language would
 * reject everything. A connector whose discovery emits none turns
 * `target_language` into no filter at all rather than a loose one.
 *
 * Countries are never read off a post: Research reads them off the author's
 * and the fitting comment authors' profiles. So they bind only on a campaign that
 * verifies, on a connector whose profile read carries a country.
 *
 * Surfaces advise with this and nothing blocks on it (INV-6). The settings
 * stay saved and start binding the day both halves hold.
 */
export function inertTargetingFacets(
  campaign: AudienceCampaign,
  declaration: ConnectorDeclaration,
): TargetingFacet[] {
  const facets: TargetingFacet[] = [];
  if (placesBind(audienceProfile(campaign).where) &&
      !(campaign.verifyStage && declaration.profile_read.emitsAuthorGeo)) {
    facets.push("geo");
  }
  if (campaign.aiFilter?.target_language?.trim() && !declaration.discover.emitsLanguage) {
    facets.push("language");
  }
  return facets;
}
