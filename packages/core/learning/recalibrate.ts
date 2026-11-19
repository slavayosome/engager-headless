import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { isAssisted } from "@engager/common/text-provenance";
import { voiceSamples, voices, type Voice } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { enqueue } from "../jobs/queue";
import { refreshLearnedDirectives } from "./editSignals";
import {
  sampleBelongsToVoice,
  UNMATERIALISED_DEFAULT_VOICE,
  voiceEvidence,
} from "../voice";

export { sampleBelongsToVoice, voiceEvidence };

/**
 * Consumption side of the durable voice corpus (`voice_samples`).
 *
 * Capture (learning/voiceSamples.ts) appends rows at the moment of the human
 * act; this module decides when those rows amount to a calibration that is DUE,
 * stamps the watermark when a calibration consumes them, and soft-deletes a
 * sample the owner disowns. The cadence is founder-locked: the owner's own
 * agent recalibrates first (24h cooldown), and the hosted fallback job only
 * steps in after a 72h grace so a healthy client always wins the race.
 *
 * Every count, consumption and drafting example here reads only what the owner
 * WROTE (`voiceEvidence`, voice.ts). An agent draft the owner approved stays in the
 * corpus as an approval — angle learning still reads it — but a voice that
 * learns its style from it learns the model back.
 */

export const RECALIBRATION_MIN_NEW_SAMPLES = 3;
export const RECALIBRATION_CLIENT_COOLDOWN_MS = 24 * 60 * 60_000;
export const RECALIBRATION_SERVER_COOLDOWN_MS = 72 * 60 * 60_000;

export type PendingRecalibration = {
  /** `null` when this is the org's default voice and no row exists for it yet.
   *  The counts beside it are still the real corpus — a capture on a voice-less
   *  org carries `voiceId: null` and belongs to whatever default is created
   *  next. */
  voiceId: number | null;
  /** The voice's revision at read time — the client echoes it back through
   *  `finish_task.expectedRevision` (CAS). */
  voiceRevision: number;
  /** Owner-written, undisowned samples no calibration has consumed yet. */
  newEligibleSamples: number;
  /** Owner-written, undisowned samples in total (consumed + unconsumed). */
  totalEligibleSamples: number;
  lastCalibratedAt: number | null;
  dueForClient: boolean;
  dueForServer: boolean;
};

/**
 * The voice this question is about: the named one, else the org default, else
 * the default this org has not created yet.
 *
 * It does not lazily create, which is the promise `getVoiceForCampaign` makes
 * one file away — "read paths stay write-free" — and it used to create here, on
 * three callers that are all reads. But answering NOTHING on a voice-less org
 * was worse than the write: the corpus is real (captures store `voiceId: null`
 * for "the default voice at the time"), so a read that skips it reports zero
 * samples to an owner who has written four. `UNMATERIALISED_DEFAULT_VOICE`
 * matches exactly those rows, which is how the drafting context has read the
 * same corpus all along. Creating the row is the WRITE paths' job — the
 * recalibrate job, a saved comment and `finish_task` each call
 * `ensureDefaultVoice` before they need an id.
 */
async function targetVoice(
  tx: Tx,
  voiceId?: number | null,
): Promise<Pick<Voice, "id" | "isDefault" | "revision" | "calibratedAt">> {
  if (voiceId != null) {
    const [row] = await tx.select().from(voices).where(eq(voices.id, voiceId));
    if (!row) throw new Error(`voice ${voiceId} not found`);
    return row;
  }
  const [row] = await tx.select().from(voices).where(eq(voices.isDefault, true));
  // The revision a freshly minted default carries, which is what
  // `finish_task` will compare `expectedRevision` against after
  // its own `ensureDefaultVoice` (voices.revision defaults to 0).
  return row ?? { ...UNMATERIALISED_DEFAULT_VOICE, revision: 0, calibratedAt: null };
}

/**
 * Is a recalibration due for this voice? One shared answer for the client
 * playbook (`list_voices`), the stats surface, and the fallback job —
 * the thresholds must never drift between them.
 *
 * `voiceId` is null when the answer is about a default this org has not
 * created yet: the counts are real, and any caller that needs the ROW calls
 * `ensureDefaultVoice` itself.
 */
