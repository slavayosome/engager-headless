import type {
  AuthorTargeting,
  Campaign,
  DiscoveredPost,
} from "@engager/database/schema";
import type { FilterResult } from "./filter";

const DAY = 86_400_000;
const WEEK = 7 * DAY;

/**
 * BetScore — a 0..1 ranking signal for HOW worth-commenting a discovered post is,
 * beyond the binary filter pass/fail. It answers Scout's question — is this the
 * owner's audience — under ONE preset, whatever the campaign's commenting goal
 * says about how to write once it is. The two were the same setting until this
 * release, so a campaign that wanted a different kind of comment also got a
 * different pool.
 *
 * Signals (each 0..1, or null when absent): topic confidence, semantic similarity
 * to the campaign's ideal post, surface (the post's own engagement), recency, ICP
 * fit (author headline ↔ product audience), warmReply (replies our prior comments
 * earned — empty until the outcomes scoreboard lands), and freshContact (how
 * recently we engaged this author).
 *
 * It degrades gracefully: a missing signal is dropped and the blend reweights over
 * the rest, then a COVERAGE DISCOUNT scales the result by the fraction of the
 * preset's expected weight that was actually present — so a sparse-evidence post
 * (one lucky-high signal) cannot outrank a fully-evidenced one.
 *
 * NOTE on the deterministic-proxy reality: there is no reward signal yet
 * (capabilities.outcomes=false), so these weights are an unvalidated heuristic
 * shipped behind a kill switch, honest until the scoreboard exists. `warmReply`
 * has a reserved slot that auto-activates once outcomes are wired.
 */

// ---------------------------------------------------------------- signal helpers

/** Best-effort provider comment count; missing evidence stays unknown. */
export function commentCountOf(metrics: unknown): number | null {
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return null;
  const record = metrics as Record<string, unknown>;
  for (const key of ["comments", "numComments", "comment_count", "commentCount"]) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  }
  return null;
}

