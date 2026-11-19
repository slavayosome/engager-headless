import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { messages, type Message } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { config } from "../config";
import { maxStructuralSimilarity } from "./styleVariety";

export type DiversityResult = {
  tooSimilar: boolean;
  /** SEMANTIC near-duplicate — always false now: the embedding-similarity arm
   *  is gone (INV-14); nothing skips on meaning anymore. */
  semanticTooSimilar: boolean;
  /** STRUCTURAL template collision (>= structuralThreshold). Reported for the metric +
   *  the future ranker, but no longer a skip trigger on its own. */
  structuralTooSimilar: boolean;
  /** Max SEMANTIC cosine to the recent window — always 0 (no embedder exists). */
  maxSim: number;
  /** Max STRUCTURAL similarity (openingSignature collision OR trigram cosine) to the
   *  recent window — the anti-monoculture novelty signal, captured regardless of
   *  whether the draft survives or is skipped. */
  structuralSim: number;
  /** Always false now: the SEMANTIC path no longer exists. The structural path
   *  is embedder-free, so `tooSimilar`/`structuralSim` are still meaningful. */
  checked: boolean;
};

/** Status values that feed the diversity window. Widened from posted-only so
 *  shadow drafts (suppressed_dryrun) + pending drafts (approved/proposed) feed the
 *  gate + metric — shadow is the safety default + how this is tested (amendment #2). */
const WINDOW_STATUSES: Message["status"][] = [
  "posted",
  "approved",
  "proposed",
  "suppressed_dryrun",
];

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Immutable DB-side input for the diversity calculation. */
export type DiversitySnapshot = readonly string[];

/** DB-only half of the diversity check. */
export async function prepareDiversitySnapshot(
  tx: Tx,
  kind: "comment" | "reply",
  lookback = 30,
): Promise<DiversitySnapshot> {
  const recent = await tx
    .select({ final: messages.finalText, proposed: messages.proposedText })
    .from(messages)
    .where(
      and(
        eq(messages.kind, kind),
        inArray(messages.status, WINDOW_STATUSES),
        gt(messages.createdAt, Date.now() - SEVEN_DAYS_MS),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(lookback);
  return recent
    .map((r) => r.final ?? r.proposed)
    .filter((text): text is string => Boolean(text));
}

/** Provider-free half over detached recent-message text. The embedding-similarity
 *  arm is gone (INV-14): `maxSim` is always 0 and `checked` false, exactly what a
 *  keyless install already produced. The structural arm is the whole check. */
export async function checkDiversityFromSnapshot(opts: {
  recentTexts: DiversitySnapshot;
  candidate: string;
  threshold: number;
  structuralThreshold: number;
}): Promise<DiversityResult> {
  const texts = [...opts.recentTexts];
  const structuralSim = config.structuralDiversity
    ? maxStructuralSimilarity(opts.candidate, texts)
    : 0;
  const structuralTooSimilar =
    config.structuralDiversity && structuralSim >= opts.structuralThreshold;

  return {
    tooSimilar: structuralTooSimilar,
    semanticTooSimilar: false,
    structuralTooSimilar,
    maxSim: 0,
    structuralSim,
    checked: false,
  };
}

/**
 * Reject a draft that is too similar to recent org-wide messages — the
 * anti-monoculture guard. One signal now: STRUCTURAL (embedder-free) —
 * openingSignature collision OR trigram cosine — catching the syntactic
 * template monoculture. The SEMANTIC (embedder cosine) arm is gone (INV-14):
 * a focused campaign repeating its MEANING is natural, so only STYLE varies.
 * `tooSimilar = structural only`, gated by `config.structuralDiversity` for a
 * fast org-wide off-switch.
 *
 * Scope is ORG-WIDE (no campaignId filter; RLS scopes to the org) to match the
 * cross-campaign fingerprint + profile-wide voice. Ordered by `createdAt desc`
 * (non-posted rows have null postedAt) and time-bounded to 7d so the read stays
 * bounded as `messages` grows.
 */
export async function checkDiversity(opts: {
  kind: "comment" | "reply";
  candidate: string;
  /** SEMANTIC threshold (campaign.diversityRejectThreshold) — kept for API
   *  stability; the semantic arm no longer runs, so it is unread. */
  threshold: number;
  /** STRUCTURAL threshold (campaign.diversityStructuralThreshold, default 0.45). */
  structuralThreshold: number;
  lookback?: number;
  db: Tx;
}): Promise<DiversityResult> {
  const recentTexts = await prepareDiversitySnapshot(
    opts.db,
    opts.kind,
    opts.lookback,
  );
  return checkDiversityFromSnapshot({
    recentTexts,
    candidate: opts.candidate,
    threshold: opts.threshold,
    structuralThreshold: opts.structuralThreshold,
  });
}
