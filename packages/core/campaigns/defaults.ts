import type { CampaignObjective } from "@engager/database/schema";

/** Operational bounds for the self-serve launch surface. Internal callers can
 *  still round-trip legacy values, but public inputs must remain meaningful to
 *  the LinkedIn driver and the scheduling arithmetic. */
export const PUBLIC_CAMPAIGN_NUMERIC_LIMITS = {
  maxPostAgeDays: { min: 1, max: 31 },
  dailyCommentCap: { min: 1, max: 100 },
  dailyReplyCap: { min: 1, max: 100 },
  perProfileDayCap: { min: 1, max: 10 },
  perProfileWeekCap: { min: 1, max: 50 },
  perProfileMonthCap: { min: 1, max: 100 },
  delaySec: { min: 0, max: 3_600 },
  warmupWeeks: { min: 1, max: 12 },
  warmupStartRate: { min: 1, max: 100 },
  discoveryLimit: { min: 1, max: 100 },
  minAuthorFollowers: { min: 1, max: 1_000_000_000 },
} as const;

/**
 * Defaults shared by every supported campaign-creation surface.
 *
 * Keep these values free of transport/UI concerns. No pacing lives here: caps,
 * delays, the active window and the warm-up clock are the ACCOUNT's, and their
 * defaults are the `channels` column defaults.
 */
export const CAMPAIGN_CREATE_DEFAULTS = {
  objective: "engage" as CampaignObjective,
  // Paying-tenant launch default: unattended hosted web egress must be an
  // explicit opt-in. Agent-led users can enable research per campaign using
  // their own provider allowance.
  webFacts: false,
  webFactsRatio: 0.3,
  discoveryLimit: 25,
  // Fast first value with no extra per-author profile lookups. Users can opt in
  // to reach-aware enrichment after the core relevance loop is working.
  discoveryAuthorTargeting: "any" as const,
  filterMinConfidence: 1,
  likeWhenCommenting: true,
  premiumWriter: false,
  maxPostAgeDays: 3,
  diversityRejectThreshold: 0.92,
  diversityStructuralThreshold: 0.45,
  promoIncludeLink: false,
} as const;