/** Pull a best-effort engagement total out of the driver's free-form metrics blob. */
export function engagementScore(metrics: unknown): number | null {
  if (!metrics || typeof metrics !== "object") return null;
  const m = metrics as Record<string, unknown>;
  const num = (...keys: string[]): number => {
    for (const k of keys) {
      const v = m[k];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    return 0;
  };
  const reactions = num(
    "reactions",
    "likes",
    "numLikes",
    "like_count",
    "reaction_count",
    "total_reactions",
    "totalReactions",
  );
  const comments = commentCountOf(metrics) ?? 0;
  const reposts = num("reposts", "shares", "repostCount", "share_count", "numShares");
  const total = reactions + 2 * comments + 1.5 * reposts;
  if (total <= 0) return 0;
  // log-normalise: ~0 at no engagement, ~1 around 300 weighted interactions.
  return Math.min(1, Math.log10(1 + total) / Math.log10(1 + 300));
}

export function recencyScore(
  postedAt: number | null | undefined,
  maxAgeDays: number,
  now: number,
): number | null {
  if (!postedAt) return null;
  const ageDays = (now - postedAt) / DAY;
  const horizon = maxAgeDays > 0 ? maxAgeDays : 7;
  return Math.max(0, Math.min(1, 1 - ageDays / horizon));
}

/**
 * Map the count of recent engagements with this author into a 0..1 "freshness"
 * factor: 1 = brand-new contact (never engaged this week), → 0 as the count rises.
 * Scout's preset rewards it: an author this account has not engaged lately is a
 * better find than one it keeps returning to. `canEngage`'s per-profile caps
 * remain the hard anti-spam ceiling.
 */
function freshContactScore(recentEngagements: number | null | undefined): number | null {
  if (recentEngagements == null) return null;
  // 0 prior → 1.0; 1 → ~0.5; 2 → ~0.33; saturating toward 0.
  return 1 / (1 + Math.max(0, recentEngagements));
}

// ---------------------------------------------------------------- presets

/** The signals BetScore blends. */
export type BetSignal =
  | "topic"
  | "sim"
  | "surface"
  | "recency"
  | "icp"
  | "warmReply"
  | "freshContact"
  | "authorReach";

/**
 * Scout's relevance weights. A POSITIVE weight rewards a high signal; a NEGATIVE
 * weight penalizes it (a low `freshContact` is an author this account already
 * engaged). `warmReply` carries a small reserved weight that does nothing until
 * outcomes are wired (the signal is null today, so coverage drops it).
 */
export type BetWeights = Record<BetSignal, number>;

/**
 * The ONE preset every campaign is ranked under.
 *
 * Only signals a discovered post actually carries have weight, and topic fit
 * leads: whether the post is the owner's audience is a question about the post,
 * not about the comment they might leave on it. `sim` and `icp` are 0 because
 * they need an ideal-post embedding and a product audience most targets do not
 * have — a weight on an absent signal only spends coverage.
 */
export const SCOUT_RELEVANCE_WEIGHTS: BetWeights = {
  topic: 0.6,
  sim: 0,
  surface: 0.15,
  recency: 0.15,
  icp: 0,
  warmReply: 0,
  freshContact: 0.1,
  authorReach: 0,
};

/**
 * The authorReach weight, applied ONLY when the campaign opts into author-impact
 * targeting (`discovery.author_targeting != "any"`). The preset above carries
 * `authorReach: 0`, so a non-opted campaign's coverage and scores stay
 * byte-identical — an unconditional weight would silently discount every
 * unenriched post org-wide.
 */
const SCOUT_AUTHOR_REACH_WEIGHT = 0.1;

/** 0..1 author impact: log-normalised max(followers, connections), ~1 at 50k.
 *  Null when nothing is known (unenriched author) — ranking degrades gracefully. */
export function authorImpactScore(
  a: { followers?: number | null; connections?: number | null } | null | undefined,
): number | null {
  if (!a) return null;
  const best = Math.max(a.followers ?? -1, a.connections ?? -1);
  if (best < 0) return null;
  return Math.min(1, Math.log10(1 + best) / Math.log10(1 + 50_000));
}

export function scoutRelevanceWeights(opts?: { authorImpact?: boolean }): BetWeights {
  if (!opts?.authorImpact) return SCOUT_RELEVANCE_WEIGHTS;
  return { ...SCOUT_RELEVANCE_WEIGHTS, authorReach: SCOUT_AUTHOR_REACH_WEIGHT };
}

/**
 * Gate-1 admission floor: a post must score AT LEAST this to be drafted (below
 * it → `held`, re-admitted later if still fresh + budget frees up).
 * Intentionally conservative — the floor's job is to stop the writer call +
 * review-queue flood on clearly-weak posts, not to be a precise threshold (the
 * budget overprovision is the main lever).
 */
export const SCOUT_BET_FLOOR = 0.2;

// ---------------------------------------------------------------- the engine

/** Which preset ranked a post. One value today — recorded rather than implied
 *  so a stored breakdown says what produced it, and so a row scored under a
 *  later preset is legible beside one scored under this. Deliberately NOT a
 *  commenting-goal id: the goal shapes the comment, never the pool. */
export type BetPreset = "scout_relevance";

/** What `computeBetScore` records on the post for observability + Gate 1/2. */
export type BetBreakdown = {
  preset: BetPreset;
  /** The raw 0..1 signal values that were present (absent ones omitted). */
  signals: Partial<Record<BetSignal, number>>;
  /** The weights applied. */
  weights: BetWeights;
  /** Fraction of the preset's expected |weight| that was actually present. */
  coverage: number;
  /** The reweighted blend BEFORE the coverage discount (0..1). */
  blend: number;
  /** Final score = blend × coverage (0..1). */
  score: number;
};

export type ComputeBetScoreOpts = {
  post: Pick<DiscoveredPost, "contentText" | "metrics" | "postedAt"> & {
    authorHeadline?: string | null;
  };
  campaign: Campaign;
  /** The relevance-filter result, if computed (its score is the topic signal). */
  filter?: FilterResult;
  /** Text describing the product's target audience (for the ICP signal). */
  audienceText?: string | null;
  /** reply_received count this post's author earned us (WALK-gated, ~0 today). */
  warmReplyCount?: number | null;
  /** Times THIS ACCOUNT engaged this author in the trailing window — the
   *  ledger's `countSince(tx, scope, actions, sinceTs, { profileId })` under the
   *  campaign's channel scope, across every campaign feeding that account. */
  recentAuthorEngagements?: number | null;
  /** 0..1 author-impact signal (authorImpactScore over the enrichment snapshot);
   *  null/undefined = unenriched. Only blended when `authorTargeting` opts in. */
  authorImpact?: number | null;
  /** The campaign's discovery.author_targeting — "any"/undefined leaves the
   *  preset untouched (byte-identical scores). */
  authorTargeting?: AuthorTargeting;
  now?: number;
};

/**
 * Compute Scout relevance + a full breakdown for one post.
 *
 * A signal with a NEGATIVE preset weight is applied as `weight × (1 - value)` so a
 * higher raw value lowers the score (and `|weight|` still counts toward coverage).
 * Coverage = Σ present |weight| / Σ all |weight|, and `score = blend × coverage`.
 */
export async function computeBetScore(opts: ComputeBetScoreOpts): Promise<BetBreakdown> {
  const now = opts.now ?? Date.now();
  const authorImpactOn =
    opts.authorTargeting != null && opts.authorTargeting !== "any";
  const weights = scoutRelevanceWeights({ authorImpact: authorImpactOn });

  // --- gather raw signals (null = absent → dropped + reweighted) ---
  const topic = opts.filter ? opts.filter.score : null;
  const surface = engagementScore(opts.post.metrics);
  const recency = recencyScore(opts.post.postedAt, opts.campaign.maxPostAgeDays, now);
  const freshContact = freshContactScore(opts.recentAuthorEngagements);

  // warmReply: replies our prior comments earned, log-normalised. Empty today.
  let warmReply: number | null = null;
  if (opts.warmReplyCount != null) {
    warmReply = Math.min(1, Math.log10(1 + Math.max(0, opts.warmReplyCount)) / Math.log10(1 + 20));
  }

  const raw: Partial<Record<BetSignal, number>> = {};
  if (topic !== null) raw.topic = topic;
  if (surface !== null) raw.surface = surface;
  if (recency !== null) raw.recency = recency;
  if (warmReply !== null) raw.warmReply = warmReply;
  if (freshContact !== null) raw.freshContact = freshContact;
  if (authorImpactOn && opts.authorImpact != null) raw.authorReach = opts.authorImpact;

  // --- weighted blend over PRESENT signals + coverage discount ---
  let presentAbs = 0;
  let weightedSum = 0;
  for (const sig of Object.keys(weights) as BetSignal[]) {
    const w = weights[sig];
    if (w === 0) continue; // a zero-weight signal neither blends nor counts to coverage
    const v = raw[sig];
    if (v === undefined) continue; // absent → reweighted away
    const absW = Math.abs(w);
    presentAbs += absW;
    // Negative weight: a higher value should LOWER the score. Apply to (1 - v) with
    // the absolute weight so the contribution stays in [0, absW].
    weightedSum += w >= 0 ? w * v : absW * (1 - v);
  }

  // Σ of all NON-ZERO |weight| in the preset — the denominator of coverage.
  let totalAbs = 0;
  for (const sig of Object.keys(weights) as BetSignal[]) {
    const w = weights[sig];
    if (w !== 0) totalAbs += Math.abs(w);
  }

  const blend = presentAbs > 0 ? clamp01(weightedSum / presentAbs) : 0;
  const coverage = totalAbs > 0 ? clamp01(presentAbs / totalAbs) : 0;
  const score = clamp01(blend * coverage);

  return { preset: "scout_relevance", signals: raw, weights, coverage, blend, score };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// ---------------------------------------------------------------- reach pre-score

/**
 * The pre-score the capacity planner ranks the gather buffer by ("is this post
 * worth a Sonnet call at all?"). It reads only what a gathered post carries,
 * before the relevance filter has judged it — `computeBetScore` is the fuller
 * answer, and still drives Gate-2 posting ORDER once a post is selected +
 * drafted. Reach blends the post's own engagement
 * SURFACE (log-saturated so a mega-thread can't dwarf a solid one) with RECENCY, each
 * 0..1, reweighted over the present signals so a post with unknown engagement or an
 * undated post still scores (degrades gracefully, like betScore's coverage blend).
 */
export const REACH_WEIGHTS = { surface: 0.75, recency: 0.25 } as const;

/** Reach weights for campaigns that opted into author-impact targeting — the
 *  author's audience size joins the selection signal. */
export const REACH_WEIGHTS_AUTHOR = { surface: 0.55, recency: 0.2, authorReach: 0.25 } as const;

export type ReachBreakdown = {
  /** The raw 0..1 signals that were present (absent ones omitted). */
  signals: { surface?: number; recency?: number; authorReach?: number };
  /** The applied reach weights (recorded for observability/back-compat reads). */
  weights: Record<string, number>;
  /** Final 0..1 reach score = Σ present w·v / Σ present w (0 when nothing present). */
  score: number;
};

export type ComputeReachScoreOpts = {
  // Structural (not Pick<DiscoveredPost>) so a fresh DriverPost (postedAt?: number)
  // and a persisted row (postedAt: number | null) both fit.
  post: { metrics: unknown; postedAt?: number | null };
  /** The campaign's max post age (days) — the recency horizon. */
  maxPostAgeDays: number;
  /** Author impact snapshot (followers/connections); only blended when
   *  `authorTargeting` opts in. Unenriched → reweighted away as usual. */
  author?: { followers?: number | null; connections?: number | null } | null;
  authorTargeting?: AuthorTargeting;
  now?: number;
};

/** Pure reach pre-score for one post (no embeddings, no DB, no LLM). */
export function computeReachScore(opts: ComputeReachScoreOpts): ReachBreakdown {
  const now = opts.now ?? Date.now();
  const surface = engagementScore(opts.post.metrics);
  const recency = recencyScore(opts.post.postedAt, opts.maxPostAgeDays, now);
  const authorImpactOn = opts.authorTargeting != null && opts.authorTargeting !== "any";
  const authorReach = authorImpactOn ? authorImpactScore(opts.author) : null;
  const weights: Record<string, number> = authorImpactOn
    ? { ...REACH_WEIGHTS_AUTHOR }
    : { ...REACH_WEIGHTS };

  const signals: { surface?: number; recency?: number; authorReach?: number } = {};
  let present = 0;
  let weightedSum = 0;
  if (surface !== null) {
    signals.surface = surface;
    present += weights.surface!;
    weightedSum += weights.surface! * surface;
  }
  if (recency !== null) {
    signals.recency = recency;
    present += weights.recency!;
    weightedSum += weights.recency! * recency;
  }
  if (authorReach !== null && weights.authorReach != null) {
    signals.authorReach = authorReach;
    present += weights.authorReach;
    weightedSum += weights.authorReach * authorReach;
  }

  const score = present > 0 ? clamp01(weightedSum / present) : 0;
  return { signals, weights, score };
}

/**
 * Curated-pool POP ORDER among relevance-MATCHED candidates: blend the (live) reach
 * pre-score with the agent's 0..1 relevance/match score so drafting prefers posts that
 * are BOTH likely to be seen and a strong fit — the founder-chosen "reach × relevance".
 * Simple product: a weak signal on either axis pulls the blend down (all inputs already
 * survived the relevance gate, so agentScore is bounded near/above the confidence floor).
 * `reachWeight`/`relWeight` are exponents (default 1/1 = plain product); nudge toward
 * reach or relevance without a schema change. A null agentScore (untriaged) falls back to
 * reach alone so the helper is safe to call on any row.
 */
export function blendScore(
  liveReach: number | null | undefined,
  agentScore: number | null | undefined,
  weights: { reachWeight?: number; relWeight?: number } = {},
): number {
  const r = clamp01(typeof liveReach === "number" ? liveReach : 0);
  const rel = typeof agentScore === "number" ? clamp01(agentScore) : null;
  if (rel === null) return r;
  const rw = weights.reachWeight ?? 1;
  const aw = weights.relWeight ?? 1;
  return clamp01(Math.pow(r, rw) * Math.pow(rel, aw));
}

/**
 * LEGACY "meaningfulness" score — the PRE-BetScore engine, preserved verbatim so
 * that with the lead-ranker kill switch OFF the pipeline is byte-identical to before
 * this feature (same `meaningfulness` value + `min_meaningfulness` floor behavior).
 * When the ranker is ON, callers use `computeBetScore` instead and `meaningfulness`
 * is kept in sync with `betScore`. Blends topic + engagement + recency + sim and
 * degrades gracefully (reweights over the present signals) exactly like before.
 */
export async function scoreMeaningfulness(opts: {
  post: Pick<DiscoveredPost, "contentText" | "metrics" | "postedAt">;
  campaign: Campaign;
  filter?: FilterResult;
  now?: number;
}): Promise<number> {
  const now = opts.now ?? Date.now();
  const topic = opts.filter ? opts.filter.score : 0.5; // 0..1 (confidence/3)
  const engagement = engagementScore(opts.post.metrics);
  const recency = recencyScore(opts.post.postedAt, opts.campaign.maxPostAgeDays, now);

  const parts: Array<[value: number, weight: number]> = [[topic, 0.45]];
  if (engagement !== null) parts.push([engagement, 0.2]);
  if (recency !== null) parts.push([recency, 0.1]);

  const wsum = parts.reduce((s, [, w]) => s + w, 0) || 1;
  const score = parts.reduce((s, [v, w]) => s + v * w, 0) / wsum;
  return Math.max(0, Math.min(1, score));
}
