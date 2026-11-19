import type { LeadIntent, LeadTier } from "@engager/database/schema";

/**
 * Lead scoring — pure, no IO. Tier = intent × authority × repeat engagement.
 * Kept deliberately coarse (three tiers, no numeric score): founders triage
 * hot/warm/watch, not decimals. The tier RATCHETS UP at the intake layer
 * (a later 'none' comment never demotes a hot lead) — this function just
 * scores one snapshot; ratcheting is `maxTier` at the call site.
 */

export type LeadAuthority = {
  headline?: string | null;
  followers?: number | null;
  isInfluencer?: boolean | null;
};

/** Titles that make a comment author a likely buyer/decision-maker. */
export const AUTHORITY_HEADLINE_RE =
  /\b(founder|co-founder|ceo|cto|coo|cmo|cfo|chief|vp|vice president|head of|director|partner|owner)\b/i;

export const AUTHORITY_FOLLOWERS_MIN = 2_000;

/** Touches (comments + replies + likes from one person) that read as pursuit. */
export const REPEAT_ENGAGER_TOUCHES = 3;

export const INTENT_RANK: Record<LeadIntent, number> = {
  none: 0,
  positive_signal: 1,
  product_question: 2,
  explicit_ask: 3,
};

const TIER_RANK: Record<LeadTier, number> = { watch: 0, warm: 1, hot: 2 };

export function maxIntent(a: LeadIntent, b: LeadIntent): LeadIntent {
  return INTENT_RANK[a] >= INTENT_RANK[b] ? a : b;
}

export function maxTier(a: LeadTier, b: LeadTier): LeadTier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

export function hasAuthority(a: LeadAuthority): boolean {
  return (
    Boolean(a.isInfluencer) ||
    (a.followers ?? 0) >= AUTHORITY_FOLLOWERS_MIN ||
    AUTHORITY_HEADLINE_RE.test(a.headline ?? "")
  );
}

export function computeLeadTier(input: {
  intentLevel: LeadIntent;
  authority: LeadAuthority;
  touchCount: number;
}): { tier: LeadTier; reasons: string[] } {
  const reasons: string[] = [];
  const authority = hasAuthority(input.authority);
  if (authority) {
    reasons.push(
      input.authority.isInfluencer
        ? "authority: influencer"
        : AUTHORITY_HEADLINE_RE.test(input.authority.headline ?? "")
          ? `authority: ${input.authority.headline?.match(AUTHORITY_HEADLINE_RE)?.[0]?.toLowerCase()}`
          : `authority: ${input.authority.followers} followers`,
    );
  }

  let tier: LeadTier;
  switch (input.intentLevel) {
    case "explicit_ask":
      tier = "hot";
      reasons.unshift("explicit ask");
      break;
    case "product_question":
      tier = authority ? "hot" : "warm";
      reasons.unshift("asked about the product");
      break;
    case "positive_signal":
      tier = authority ? "warm" : "watch";
      reasons.unshift("showed interest");
      break;
    case "none":
      tier = "watch";
      break;
  }

  // Repeat engagement promotes one tier: someone circling back 3+ times is
  // pursuing, even without an explicit ask.
  if (input.touchCount >= REPEAT_ENGAGER_TOUCHES && tier !== "hot") {
    tier = tier === "warm" ? "hot" : "warm";
    reasons.push(`repeat engager: ${input.touchCount} touches`);
  }

  return { tier, reasons };
}
