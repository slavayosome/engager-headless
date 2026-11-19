import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { voiceSamples, voices, type Voice, type VoiceSampleAnswer } from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import {
  learnContinuedCommentVoice,
  type LearnedVoiceContinuation,
} from "../../learning/calibrateVoice";
import {
  RECALIBRATION_MIN_NEW_SAMPLES,
  RECALIBRATION_SERVER_COOLDOWN_MS,
  consumeVoiceSamples,
  pendingRecalibration,
  voiceEvidence,
} from "../../learning/recalibrate";
import { snapshotVoiceRevision } from "../../learning/voiceRevisions";
import {
  mergeLearnedStyleRules,
  setVoiceChannel,
} from "../../operations/voices";
import { getProfile, setChannelVoice } from "../../profile";
import type { SelfScopedCtx } from "../worker";
import { RescheduleError } from "../queue";
import {
  assertHostedJobSpendStillAllowed,
  assertHostedJobSpendStillAllowedInTx,
  HostedJobSpendRevokedError,
} from "../spendAccess";
import { ensureDefaultVoice } from "../../voice";

const PayloadSchema = z.object({
  /** null = the org's default voice (samples captured with voiceId null). */
  voiceId: z.number().int().positive().nullable(),
  /** A disowned consumed sample forces a relearn regardless of cooldown. */
  forced: z.boolean().optional(),
});

/** Secondary-corpus bound: consumed comments an earlier calibration learned. */
const EARLIER_SAMPLE_CAP = 30;

type RecalibrationSnapshot = {
  voiceId: number;
  /** The revision AFTER the 'calibrating' bump — the apply fence. */
  voiceRevision: number;
  previousMaturity: Voice["maturity"];
  isDefault: boolean;
  newSampleIds: number[];
  newSampleTexts: string[];
  earlierSampleTexts: string[];
  totalEligible: number;
  currentPersona: string | null;
  currentHouseStyle: string | null;
  /** What the owner says of the voice, which the relearn anchors on. */
  ownWords: string | null;
  writesTo: string | null;
  sampleAnswers: VoiceSampleAnswer[] | null;
};

/**
 * SELF-GATE (short org tx). Below the
 * founder-locked floor the job completes as a no-op — the NEXT eligible
 * capture re-arms a fresh day-bucketed job, so nothing queues forever. Inside
 * the 72h server grace it reschedules to the moment the grace lapses: the
 * window in which the owner's own agent is expected to calibrate first.
 */