export async function pendingRecalibration(
  tx: Tx,
  voiceId?: number | null,
  now: number = Date.now(),
): Promise<PendingRecalibration> {
  const voice = await targetVoice(tx, voiceId);
  const rows = await tx
    .select({ usedInVoiceRevision: voiceSamples.usedInVoiceRevision })
    .from(voiceSamples)
    .where(voiceEvidence(voice));
  const newEligibleSamples = rows.filter(
    (row) => row.usedInVoiceRevision == null,
  ).length;
  const lastCalibratedAt = voice.calibratedAt;
  const enough = newEligibleSamples >= RECALIBRATION_MIN_NEW_SAMPLES;
  // A never-calibrated voice with enough samples is due immediately.
  const coolFor = (cooldownMs: number) =>
    lastCalibratedAt == null || now - lastCalibratedAt > cooldownMs;
  return {
    voiceId: voice.id === UNMATERIALISED_DEFAULT_VOICE.id ? null : voice.id,
    voiceRevision: voice.revision,
    newEligibleSamples,
    totalEligibleSamples: rows.length,
    lastCalibratedAt,
    dueForClient: enough && coolFor(RECALIBRATION_CLIENT_COOLDOWN_MS),
    dueForServer: enough && coolFor(RECALIBRATION_SERVER_COOLDOWN_MS),
  };
}

/**
 * Stamp the calibration watermark: only rows that belong to this org+voice,
 * are voice evidence (eligible, undisowned, owner-written), and not already
 * consumed take the new revision — a stale/foreign/disowned/approved-draft id
 * in the list is simply not stamped. Returns how many rows actually were.
 */
export async function consumeVoiceSamples(
  tx: Tx,
  input: { voiceId: number; sampleIds: number[]; revision: number },
): Promise<number> {
  if (input.sampleIds.length === 0) return 0;
  const [voice] = await tx
    .select({ id: voices.id, isDefault: voices.isDefault })
    .from(voices)
    .where(eq(voices.id, input.voiceId));
  if (!voice) throw new Error(`voice ${input.voiceId} not found`);
  const stamped = await tx
    .update(voiceSamples)
    .set({ usedInVoiceRevision: input.revision })
    .where(
      and(
        inArray(voiceSamples.id, input.sampleIds),
        voiceEvidence(voice),
        isNull(voiceSamples.usedInVoiceRevision),
      ),
    )
    .returning({ id: voiceSamples.id });
  return stamped.length;
}

export type DisownVoiceSampleResult = {
  disowned: boolean;
  /**
   * The sample's watermark is a `voices.revision` at or below the voice's
   * current one — some past calibration learned from these words, and every
   * later calibration inherits that influence (the corpus is cumulative). When
   * true, the caller should `enqueueForcedRecalibration` so the voice is
   * relearned WITHOUT them.
   */
  wasConsumedByCurrentRevision: boolean;
};

/**
 * Soft-delete one sample: the row stays for audit and dedupe stability, the
 * corpus skips it. Idempotent — disowning twice keeps the first timestamp.
 * (No MCP tool exposes this; the dashboard's sample manager calls it later.)
 */
export async function disownVoiceSample(
  tx: Tx,
  sampleId: number,
): Promise<DisownVoiceSampleResult> {
  const [sample] = await tx
    .select()
    .from(voiceSamples)
    .where(eq(voiceSamples.id, sampleId));
  if (!sample) return { disowned: false, wasConsumedByCurrentRevision: false };
  if (sample.disownedAt == null) {
    await tx
      .update(voiceSamples)
      .set({ disownedAt: Date.now() })
      .where(
        and(eq(voiceSamples.id, sampleId), isNull(voiceSamples.disownedAt)),
      );
  }
  let wasConsumedByCurrentRevision = false;
  if (sample.usedInVoiceRevision != null) {
    const [voice] =
      sample.voiceId != null
        ? await tx
            .select({ revision: voices.revision })
            .from(voices)
            .where(eq(voices.id, sample.voiceId))
        : await tx
            .select({ revision: voices.revision })
            .from(voices)
            .where(eq(voices.isDefault, true));
    wasConsumedByCurrentRevision =
      voice != null && sample.usedInVoiceRevision <= voice.revision;
  }
  // A disowned save stops steering how drafts are edited, too.
  if (sample.editSignals != null) {
    const [owner] = await tx
      .select({ id: voices.id, isDefault: voices.isDefault })
      .from(voices)
      .where(sample.voiceId != null ? eq(voices.id, sample.voiceId) : eq(voices.isDefault, true));
    if (owner) await refreshLearnedDirectives(tx, owner);
  }
  return { disowned: true, wasConsumedByCurrentRevision };
}

