import { and, desc, eq, gt, inArray } from "drizzle-orm";
import type { Campaign } from "@engager/database/schema";
import { messages } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { config } from "../config";
import { hashSeed } from "../learning/styleVariety";
import type { LengthTier } from "./writer";

/**
 * Per-post adaptive length selection — a deterministic seeded sampler, no LLM.
 *
 * Real people don't comment at one fixed length; a wall of uniformly-sized comments
 * is itself an AI tell. When `tone.length` is "auto" (or unset), each post gets a
 * tier from a weighted distribution shaped by the post (depth, question), the
 * expected return (BetScore), and what the recent org-wide window already used
 * (over-represented tiers are suppressed — same LRU philosophy as the style
 * directive rotation). The pick is seeded by the post id so job retries and
 * concurrent drains of the SAME post agree; variability comes across posts.
 */

export type LengthMode = "auto" | "pinned";

export type LengthDecision = {
  tier: LengthTier;
  mode: LengthMode;
  /** Human-readable why — persisted into `messages.trace.length.factors`. */
  factors: string[];
};

/** Window of recent drafts whose tiers the sampler rotates away from. */
export const LENGTH_ROTATION_WINDOW = 10;

const TIERS: LengthTier[] = ["ultra_short", "short", "medium", "long"];

/** Target share per tier — also the base sampling weights ("auto" mode). Exposed
 *  to the MCP client path as the batch `lengthPlan.targetDistribution`. */
export const LENGTH_TARGET_DISTRIBUTION: Record<LengthTier, number> = {
  ultra_short: 0.15,
  short: 0.45,
  medium: 0.3,
  long: 0.1,
};
const BASE_WEIGHTS = LENGTH_TARGET_DISTRIBUTION;

export function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Classify a comment's tier from its word count (mirror of writer.ts maxWords caps). */
export function tierByWordCount(n: number): LengthTier {
  if (n <= 15) return "ultra_short";
  if (n <= 35) return "short";
  if (n <= 55) return "medium";
  return "long";
}

const RECENT_STATUSES = ["posted", "approved", "proposed", "suppressed_dryrun"] as const;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Recent org-wide comment tiers, newest first. Reads the persisted trace when
 * present; legacy rows (trace null) fall back to classifying the text by word
 * count — same fallback pattern as the style rotation's `inferOpeningType`.
 * Best-effort: a read failure returns [] (pure signal-based sampling).
 */
