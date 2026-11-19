import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { isAssisted } from "@engager/common/text-provenance";
import {
  voiceSamples,
  type EditSignals,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { enqueueRecalibration } from "./recalibrate";

/**
 * Capture side of the durable voice corpus (`voice_samples`).
 *
 * A sample is recorded at the moment of the human act — saving a comment,
 * rewriting a draft — never at posting time, so a comment that gets capped,
 * killed, rejected, or handed off to LinkedIn manually still teaches the
 * voice. Rows are append-only here; consumption (`usedInVoiceRevision`) and
 * disowning belong to the calibration side.
 *
 * Every saved comment is recorded and eligible — angle learning reads them
 * all. Voice STYLE does not: it learns only from the samples the owner wrote
 * most of the words of, read off the assist-retention and owner-origin ratios
 * frozen on each row (`ownerAuthoredSample`, voice.ts). A kept agent draft is
 * an approval, and a voice that learned from it would learn the model back.
 * An explicit disown (`disownedAt`) excludes a row from everything, forever.
 */

export type CapturedVoiceSampleSource =
  | "first_radar"
  | "radar_deck"
  | "edited_draft"
  | "dictated"
  | "owner_dm"
  | "owner_reply";

export type VoiceSampleCaptureInput = {
  text: string;
  source: CapturedVoiceSampleSource;
  /** Frozen authorship measurements at the moment of the act (null = no draft
   *  was ever offered — the owner's words by construction). */
  assistRetention: number | null;
  ownerOrigin: number | null;
  /** Resolved voice at capture; null = the org's default voice. */
  voiceId?: number | null;
  messageId?: number | null;
  campaignId?: number | null;
  discoveredPostId?: number | null;
  onboardingResponseId?: number | null;
  /** How the save changed the draft it kept; null when none was offered. */
  editSignals?: EditSignals | null;
};

export type VoiceSampleCaptureResult = {
  /** Null when the same normalized text was already captured for this org. */
  id: number | null;
  eligible: boolean;
  deduped: boolean;
};

/** Org-wide dedupe digest: sha256 over the NFKC/whitespace/case-normalized
 *  text, so a retry, a backfill, and a second surface saving the same words
 *  all collapse to one row. */
export function voiceSampleHash(text: string): string {
  const normalized = text
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/**
 * Which capture source a measured owner save belongs to: "dictated" when the
 * owner-origin credit is what rescued the text from the assisted bucket (they
 * spoke the words and the agent carried them), plain "radar_deck" otherwise.
 * Reuses the isAssisted policy rather than re-deriving thresholds.
 */
export function ownerSampleSource(measured: {
  assistRetention: number | null;
  ownerOrigin: number | null;
}): "radar_deck" | "dictated" {
  const rescued =
    isAssisted(measured.assistRetention, null) &&
    !isAssisted(measured.assistRetention, measured.ownerOrigin);
  return rescued ? "dictated" : "radar_deck";
}

export async function captureVoiceSample(
  tx: Tx,
  input: VoiceSampleCaptureInput,
): Promise<VoiceSampleCaptureResult> {
  const [inserted] = await tx
    .insert(voiceSamples)
    .values({
      voiceId: input.voiceId ?? null,
      text: input.text,
      textHash: voiceSampleHash(input.text),
      source: input.source,
      assistRetention: input.assistRetention,
      ownerOrigin: input.ownerOrigin,
      eligible: true,
      messageId: input.messageId ?? null,
      campaignId: input.campaignId ?? null,
      discoveredPostId: input.discoveredPostId ?? null,
      onboardingResponseId: input.onboardingResponseId ?? null,
      editSignals: input.editSignals ?? null,
    })
    .onConflictDoNothing({
      target: [voiceSamples.organizationId, voiceSamples.textHash],
    })
    .returning({ id: voiceSamples.id });
  // A fresh sample arms the hosted recalibration fallback (the handler
  // self-gates on the founder-locked cadence). Dedupes teach nothing new, so
  // they wake nothing.
  if (inserted != null) {
    await enqueueRecalibration(tx, input.voiceId ?? null);
  }
  return {
    id: inserted?.id ?? null,
    eligible: true,
    deduped: inserted == null,
  };
}
