import { and, desc, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { modeFor } from "../strategy/mode";
import { isAssisted } from "@engager/common/text-provenance";
import {
  campaigns,
  candidateFeedback,
  discoveredPosts,
  feedback,
  messages,
  organizations,
  voiceSamples,
  voices,
  workers,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { calibrationConvergence, gateCycles } from "../learning/voiceRevisions";
import { getSystemState } from "../ratelimit/killswitch";
import { channelWarmupClock } from "../ratelimit/ledger";
import { completedWarmupAt } from "./campaigns";

/**
 * Org-level LEARNING SIGNALS, computed on read and never stored.
 *
 * This was the three-mode gate module. The gates are gone: nothing in the
 * product withholds a capability until a calibration count or a warm-up clock
 * reaches a threshold, because the owner decides what to automate. What
 * survives is the measurement — the same numbers, now purely informational,
 * feeding `get_status`, the Ops page, and the advisories a worker
 * form shows next to a bold setting.
 *
 * If you find yourself adding an `open: boolean` back to this file, that is a
 * gate. Don't.
 *
 * Null-not-zero throughout: absent evidence is never a number.
 */

export type LearningSignals = {
  scope: "org";
  /** Completed voice-calibration cycles. Once the currency of a gate; now just
   *  a number worth showing — nothing is withheld until it reaches anything. */
  calibrationCycles: number;
  /** Null when no active campaign has a warm-up clock. Informational: warm-up
   *  is a ramp on the daily cap, never a precondition for anything. */
  warmupComplete: boolean | null;
  telemetry: {
    voice: {
      ownerAuthoredSamples: number;
      distinctPosts: number;
      voiceCalibrated: boolean;
      recalibrations: number;
      latestDelta: number | null;
      previousDelta: number | null;
      convergenceMet: boolean;
    };
    voiceFit: {
      windowSize: number;
      published: number;
      fitRate: number | null;
      angleMismatchExcluded: number;
      exclusionCapApplied: boolean;
      rejectionsLast20: number | null;
      slopSignal: null;
    };
    judgment: {
      angleAgreementRate: number | null;
      overrideRate30d: number | null;
    };
    safety: {
      killSwitchTripped: boolean;
      scheduledTenureDays: number | null;
      capsExceeded30d: null;
    };
  };
};

/** Telemetry priors, carried from revision 1. */
export const FIT_WINDOW = 30;
export const FIT_DISTANCE_MAX = 0.2;
export const FIT_EXCLUSION_CAP = 0.2;
export const TELEMETRY_WINDOW_MS = 30 * 24 * 60 * 60_000;
export const SAMPLE_FLOOR = 15;
export const DISTINCT_POST_FLOOR = 8;

export async function computeLearningSignals(
  tx: Tx,
  organizationId: string,
  now: number = Date.now(),
): Promise<LearningSignals> {
  // ---- Calibration cycles on the default voice ----------------------------
  const cycles = await gateCycles(tx);

  // The ramp belongs to the ACCOUNT, so every active campaign answers from the
  // same clock. Still `every` over the selected rows: whether any live target
  // exists is what decides between a verdict and null, and that stays per
  // campaign. Warm-up Off (zero weeks) is a ramp already over.
  const clock = await channelWarmupClock(tx);
  const activeCampaigns = await tx
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(eq(campaigns.status, "active"));
  const warmupComplete =
    activeCampaigns.length > 0
      ? activeCampaigns.every(() => {
          if (clock.warmupWeeks <= 0) return true;
          const at = completedWarmupAt(clock);
          return at != null && at <= now;
        })
      : null;

  // ---- Telemetry: the revision-1 measurement families ---------------------
  const sampleRows = await tx
    .select({
      assistRetention: voiceSamples.assistRetention,
      ownerOrigin: voiceSamples.ownerOrigin,
      discoveredPostId: voiceSamples.discoveredPostId,
    })
    .from(voiceSamples)
    .where(
      and(eq(voiceSamples.eligible, true), isNull(voiceSamples.disownedAt)),
    );
  // "Substantial owner wording": computable from the frozen ratios — a
  // kept-verbatim agent draft carries no owner-voice evidence.
  const ownerAuthored = sampleRows.filter(
    (row) => !isAssisted(row.assistRetention, row.ownerOrigin),
  );
  const distinctPosts = new Set(
    ownerAuthored
      .map((row) => row.discoveredPostId)
      .filter((id): id is number => id != null),
  ).size;

  const [defaultVoice] = await tx
    .select({ id: voices.id, maturity: voices.maturity })
    .from(voices)
    .where(eq(voices.isDefault, true))
    .limit(1);
  const voiceCalibrated = defaultVoice?.maturity === "calibrated";
  const convergence = defaultVoice
    ? await calibrationConvergence(tx, defaultVoice.id)
    : {
        cycles: 0,
        latestDelta: null,
        previousDelta: null,
        convergenceMet: false,
      };

  // Voice fit: the last N owner saves measured against an offered draft and
  // actually published. An angle mismatch excludes a row from the fit
  // denominator, but never more than the cap — style failures cannot be
  // laundered out as "different angle".
  const fitRows = await tx
    .select({
      id: messages.id,
      draftFitDistance: messages.draftFitDistance,
    })
    .from(messages)
    .where(
      and(
        eq(messages.kind, "comment"),
        eq(messages.status, "posted"),
        isNotNull(messages.draftFitDistance),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(FIT_WINDOW);
  const fitMessageIds = fitRows.map((row) => row.id);
  const mismatchRows =
    fitMessageIds.length > 0
      ? await tx
          .select({ messageId: voiceSamples.messageId })
          .from(voiceSamples)
          .where(
            and(
              inArray(voiceSamples.messageId, fitMessageIds),
              eq(voiceSamples.angleMatchedOffered, false),
            ),
          )
      : [];
  const mismatchIds = new Set(
    mismatchRows
      .map((row) => row.messageId)
      .filter((id): id is number => id != null),
  );
  const cap = Math.floor(fitRows.length * FIT_EXCLUSION_CAP);
  const exclusionCapApplied = mismatchIds.size > cap;
  const excluded = Math.min(mismatchIds.size, cap);
  let skipped = 0;
  const counted: { fit: boolean }[] = [];
  for (const row of fitRows) {
    if (mismatchIds.has(row.id) && skipped < cap) {
      skipped += 1;
      continue;
    }
    counted.push({ fit: (row.draftFitDistance ?? 1) <= FIT_DISTANCE_MAX });
  }
  const fitRate =
    counted.length > 0
      ? counted.filter((row) => row.fit).length / counted.length
      : null;

  const recentFeedback = await tx
    .select({ verdict: feedback.verdict })
    .from(feedback)
    .orderBy(desc(feedback.createdAt))
    .limit(20);
  const rejectionsLast20 =
    recentFeedback.length > 0
      ? recentFeedback.filter((row) => row.verdict === "reject").length
      : null;

  const classified = await tx
    .select({ matched: voiceSamples.angleMatchedOffered })
    .from(voiceSamples)
    .where(
      and(
        eq(voiceSamples.eligible, true),
        isNull(voiceSamples.disownedAt),
        isNotNull(voiceSamples.angleMatchedOffered),
        gte(voiceSamples.angleClassifiedAt, now - TELEMETRY_WINDOW_MS),
      ),
    );
  const angleAgreementRate =
    classified.length > 0
      ? classified.filter((row) => row.matched === true).length /
        classified.length
      : null;

  // Strict overrides: a human verdict contradicting a recorded agent verdict.
  // Only the FIRST contradiction per candidate is ever observable (the ranker
  // refuses to re-rank a human good_match) — acceptable for telemetry.
  const windowStart = now - TELEMETRY_WINDOW_MS;
  const [restored] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(candidateFeedback)
    .where(
      and(
        eq(candidateFeedback.verdict, "good_match"),
        isNull(candidateFeedback.revertedAt),
        eq(candidateFeedback.priorStatus, "rejected"),
        gte(candidateFeedback.createdAt, windowStart),
      ),
    );
  const [dismissedMatches] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(candidateFeedback)
    .innerJoin(
      discoveredPosts,
      and(
        eq(candidateFeedback.discoveredPostId, discoveredPosts.id),
        eq(candidateFeedback.campaignId, discoveredPosts.campaignId),
      ),
    )
    .where(
      and(
        eq(candidateFeedback.verdict, "not_relevant"),
        isNull(candidateFeedback.revertedAt),
        isNotNull(discoveredPosts.agentScore),
        gte(candidateFeedback.createdAt, windowStart),
      ),
    );
  const [triaged] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(discoveredPosts)
    .where(gte(discoveredPosts.agentRankedAt, windowStart));
  const overrides = (restored?.n ?? 0) + (dismissedMatches?.n ?? 0);
  const overrideRate30d =
    (triaged?.n ?? 0) > 0 ? overrides / (triaged?.n ?? 1) : null;

  const system = await getSystemState(tx);
  const killSwitchTripped = system?.killSwitch === true;
  const scheduledTenureDays = null;

  return {
    scope: "org",
    calibrationCycles: cycles,
    warmupComplete,
    telemetry: {
      voice: {
        ownerAuthoredSamples: ownerAuthored.length,
        distinctPosts,
        voiceCalibrated,
        recalibrations: convergence.cycles,
        latestDelta: convergence.latestDelta,
        previousDelta: convergence.previousDelta,
        convergenceMet: convergence.convergenceMet,
      },
      voiceFit: {
        windowSize: FIT_WINDOW,
        published: fitRows.length,
        fitRate,
        angleMismatchExcluded: excluded,
        exclusionCapApplied,
        rejectionsLast20,
        slopSignal: null,
      },
      judgment: { angleAgreementRate, overrideRate30d },
      safety: {
        killSwitchTripped,
        scheduledTenureDays,
        capsExceeded30d: null,
      },
    },
  };
}

/**
 * The safety drop: a kill-switch trip stops unattended publishing, visibly.
 *
 * Every campaign whose Comment resolves to Automatic is narrowed to Ask me by
 * one strategy patch, which lands at once with its version and its undo, and
 * every not-yet-sent auto-approved comment returns to `proposed` — the DB
 * trigger cancels its action. The narrowing is durable, so clearing the kill
 * switch resumes a paused product rather than firing a backlog all at once,
 * and the owner can see what was turned down and turn it back up deliberately.
 *
 * Only the Comment binding moves: the campaign's wake and its other steps are
 * the owner's, and a Comment already at Ask me has nothing to drop. Owner-
 * authored comments are untouched — nothing the owner wrote themselves is
 * unattended work.
 */
export async function narrowCommentToAskMe(
  tx: Tx,
  organizationId: string,
  campaignId: number,
  reason: string,
  now: number = Date.now(),
): Promise<boolean> {
  const comment = await modeFor(tx, { campaignId, capability: "publish_comment", target: "post" });
  // Armed is what the owner asked for, not what a hold lowers it to today:
  // a requested Automatic held at Ask me would come back on its own.
  if (comment.requested !== "auto" && comment.effective !== "auto") return false;
  // Loaded here: submitting a patch reaches back to the surfaces that trip this.
  const { patchForSwitches } = await import("../strategy/redirect");
  const { submitStrategyPatch } = await import("../strategy/submit");
  const patch = await patchForSwitches(tx, campaignId, { comment: { publish: false } },
    `${reason}: Comment from Automatic to Ask me`);
  if (!patch) return false;
  // A narrowing is never a card: it applies at once, or it is a bug.
  const outcome = await submitStrategyPatch(tx, organizationId, patch, { approver: `system:${reason}`, now });
  if (!("applied" in outcome)) throw new Error(`the ${reason} narrowing of campaign ${campaignId} did not apply`);
  return true;
}

export async function suspendWorkerPublishing(
  tx: Tx,
  organizationId: string,
  reason: string,
  now: number = Date.now(),
): Promise<{ suspendedWorkerIds: number[]; disarmedMessages: number }> {
  const candidates = await tx
    .select({ id: workers.id, campaignId: workers.campaignId })
    .from(workers)
    .where(and(eq(workers.organizationId, organizationId), eq(workers.type, "ambassador")))
    .for("update");
  const ids: number[] = [];
  for (const worker of candidates) {
    if (worker.campaignId === null) continue;
    if (await narrowCommentToAskMe(tx, organizationId, worker.campaignId, reason, now)) ids.push(worker.id);
  }

  // Only unattended comments are disarmed. An owner-authored comment already
  // had its human act; holding it hostage to a kill switch aimed at worker
  // would be the product deciding the owner cannot speak.
  const disarmed = await tx
    .update(messages)
    .set({ status: "proposed", scheduledAt: null })
    .where(
      and(
        eq(messages.organizationId, organizationId),
        eq(messages.kind, "comment"),
        eq(messages.status, "approved"),
        eq(messages.publishOrigin, "worker"),
      ),
    )
    .returning({ id: messages.id });
  return {
    suspendedWorkerIds: ids,
    disarmedMessages: disarmed.length,
  };
}
