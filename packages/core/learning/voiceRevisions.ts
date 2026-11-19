import { asc, desc, eq } from "drizzle-orm";
import {
  voiceRevisions,
  voices,
  type StyleRules,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";

/**
 * Production and consumption of the append-only voice history
 * (`voice_revisions`).
 *
 * `voices` keeps only the CURRENT styleRules under a CAS counter; convergence
 * ("is the voice still changing?") needs the values over time. Each logical
 * calibration/relearn calls `snapshotVoiceRevision` as the LAST step of its
 * write transaction — after the final `voices` update — so the row lands on
 * the canonical revision, the same value stamped onto
 * `voice_samples.used_in_voice_revision`. Gate 1 of the 2026-07-28
 * mode-ladder spec reads this history through `calibrationConvergence`.
 */

export type VoiceRevisionSource =
  | "initial"
  | "client_calibration"
  | "hosted_fallback"
  | "relearn"
  | "manual";

export async function snapshotVoiceRevision(
  tx: Tx,
  input: {
    voiceId: number;
    source: VoiceRevisionSource;
    consumedSampleIds?: number[];
  },
): Promise<void> {
  const [voice] = await tx
    .select({
      id: voices.id,
      revision: voices.revision,
      styleRules: voices.styleRules,
      channels: voices.channels,
    })
    .from(voices)
    .where(eq(voices.id, input.voiceId));
  if (!voice) return;
  // Idempotent on the unique (org, voice, revision): a replayed apply after a
  // crash re-reads the same revision and the conflict is silently absorbed.
  await tx
    .insert(voiceRevisions)
    .values({
      voiceId: voice.id,
      revision: voice.revision,
      source: input.source,
      styleRules: voice.styleRules,
      channels: voice.channels,
      consumedSampleIds: input.consumedSampleIds ?? null,
      createdAt: Date.now(),
    })
    .onConflictDoNothing();
}

/** The fixed StyleRules field set the delta is measured over. */
const STYLE_RULE_FIELDS = [
  "emDashes",
  "semicolons",
  "emojiMax",
  "casing",
  "bannedOpeners",
  "closerQuestionPolicy",
  "shorthand",
  "roughEdges",
  "extras",
] as const;

function normalizedField(
  rules: StyleRules | null,
  field: (typeof STYLE_RULE_FIELDS)[number],
): string {
  const value = rules?.[field] ?? null;
  if (value == null) return "";
  if (field === "bannedOpeners") {
    return (value as string[])
      .map((opener) => opener.trim().toLowerCase())
      .sort()
      .join("\n");
  }
  if (field === "extras") {
    // Line SET: reordering or re-wrapping the same rules is not a change.
    return (value as string)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .sort()
      .join("\n");
  }
  return String(value).trim();
}

/**
 * Deterministic, cheap comparison scalar in [0,1]: the share of the fixed
 * StyleRules fields whose normalized value changed. No LLM involved.
 */
export function styleRulesDelta(
  prev: StyleRules | null,
  next: StyleRules | null,
): number {
  let changed = 0;
  for (const field of STYLE_RULE_FIELDS) {
    if (normalizedField(prev, field) !== normalizedField(next, field)) {
      changed += 1;
    }
  }
  return changed / STYLE_RULE_FIELDS.length;
}

export type CalibrationConvergence = {
  /** Completed recalibration cycles (client or hosted fallback). */
  cycles: number;
  latestDelta: number | null;
  previousDelta: number | null;
  /**
   * Two cycles with a non-growing latest delta. A 0→0 plateau passes: a voice
   * that stopped changing is converged, not unmeasured. Cold start — fewer
   * than two computable deltas — reads false, never null: absent evidence of
   * convergence the gate stays closed.
   */
  convergenceMet: boolean;
};

export async function calibrationConvergence(
  tx: Tx,
  voiceId: number,
): Promise<CalibrationConvergence> {
  const rows = await tx
    .select({
      source: voiceRevisions.source,
      styleRules: voiceRevisions.styleRules,
    })
    .from(voiceRevisions)
    .where(eq(voiceRevisions.voiceId, voiceId))
    .orderBy(asc(voiceRevisions.revision));
  const cycles = rows.filter(
    (row) =>
      row.source === "client_calibration" || row.source === "hosted_fallback",
  ).length;
  const deltas: number[] = [];
  for (let i = 1; i < rows.length; i += 1) {
    deltas.push(
      styleRulesDelta(rows[i - 1]?.styleRules ?? null, rows[i]?.styleRules ?? null),
    );
  }
  const latestDelta = deltas.length >= 1 ? deltas[deltas.length - 1]! : null;
  const previousDelta = deltas.length >= 2 ? deltas[deltas.length - 2]! : null;
  const convergenceMet =
    cycles >= 2 &&
    latestDelta != null &&
    previousDelta != null &&
    latestDelta <= previousDelta;
  return { cycles, latestDelta, previousDelta, convergenceMet };
}

/**
 * The GATE-cycle counter of the three-mode spec (revision 2) — deliberately
 * distinct from `calibrationConvergence.cycles`, which counts recalibrations
 * for the convergence telemetry and treats the `initial` snapshot as a
 * baseline. Gate cycles are counted on the org's DEFAULT voice only:
 *
 * - each recalibration (`client_calibration` or `hosted_fallback` — hosted
 *   counts deliberately: the gate measures calibration maturity, not which
 *   runtime produced it) is one cycle;
 * - `relearn` and `manual` writes never count, and non-default voices never
 *   count.
 *
 * Review gate: >= 1. Auto gate: >= 2. Gates never close; cycles only
 * accumulate.
 */
export async function gateCycles(tx: Tx): Promise<number> {
  const [voice] = await tx
    .select({ id: voices.id })
    .from(voices)
    .where(eq(voices.isDefault, true))
    .limit(1);
  if (!voice) return 0;
  const rows = await tx
    .select({ source: voiceRevisions.source })
    .from(voiceRevisions)
    .where(eq(voiceRevisions.voiceId, voice.id));
  const recalibrations = rows.filter(
    (row) =>
      row.source === "client_calibration" || row.source === "hosted_fallback",
  ).length;
  return recalibrations;
}
