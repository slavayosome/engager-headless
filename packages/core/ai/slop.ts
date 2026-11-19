import { authoredTextCharacterViolation } from "./authoredText";
import { resolveWritingInstructions, renderWritingInstructions, writingCompliancePrompt } from "./writingInstructions";
import { renderStyleRules } from "./styleRules";
import type { Campaign, ResolvedStyleRules } from "@engager/database/schema";
import { hashSeed } from "../learning/styleVariety";
import type { LengthTier } from "./writer";
import { DEFAULT_STYLE_RULES } from "./styleRules";
import { voiceTraitTells } from "./voiceTraits";

/** Default strictness ≈ the old fixed "Be strict." calibration. */
export const DEFAULT_SLOP_STRICTNESS = 0.55;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * Map strictness (0..1, 1 = strictest) onto the reject threshold over the 0..1
 * slop score: strictness 0 rejects only near-certain slop (score ≥ 0.9);
 * strictness 1 rejects anything moderately sloppy (score ≥ 0.4).
 */
export function rejectThreshold(strictness: number): number {
  const s = clamp01(strictness);
  return 0.9 - 0.5 * s;
}

export type StrictnessDecision = {
  strictness: number;
  mode: "auto" | "pinned";
  factors: string[];
};

/**
 * Resolve the slop strictness for ONE draft. A pinned campaign number is used
 * verbatim. Auto varies per post — a fixed gate line is itself a goal the
 * writer's output converges against, so deliberate jitter keeps the accepted
 * texture varied. Deterministic per seed (job retries agree).
 */
export function decideSlopStrictness(opts: {
  campaign: Campaign;
  commentType: "promo" | "neutral";
  canMentionProduct: boolean;
  betScore?: number | null;
  lengthTier: LengthTier;
  seed: string;
}): StrictnessDecision {
  const configured = opts.campaign.tone?.slop_strictness;
  if (typeof configured === "number" && Number.isFinite(configured)) {
    return {
      strictness: clamp01(configured),
      mode: "pinned",
      factors: [`campaign pins strictness ${clamp01(configured).toFixed(2)}`],
    };
  }

  const factors: string[] = ["auto base 0.55"];
  let s = DEFAULT_SLOP_STRICTNESS;
  if (opts.commentType === "promo" && opts.canMentionProduct) {
    s += 0.15;
    factors.push("promo +0.15 (the brand's face)");
  }
  const bet = opts.betScore ?? null;
  if (bet != null && bet >= 0.75) {
    s += 0.1;
    factors.push(`high BetScore ${bet.toFixed(2)} +0.10`);
  }
  if (opts.lengthTier === "ultra_short") {
    s -= 0.1;
    factors.push("ultra_short −0.10 (terse fragments score generic unfairly)");
  }
  // Deterministic jitter ±0.08 — the per-post variability requirement.
  const jitter = ((hashSeed(`${opts.seed}:slop`) % 1000) / 1000 - 0.5) * 0.16;
  s += jitter;
  factors.push(`jitter ${jitter >= 0 ? "+" : ""}${jitter.toFixed(2)}`);
  const strictness = Math.min(0.9, Math.max(0.2, Math.round(s * 100) / 100));
  return { strictness, mode: "auto", factors };
}

/** The slop-editor rubric (per promo mode), rendered from the voice's resolved
 *  register rules so the judge can never flag what the voice permits. Exported so
 *  the client-drafting path ships the exact same criteria the server gate applies
 *  (get_drafting_context.slop.rubric). */
export function slopSystemPrompt(
  promo: boolean,
  rules: ResolvedStyleRules = DEFAULT_STYLE_RULES,
): string {
  return writingCompliancePrompt(renderWritingInstructions(resolveWritingInstructions({
    surface: "comment",
    voice: renderStyleRules(rules, "comment") + "\nInherited register observations (overridable):\n" + voiceTraitTells(rules.traits).join("\n"),
    campaignGuidance: promo ? "A product mention is intended where it fits the supplied facts." : undefined,
  })));
}

/** URL detection retained for diagnostics; a URL is not itself a refusal. */
export function containsRawUrl(text: string): boolean {
  return /https?:\/\/|www\.|[a-z0-9-]+\.(com|io|ai|dev|co|app)\b/i.test(text);
}

/** Deterministic hard checks (belt to the model's judgment): mechanical violations
 *  that are never acceptable regardless of strictness. */
export function mechanicalViolations(comment: string): string[] {
  const violation = authoredTextCharacterViolation(comment);
  return violation ? [violation] : [];
}
