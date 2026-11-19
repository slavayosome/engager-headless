import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  angleProfileRevisions,
  voiceSamples,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import {
  RECALIBRATION_CLIENT_COOLDOWN_MS,
  RECALIBRATION_MIN_NEW_SAMPLES,
} from "./recalibrate";

/**
 * Angle learning (2026-07-28 mode-ladder spec): the judgment-side learnable.
 * Voice (StyleRules) captures HOW the owner writes; the angle profile captures
 * WHAT they choose to say — which entry point they take into a conversation.
 * The owner's agent classifies saved comments lazily inside the recalibration
 * loop (same due signal and cadence, own watermark), the server aggregates
 * the soft labels into an org-level revealed-preference distribution, and the
 * drafting context suggests from it under a variety floor.
 *
 * Divergence from offered angles is PREFERENCE SIGNAL, never an error metric:
 * nothing here is a goal an agent could minimize. The only place agreement
 * is a goal is the (report-only) Auto gate, where it genuinely is the
 * question.
 */

export type AngleMove = {
  id: string;
  label: string;
  description: string;
};

/** Fixed, deliberately small taxonomy — a large one turns into classification
 *  noise. Real comments blend moves; labels are soft multi-labels. */
export const ANGLE_TAXONOMY: readonly AngleMove[] = [
  {
    id: "war_story",
    label: "Personal war story",
    description:
      "A first-hand experience or concrete anecdote from the owner's own work.",
  },
  {
    id: "pointed_question",
    label: "Pointed question",
    description:
      "A specific question that opens the thread the owner wants to pull.",
  },
  {
    id: "contrarian_take",
    label: "Respectful contrarian take",
    description:
      "Disagrees with the post's premise or conclusion and says why.",
  },
  {
    id: "tactical_addition",
    label: "Tactical addition",
    description:
      "A concrete how-to detail, step, or tool the post left out.",
  },
  {
    id: "agree_and_extend",
    label: "Agree and extend",
    description:
      "Affirms the post's point and carries it one concrete step further.",
  },
  {
    id: "data_point",
    label: "Data point",
    description:
      "A number, measurement, or observed result that grounds the discussion.",
  },
  {
    id: "reframe",
    label: "Reframe",
    description:
      "Recasts the post's question into the frame the owner thinks actually matters.",
  },
] as const;

const MOVE_IDS = new Set(ANGLE_TAXONOMY.map((move) => move.id));

/** Same cadence as voice recalibration — one loop, two learnables. */
export const ANGLE_CLASSIFICATION_MIN_NEW = RECALIBRATION_MIN_NEW_SAMPLES;
export const ANGLE_CLASSIFICATION_COOLDOWN_MS =
  RECALIBRATION_CLIENT_COOLDOWN_MS;

/** The variety floor, same discipline as styleVariety's MIN_DEFAULT_SHARE: a
 *  60% war-story owner gets war stories ~60% of the time, never always, and
 *  a narrow learned profile can't collapse suggestions to a monoculture. */
export const MIN_ANGLE_DEFAULT_SHARE = 0.4;

/**
 * Drop unknown move ids and clamp weights into [0,1] — bad data never fails
 * the write (the sanitizeTriageAngle posture).
 */
export function sanitizeAngleLabels(
  labels: ReadonlyArray<{ move: string; weight: number }>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const label of labels) {
    if (!MOVE_IDS.has(label.move)) continue;
    if (!Number.isFinite(label.weight)) continue;
    out[label.move] = Math.min(1, Math.max(0, label.weight));
  }
  return out;
}

/**
 * Aggregate per-sample soft labels into the org distribution. Each sample's
 * labels are normalized to sum 1 first, so one enthusiastic multi-label
 * sample cannot outvote a decisive single-label one; the result is
 * renormalized over the taxonomy.
 */
export function aggregateAngleWeights(
  perSample: ReadonlyArray<Record<string, number>>,
): Record<string, number> {
  const sums: Record<string, number> = {};
  let counted = 0;
  for (const labels of perSample) {
    const entries = Object.entries(labels).filter(
      ([move, weight]) => MOVE_IDS.has(move) && weight > 0,
    );
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    if (total <= 0) continue;
    counted += 1;
    for (const [move, weight] of entries) {
      sums[move] = (sums[move] ?? 0) + weight / total;
    }
  }
  if (counted === 0) return {};
  const out: Record<string, number> = {};
  for (const [move, sum] of Object.entries(sums)) {
    out[move] = sum / counted;
  }
  return out;
}

export type BlendedAngle = AngleMove & { weight: number };

/**
 * Blend the learned distribution with a uniform default floor over the full
 * taxonomy (blendAxis discipline from styleVariety): every move stays
 * available, learned moves weigh in proportion to revealed preference, and
 * the defaults hold at least MIN_ANGLE_DEFAULT_SHARE of the total.
 */
export function blendAngleWeights(
  learned: Record<string, number> | null | undefined,
): BlendedAngle[] {
  const learnedEntries = Object.entries(learned ?? {}).filter(
    ([move, weight]) => MOVE_IDS.has(move) && weight > 0,
  );
  const learnedIds = new Set(learnedEntries.map(([move]) => move));
  const learnedTotal = learnedEntries.reduce(
    (sum, [, weight]) => sum + weight,
    0,
  );
  const byId = new Map(learnedEntries);
  const defaultOnly = ANGLE_TAXONOMY.filter((move) => !learnedIds.has(move.id));
  if (learnedTotal <= 0 || defaultOnly.length === 0) {
    return ANGLE_TAXONOMY.map((move) => ({ ...move, weight: 1 }));
  }
  const targetDefaultWeight =
    (MIN_ANGLE_DEFAULT_SHARE / (1 - MIN_ANGLE_DEFAULT_SHARE)) * learnedTotal;
  const perDefault = targetDefaultWeight / defaultOnly.length;
  return ANGLE_TAXONOMY.map((move) => ({
    ...move,
    weight: learnedIds.has(move.id)
      ? Math.max(byId.get(move.id) ?? 0, 0.0001)
      : Math.max(perDefault, 0.0001),
  }));
}