async function snapshotRecalibration(
  ctx: SelfScopedCtx,
  payload: z.infer<typeof PayloadSchema>,
): Promise<RecalibrationSnapshot | null> {
  return withOrg(ctx.organizationId, async (tx) => {
    if (payload.voiceId != null) {
      const [exists] = await tx
        .select({ id: voices.id })
        .from(voices)
        .where(eq(voices.id, payload.voiceId));
      if (!exists) return null; // the voice was deleted — nothing to relearn
    }
    // A WRITE path, so it creates: a capture on a voice-less org enqueues this
    // job with `voiceId: null` and stores its sample the same way, and the
    // whole point of the run is to learn a voice from that corpus. The reads
    // beside it describe the default without minting one; this is the path
    // that mints it.
    const targetVoiceId =
      payload.voiceId ?? (await ensureDefaultVoice(tx)).id;
    const pending = await pendingRecalibration(tx, targetVoiceId);
    const forced = payload.forced === true;
    if (pending.totalEligibleSamples === 0) return null;
    if (!forced) {
      if (pending.newEligibleSamples === 0) return null;
      if (!pending.dueForServer) {
        if (pending.newEligibleSamples < RECALIBRATION_MIN_NEW_SAMPLES) {
          return null;
        }
        // lastCalibratedAt is non-null here — a never-calibrated voice with
        // enough samples is dueForServer immediately.
        throw new RescheduleError(
          "voice_recalibration_cooldown",
          (pending.lastCalibratedAt ?? Date.now()) +
            RECALIBRATION_SERVER_COOLDOWN_MS,
        );
      }
    }
    await assertHostedJobSpendStillAllowedInTx(tx, ctx);

    const [voice] = await tx
      .select()
      .from(voices)
      .where(eq(voices.id, targetVoiceId))
      .for("update");
    if (!voice) return null;
    // Another calibration holds the voice;
    // its revision fence must win — this run steps aside.
    if (voice.maturity === "calibrating") return null;

    const rows = await tx
      .select({
        id: voiceSamples.id,
        text: voiceSamples.text,
        usedInVoiceRevision: voiceSamples.usedInVoiceRevision,
      })
      .from(voiceSamples)
      .where(voiceEvidence(voice))
      .orderBy(desc(voiceSamples.capturedAt), desc(voiceSamples.id));
    const fresh = rows.filter((row) => row.usedInVoiceRevision == null);
    const earlier = rows
      .filter((row) => row.usedInVoiceRevision != null)
      .slice(0, EARLIER_SAMPLE_CAP);

    const [started] = await tx
      .update(voices)
      .set({
        maturity: "calibrating",
        revision: sql`${voices.revision} + 1`,
        updatedAt: Date.now(),
      })
      .where(eq(voices.id, voice.id))
      .returning({ revision: voices.revision });
    if (!started) throw new Error("voice_recalibration_voice_missing");

    const profile = await getProfile(tx);
    const channel = voice.channels?.comment;
    return {
      voiceId: voice.id,
      voiceRevision: started.revision,
      previousMaturity: voice.maturity,
      isDefault: voice.isDefault,
      newSampleIds: fresh.map((row) => row.id),
      newSampleTexts: fresh.map((row) => row.text),
      earlierSampleTexts: earlier.map((row) => row.text),
      totalEligible: rows.length,
      currentPersona:
        channel?.persona ?? (voice.isDefault ? profile.voicePersona : null),
      currentHouseStyle:
        channel?.houseStyle ??
        (voice.isDefault ? profile.voiceHouseStyle : null),
      ownWords: voice.styleRules?.ownWords ?? null,
      writesTo: voice.styleRules?.writesTo ?? null,
      sampleAnswers: voice.styleRules?.sampleAnswers ?? null,
    };
  });
}

/** Undo the 'calibrating' mark — only while OUR fence still holds. */
async function restorePreviousVoiceState(
  tx: Tx,
  snapshot: RecalibrationSnapshot,
): Promise<void> {
  await tx
    .update(voices)
    .set({
      maturity: snapshot.previousMaturity,
      revision: sql`${voices.revision} + 1`,
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(voices.id, snapshot.voiceId),
        eq(voices.revision, snapshot.voiceRevision),
        eq(voices.maturity, "calibrating"),
      ),
    );
}

/**
 * Revision-fenced apply: the voice must still be exactly the row this run marked
 * 'calibrating', else the concurrent writer (a manual edit, a client
 * finish_task) won and the previous maturity is restored.
 */