const DAY_MS = 86_400_000;

/**
 * Arm the hosted fallback after a fresh eligible capture. The day-bucketed
 * idempotency key means at most one `recalibrate_voice` row per voice per day
 * no matter how many comments the owner writes; the handler self-gates on the
 * cadence, so an early wake is a cheap no-op, never an early calibration.
 * Always called inside the capture's org-scoped tx (the jobs table stamps
 * `organization_id` from the GUC) — never from baseDb.
 */
export async function enqueueRecalibration(
  tx: Tx,
  voiceId: number | null,
): Promise<void> {
  await enqueue(tx, {
    type: "recalibrate_voice",
    payload: { voiceId },
    idempotencyKey: `recalibrate:${voiceId ?? "default"}:${Math.floor(Date.now() / DAY_MS)}`,
  });
}

/**
 * The disown path: the owner just removed words a calibration already learned
 * from, so the voice must be relearned WITHOUT them — regardless of cooldown.
 * Minute-bucketed key: one forced run per voice per minute collapses a burst
 * of disowns into a single relearn. Keyed on `revision` instead, one run per
 * revision of the voice, so the last of a burst of writes is always read.
 */
export async function enqueueForcedRecalibration(
  tx: Tx,
  voiceId: number | null,
  revision?: number,
): Promise<void> {
  const bucket = revision !== undefined ? `r${revision}` : Math.floor(Date.now() / 60_000);
  await enqueue(tx, {
    type: "recalibrate_voice",
    payload: { voiceId, forced: true },
    idempotencyKey: `recalibrate:forced:${voiceId ?? "default"}:${bucket}`,
  });
}

/** Newest-first eligible, undisowned samples for one voice (corpus read) —
 *  approvals included, each marked with whether the owner wrote it. */
export async function eligibleVoiceSamples(
  tx: Tx,
  voice: Pick<Voice, "id" | "isDefault">,
  limit = 50,
): Promise<
  {
    id: number;
    text: string;
    source: string;
    capturedAt: number;
    usedInVoiceRevision: number | null;
    campaignId: number | null;
    discoveredPostId: number | null;
    angleClassifiedAt: number | null;
    /** The owner wrote most of the words: voice evidence, not an approval. */
    ownerAuthored: boolean;
  }[]
> {
  const rows = await tx
    .select({
      id: voiceSamples.id,
      text: voiceSamples.text,
      source: voiceSamples.source,
      capturedAt: voiceSamples.capturedAt,
      usedInVoiceRevision: voiceSamples.usedInVoiceRevision,
      campaignId: voiceSamples.campaignId,
      discoveredPostId: voiceSamples.discoveredPostId,
      angleClassifiedAt: voiceSamples.angleClassifiedAt,
      assistRetention: voiceSamples.assistRetention,
      ownerOrigin: voiceSamples.ownerOrigin,
    })
    .from(voiceSamples)
    .where(
      and(
        sampleBelongsToVoice(voice),
        eq(voiceSamples.eligible, true),
        isNull(voiceSamples.disownedAt),
      ),
    )
    .orderBy(desc(voiceSamples.capturedAt), desc(voiceSamples.id))
    .limit(limit);
  return rows.map(({ assistRetention, ownerOrigin, ...row }) => ({
    ...row,
    ownerAuthored: !isAssisted(assistRetention, ownerOrigin),
  }));
}

/** Newest-first comments the owner WROTE, for a drafter to imitate: voice
 *  evidence only. */
export async function ownerVoiceSamples(
  tx: Tx,
  voice: Pick<Voice, "id" | "isDefault">,
  limit: number,
): Promise<string[]> {
  const rows = await tx
    .select({ text: voiceSamples.text })
    .from(voiceSamples)
    .where(voiceEvidence(voice))
    .orderBy(desc(voiceSamples.capturedAt), desc(voiceSamples.id))
    .limit(limit);
  return rows.map((row) => row.text);
}