export type AngleProfile = {
  revision: number;
  weights: Record<string, number>;
  sampleCount: number;
};

/** The current profile = the max revision, or null before any pass. */
export async function currentAngleProfile(
  tx: Tx,
): Promise<AngleProfile | null> {
  const [row] = await tx
    .select({
      revision: angleProfileRevisions.revision,
      weights: angleProfileRevisions.weights,
      sampleCount: angleProfileRevisions.sampleCount,
      createdAt: angleProfileRevisions.createdAt,
    })
    .from(angleProfileRevisions)
    .orderBy(desc(angleProfileRevisions.revision))
    .limit(1);
  return row
    ? {
        revision: row.revision,
        weights: row.weights,
        sampleCount: row.sampleCount,
      }
    : null;
}

export type AngleClassificationState = {
  /** ≥3 unclassified samples and the 24h cooldown elapsed (or first pass). */
  due: boolean;
  unclassifiedCount: number;
  /** 0 before any pass — the CAS base for finish_task. */
  profileRevision: number;
  weights: Record<string, number>;
  sampleCount: number;
  taxonomy: readonly AngleMove[];
};

export async function angleClassificationState(
  tx: Tx,
  now: number = Date.now(),
): Promise<AngleClassificationState> {
  const [counts] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(voiceSamples)
    .where(
      and(
        eq(voiceSamples.eligible, true),
        isNull(voiceSamples.disownedAt),
        isNull(voiceSamples.angleClassifiedAt),
      ),
    );
  const unclassifiedCount = counts?.n ?? 0;
  const [latest] = await tx
    .select({
      revision: angleProfileRevisions.revision,
      weights: angleProfileRevisions.weights,
      sampleCount: angleProfileRevisions.sampleCount,
      createdAt: angleProfileRevisions.createdAt,
    })
    .from(angleProfileRevisions)
    .orderBy(desc(angleProfileRevisions.revision))
    .limit(1);
  const cool =
    latest == null ||
    now - latest.createdAt > ANGLE_CLASSIFICATION_COOLDOWN_MS;
  return {
    due: unclassifiedCount >= ANGLE_CLASSIFICATION_MIN_NEW && cool,
    unclassifiedCount,
    profileRevision: latest?.revision ?? 0,
    weights: latest?.weights ?? {},
    sampleCount: latest?.sampleCount ?? 0,
    taxonomy: ANGLE_TAXONOMY,
  };
}

export type AngleClassificationInput = {
  expectedProfileRevision: number;
  classifications: ReadonlyArray<{
    sampleId: number;
    labels: ReadonlyArray<{ move: string; weight: number }>;
    /** Null = no angle was offered for that sample's candidate. */
    matchedOfferedAngle: boolean | null;
  }>;
};

export type AngleClassificationResult =
  | { ok: false; code: "stale_revision"; currentRevision: number }
  | { ok: false; code: "no_new_classifications" }
  | {
      ok: true;
      revision: number;
      classified: number;
      weights: Record<string, number>;
      sampleCount: number;
    };

/**
 * Thin intake for the client's classification pass — no server model. Stamps
 * each qualifying sample (eligible, undisowned, still unclassified; anything
 * else is silently skipped, the sanitize posture), then recomputes the
 * cumulative distribution over ALL classified samples and appends the next
 * profile revision. CAS on the profile revision so two concurrent passes
 * cannot both count.
 */
export async function submitAngleClassifications(
  tx: Tx,
  input: AngleClassificationInput,
  now: number = Date.now(),
): Promise<AngleClassificationResult> {
  const current = await currentAngleProfile(tx);
  const currentRevision = current?.revision ?? 0;
  if (input.expectedProfileRevision !== currentRevision) {
    return { ok: false, code: "stale_revision", currentRevision };
  }
  let classified = 0;
  for (const item of input.classifications) {
    const labels = sanitizeAngleLabels(item.labels);
    const stamped = await tx
      .update(voiceSamples)
      .set({
        angleLabels: labels,
        angleMatchedOffered: item.matchedOfferedAngle,
        angleClassifiedAt: now,
      })
      .where(
        and(
          eq(voiceSamples.id, item.sampleId),
          eq(voiceSamples.eligible, true),
          isNull(voiceSamples.disownedAt),
          isNull(voiceSamples.angleClassifiedAt),
        ),
      )
      .returning({ id: voiceSamples.id });
    classified += stamped.length;
  }
  if (classified === 0) return { ok: false, code: "no_new_classifications" };
  const rows = await tx
    .select({ angleLabels: voiceSamples.angleLabels })
    .from(voiceSamples)
    .where(
      and(
        eq(voiceSamples.eligible, true),
        isNull(voiceSamples.disownedAt),
        isNotNull(voiceSamples.angleClassifiedAt),
      ),
    );
  const perSample = rows
    .map((row) => row.angleLabels)
    .filter((labels): labels is Record<string, number> => labels != null);
  const weights = aggregateAngleWeights(perSample);
  const revision = currentRevision + 1;
  await tx.insert(angleProfileRevisions).values({
    revision,
    weights,
    sampleCount: perSample.length,
    source: "client",
    createdAt: now,
  });
  return { ok: true, revision, classified, weights, sampleCount: perSample.length };
}