export async function recentLengthTiers(db: Tx): Promise<LengthTier[]> {
  try {
    const rows = await db
      .select({
        trace: messages.trace,
        final: messages.finalText,
        proposed: messages.proposedText,
      })
      .from(messages)
      .where(
        and(
          eq(messages.kind, "comment"),
          inArray(messages.status, [...RECENT_STATUSES]),
          gt(messages.createdAt, Date.now() - SEVEN_DAYS_MS),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(LENGTH_ROTATION_WINDOW);
    return rows.map((r) => {
      const t = r.trace?.length?.tier;
      if (t && TIERS.includes(t)) return t;
      return tierByWordCount(countWords(r.final ?? r.proposed ?? ""));
    });
  } catch (e) {
    console.warn("[lengthSampler] recent-window read failed, sampling without rotation:", e);
    return [];
  }
}

/** Does the post ask something near its end (a direct answer reads most human)? */
function postAsksQuestion(text: string): boolean {
  const tail = text.trim().slice(-200);
  return tail.includes("?") || tail.includes("？") || tail.includes("؟");
}

/**
 * Decide the effective length tier for ONE comment. Pure and deterministic —
 * the same inputs always produce the same tier (idempotent job retries).
 *
 * Pinned campaigns (an explicit tier in `tone.length`) are honored verbatim,
 * with the existing promo floor (a promo comment engages the post AND names the
 * product, so it's never shorter than medium — mirrors `lengthSpec`).
 */
export function decideLengthTier(opts: {
  campaign: Campaign;
  /** Post text; null = campaign-level call (MCP context without a post). */
  postText: string | null;
  commentType: "promo" | "neutral";
  canMentionProduct: boolean;
  betScore?: number | null;
  /** Newest-first recent tiers (see `recentLengthTiers`). */
  recentTiers: LengthTier[];
  /** Stable per-post seed, e.g. String(post.id). */
  seed: string;
}): LengthDecision {
  const configured = opts.campaign.tone?.length;
  const isPromo = opts.commentType === "promo" && opts.canMentionProduct;
  const factors: string[] = [];

  // Pinned: an explicit tier never varies. Unset counts as auto (with the global
  // kill switch restoring the legacy always-short default exactly).
  if (configured && configured !== "auto") {
    const tier = isPromo && (configured === "short" || configured === "ultra_short")
      ? "medium"
      : configured;
    factors.push(`campaign pins length ${configured}`);
    if (tier !== configured) factors.push("promo floor raises to medium");
    return { tier, mode: "pinned", factors };
  }
  if (!config.autoLength) {
    const tier = isPromo ? "medium" : "short";
    return { tier, mode: "pinned", factors: ["auto length disabled (ENGAGER_AUTO_LENGTH=off)"] };
  }

  const weights: Record<LengthTier, number> = { ...BASE_WEIGHTS };

  // Post depth: thin posts earn punchy reactions, substantive ones longer takes.
  const postWords = opts.postText != null ? countWords(opts.postText) : null;
  if (postWords != null && postWords < 40) {
    weights.ultra_short *= 2;
    weights.short *= 1.3;
    weights.long *= 0.3;
    factors.push(`thin post (${postWords}w) shifts short`);
  } else if (postWords != null && postWords > 150) {
    weights.medium *= 1.4;
    weights.long *= 1.8;
    weights.ultra_short *= 0.5;
    factors.push(`substantive post (${postWords}w) shifts long`);
  }
  if (opts.postText && postAsksQuestion(opts.postText)) {
    weights.ultra_short *= 1.5;
    weights.short *= 1.5;
    factors.push("post asks a question — direct answer favored");
  }

  // Expected return: invest words where the ranker sees value.
  const bet = opts.betScore ?? null;
  if (bet != null && bet >= 0.75) {
    weights.medium *= 1.5;
    weights.long *= 1.5;
    factors.push(`high BetScore ${bet.toFixed(2)} favors depth`);
  } else if (bet != null && bet < 0.4) {
    weights.ultra_short *= 1.3;
    weights.short *= 1.3;
    factors.push(`low BetScore ${bet.toFixed(2)} favors brevity`);
  }

  // Promo floor: zero out the tiers a promo can't use (mirrors lengthSpec's bump).
  if (isPromo) {
    weights.ultra_short = 0;
    weights.short = 0;
    factors.push("promo comment needs room — medium/long only");
  }

  // Rotation (the variability core): suppress tiers over-represented in the recent
  // window relative to their target share — never zeroed, so a strong post-signal
  // can still repeat a tier.
  const window = opts.recentTiers.slice(0, LENGTH_ROTATION_WINDOW);
  if (window.length >= 3) {
    for (const tier of TIERS) {
      const share = window.filter((t) => t === tier).length / window.length;
      const target = BASE_WEIGHTS[tier];
      if (share > target) {
        const damp = Math.max(0.15, 1 - share / target / 2);
        weights[tier] *= damp;
        factors.push(`recent window ${Math.round(share * 100)}% ${tier} — suppressed`);
      }
    }
  }

  // Deterministic weighted pick: map the seed hash onto the cumulative distribution.
  const total = TIERS.reduce((s, t) => s + weights[t], 0);
  let tier: LengthTier = isPromo ? "medium" : "short";
  if (total > 0) {
    const point = (hashSeed(`${opts.seed}:length`) % 10_000) / 10_000 * total;
    let acc = 0;
    for (const t of TIERS) {
      acc += weights[t];
      if (point < acc) {
        tier = t;
        break;
      }
    }
  }
  return { tier, mode: "auto", factors };
}