async function applyRecalibration(
  ctx: SelfScopedCtx,
  snapshot: RecalibrationSnapshot,
  learned: LearnedVoiceContinuation,
): Promise<void> {
  await withOrg(ctx.organizationId, async (tx) => {
    await assertHostedJobSpendStillAllowedInTx(tx, ctx);
    const [voice] = await tx
      .select()
      .from(voices)
      .where(eq(voices.id, snapshot.voiceId))
      .for("update");
    if (
      !voice ||
      voice.revision !== snapshot.voiceRevision ||
      voice.maturity !== "calibrating"
    ) {
      if (voice) await restorePreviousVoiceState(tx, snapshot);
      return;
    }

    const houseStyle = learned.profile.style_bullets
      .map((bullet) => `- ${bullet}`)
      .join("\n");
    // A description with words is the owner's — written by them, or kept by
    // them — and a background job never overwrites it: what it learned waits
    // beside it for Keep or Drop, replacing any proposal still waiting. An
    // empty one has nothing to lose, so it is written as before.
    if (snapshot.currentPersona?.trim() || snapshot.currentHouseStyle?.trim()) {
      await setVoiceChannel(tx, voice.id, "comment", {
        proposed: {
          persona: learned.profile.persona_description,
          houseStyle,
          at: Date.now(),
          from: learned.sources,
          learnedFrom: learned.sampleCount,
          newComments: learned.newSampleCount,
        },
      });
    } else if (snapshot.isDefault) {
      await setChannelVoice(tx, "comment", {
        persona: learned.profile.persona_description,
        houseStyle,
        learnedFrom: learned.sampleCount,
        sources: learned.sources,
      });
    } else {
      await setVoiceChannel(tx, voice.id, "comment", {
        persona: learned.profile.persona_description,
        houseStyle,
        learnedFrom: learned.sampleCount,
        sources: learned.sources,
      });
    }
    // The overwrite honesty rule: only a field a previous calibration learned
    // may be refined, and only when the register was re-observed across at
    // least two fresh samples. A field the owner set is never touched.
    await mergeLearnedStyleRules(tx, voice.id, learned.styleRules, {
      refine: snapshot.newSampleIds.length >= 2,
    });

    const calibrated =
      snapshot.totalEligible >= 2 || snapshot.previousMaturity === "calibrated";
    const [updated] = await tx
      .update(voices)
      .set({
        maturity: calibrated ? "calibrated" : "provisional",
        calibrationSampleCount: snapshot.totalEligible,
        calibratedAt: Date.now(),
        revision: sql`${voices.revision} + 1`,
        updatedAt: Date.now(),
      })
      .where(eq(voices.id, voice.id))
      .returning({ revision: voices.revision });
    if (!updated) throw new Error("voice_recalibration_voice_missing");
    if (snapshot.newSampleIds.length > 0) {
      await consumeVoiceSamples(tx, {
        voiceId: voice.id,
        sampleIds: snapshot.newSampleIds,
        revision: updated.revision,
      });
    }
    await snapshotVoiceRevision(tx, {
      voiceId: voice.id,
      source: "hosted_fallback",
      consumedSampleIds: snapshot.newSampleIds,
    });
  });
}

/**
 * Hosted fallback recalibration (`recalibrate_voice`): the CLIENT playbook
 * (list_voices → finish_task) is the primary path; this job
 * only runs when three new samples have waited out the 72h grace — or when a
 * consumed sample was disowned (`forced`) and the voice must be relearned
 * without it. Same phase discipline as calibrate_voice: short snapshot tx →
 * provider work with no connection held → revision-fenced apply.
 */
export async function handleRecalibrateVoice(
  ctx: SelfScopedCtx,
  rawPayload: unknown,
): Promise<void> {
  const payload = PayloadSchema.parse(rawPayload);
  const snapshot = await snapshotRecalibration(ctx, payload);
  if (!snapshot) return;

  try {
    await assertHostedJobSpendStillAllowed(ctx);
    const learned = await learnContinuedCommentVoice({
      llm: ctx.llm,
      newSamples: snapshot.newSampleTexts,
      earlierSamples: snapshot.earlierSampleTexts,
      currentPersona: snapshot.currentPersona,
      currentHouseStyle: snapshot.currentHouseStyle,
      ownWords: snapshot.ownWords,
      writesTo: snapshot.writesTo,
      sampleAnswers: snapshot.sampleAnswers,
    });
    if (!learned) throw new Error("voice_recalibration_no_usable_samples");
    await applyRecalibration(ctx, snapshot, learned);
  } catch (error) {
    if (
      !(error instanceof HostedJobSpendRevokedError) ||
      !["job_lease_lost", "job_aborted"].includes(error.reason)
    ) {
      await withOrg(ctx.organizationId, (tx) =>
        restorePreviousVoiceState(tx, snapshot),
      );
    }
    throw error;
  }
}
