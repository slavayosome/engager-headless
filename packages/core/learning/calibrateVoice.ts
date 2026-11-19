import type { VoiceSampleAnswer } from "@engager/database/schema";
import type { LLM } from "../ai/client";
import { MIN_COMMENT_SAMPLES } from "./relearn";
import {
  learnVoice,
  styleRulesFromObservation,
  type ToneProfile,
  type VoiceChannelSamples,
} from "./toneImport";

const SCOUT_COMMENT_CAP = 20;
const IMPORTED_COMMENT_CAP = 20;
const POST_ANCHOR_CAP = 12;
const PROFILE_ANCHOR_CAP = 2;
const TEXT_CODE_POINT_CAP = 800;
const EARLIER_COMMENT_CAP = 30;

export type VoiceCalibrationCorpus = {
  scoutComments: string[];
  importedComments: string[];
  postAnchors: string[];
  provisionalProfile: string[];
  /** What the owner says of the voice — how they want to sound, who they
   *  write to — as an anchor (`ownerStatedAnchor`); null when they said
   *  neither. */
  stated: VoiceChannelSamples | null;
};

export type LearnedVoiceCalibration = {
  profile: ToneProfile;
  sampleCount: number;
  directSampleCount: number;
  sources: string[];
  styleRules: ReturnType<typeof styleRulesFromObservation>;
};

function promptSafeText(raw: string): string {
  return Array.from(raw.trim()).slice(0, TEXT_CODE_POINT_CAP).join("");
}

function dedupeKey(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function takeUnique(
  values: string[],
  cap: number,
  seen: Set<string>,
): string[] {
  const result: string[] = [];
  for (const raw of values) {
    const value = promptSafeText(raw);
    if (!value) continue;
    const key = dedupeKey(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
    if (result.length >= cap) break;
  }
  return result;
}

/**
 * Build a bounded, globally deduplicated corpus in authority order. The global
 * imported-comment threshold stays unchanged: first-Radar comments are an
 * explicit calibration signal, while incidental own/edited comments enter only
 * when the existing MIN_COMMENT_SAMPLES rule says that channel is reliable.
 */
export function buildVoiceCalibrationCorpus(input: {
  scoutComments: string[];
  ownComments: string[];
  editedComments: string[];
  postTexts: string[];
  provisionalPersona?: string | null;
  provisionalHouseStyle?: string | null;
  ownWords?: string | null;
  writesTo?: string | null;
}): VoiceCalibrationCorpus {
  const seen = new Set<string>();
  const scoutComments = takeUnique(
    input.scoutComments,
    SCOUT_COMMENT_CAP,
    seen,
  );

  const importedCandidates = takeUnique(
    [...input.ownComments, ...input.editedComments],
    IMPORTED_COMMENT_CAP,
    new Set<string>(),
  );
  const importedComments =
    importedCandidates.length >= MIN_COMMENT_SAMPLES
      ? takeUnique(importedCandidates, IMPORTED_COMMENT_CAP, seen)
      : [];
  const postAnchors = takeUnique(input.postTexts, POST_ANCHOR_CAP, seen);
  const provisionalProfile = takeUnique(
    [input.provisionalPersona ?? "", input.provisionalHouseStyle ?? ""],
    PROFILE_ANCHOR_CAP,
    seen,
  );

  return {
    scoutComments,
    importedComments,
    postAnchors,
    provisionalProfile,
    stated: ownerStatedAnchor(input),
  };
}

/**
 * Distil the first-Radar signal. Direct comments always lead; imported real
 * comments are secondary only after the established five-sample floor; posts,
 * the interim profile and what the owner says of the voice are anchors. One direct comment conservatively
 * refines, while two or more perform the full calibration.
 *
 * StyleRules are held back at one sample. On a fresh org every rule is null, so
 * `mergeLearnedStyleRules` fills each one unconditionally, and only a later
 * recalibration that re-observes the register across two fresh samples may
 * change it (`refine`). An n=1 corpus can legitimately observe "frequent" em
 * dashes or a closing question, so the WRITE requires the same evidence as the
 * irreversible `calibrated` CLAIM.
 */
export async function learnCalibratedCommentVoice(opts: {
  llm?: LLM;
  corpus: VoiceCalibrationCorpus;
}): Promise<LearnedVoiceCalibration | null> {
  const directSampleCount = opts.corpus.scoutComments.length;
  if (directSampleCount === 0) return null;

  const samples: VoiceChannelSamples[] = [
    {
      channel: "direct first Radar comments",
      texts: opts.corpus.scoutComments,
      role: "primary",
    },
  ];
  const sources = ["first_radar_comments"];
  if (opts.corpus.importedComments.length > 0) {
    samples.push({
      channel: "imported own comments",
      texts: opts.corpus.importedComments,
      role: "secondary",
    });
    sources.push("own_comments");
  }
  if (opts.corpus.postAnchors.length > 0) {
    samples.push({
      channel: "LinkedIn posts used only as an anchor",
      texts: opts.corpus.postAnchors,
      role: "anchor",
    });
    sources.push("own_posts_anchor");
  }
  if (opts.corpus.provisionalProfile.length > 0) {
    samples.push({
      channel: "current provisional profile used only as an anchor",
      texts: opts.corpus.provisionalProfile,
      role: "anchor",
    });
    sources.push("provisional_voice_anchor");
  }
  // A young voice the owner already told how they want to sound starts from
  // what they said, as every later relearn does.
  if (opts.corpus.stated) {
    samples.push(opts.corpus.stated);
    sources.push("owner_stated_anchor");
  }

  const learned = await learnVoice({
    llm: opts.llm,
    samples,
    target: "comment",
    minTextLength: 0,
    calibrationMode: directSampleCount === 1 ? "conservative" : "full",
  });
  if (!learned) return null;
  return {
    profile: learned.profile,
    sampleCount: learned.sampleCount,
    directSampleCount,
    sources,
    // Below two direct samples the observation is deliberately discarded: the
    // all-null result makes mergeLearnedStyleRules a no-op patch.
    styleRules: styleRulesFromObservation(
      directSampleCount >= 2 ? learned.profile.observed : undefined,
    ),
  };
}

export type LearnedVoiceContinuation = {
  profile: ToneProfile;
  sampleCount: number;
  newSampleCount: number;
  sources: string[];
  styleRules: ReturnType<typeof styleRulesFromObservation>;
};

/** The owner's answers to sample comments, as lines a relearn reads: the
 *  ones they said sound like them, then the ones they said do not. */
function sampleAnswerLines(answers: readonly VoiceSampleAnswer[]): string[] {
  const said = (soundsLikeMe: boolean, heading: string) => {
    const texts = answers.filter((answer) => answer.soundsLikeMe === soundsLikeMe).map((answer) => `- “${answer.text}”`);
    return texts.length > 0 ? `${heading}\n${texts.join("\n")}` : "";
  };
  return [
    said(true, "Drafts the owner said sound like them:"),
    said(false, "Drafts the owner said do not sound like them:"),
  ];
}

/**
 * How the owner says they want to sound, who they write to and what they said
 * of sample comments in the voice, as a relearn anchors on them: beside the
 * current description, never evidence of how they write — a sample comment is
 * Engager's words, whatever the owner said of it. Null when they have said
 * none of it.
 */
export function ownerStatedAnchor(stated: {
  ownWords?: string | null;
  writesTo?: string | null;
  sampleAnswers?: readonly VoiceSampleAnswer[] | null;
}): VoiceChannelSamples | null {
  const text = [
    stated.ownWords?.trim() ?? "",
    stated.writesTo?.trim() ? `You write to: ${stated.writesTo.trim()}` : "",
    ...sampleAnswerLines(stated.sampleAnswers ?? []),
  ]
    .filter(Boolean)
    .join("\n");
  return text
    ? { channel: "how the owner says they want to sound used only as an anchor", texts: [text], role: "anchor" }
    : null;
}

/**
 * Steady-state continuation of an already-learned voice — the hosted fallback
 * half of recalibration (learning/recalibrate.ts owns the cadence). Fresh
 * owner comments lead; comments an earlier calibration already consumed are
 * secondary; the current profile and what the owner says of their voice are
 * only anchors, so the model refines the register instead of re-guessing it.
 * The first-Radar evidence bar carries over: one new sample refines
 * conservatively, and StyleRules — the writes whose overwrite honesty each
 * field's `provenance` tracks — need the register re-observed across at least
 * two new samples.
 */
export async function learnContinuedCommentVoice(opts: {
  llm?: LLM;
  newSamples: string[];
  earlierSamples: string[];
  currentPersona?: string | null;
  currentHouseStyle?: string | null;
  ownWords?: string | null;
  writesTo?: string | null;
  sampleAnswers?: readonly VoiceSampleAnswer[] | null;
}): Promise<LearnedVoiceContinuation | null> {
  const seen = new Set<string>();
  const newSamples = takeUnique(opts.newSamples, SCOUT_COMMENT_CAP, seen);
  const earlierSamples = takeUnique(
    opts.earlierSamples,
    EARLIER_COMMENT_CAP,
    seen,
  );
  const anchor = takeUnique(
    [opts.currentPersona ?? "", opts.currentHouseStyle ?? ""],
    PROFILE_ANCHOR_CAP,
    seen,
  );
  if (newSamples.length === 0 && earlierSamples.length === 0) return null;

  const samples: VoiceChannelSamples[] = [];
  const sources: string[] = [];
  if (newSamples.length > 0) {
    samples.push({
      channel: "comments the owner wrote recently",
      texts: newSamples,
      role: "primary",
    });
    sources.push("recent_owner_comments");
  }
  if (earlierSamples.length > 0) {
    samples.push({
      channel: "earlier owner comments already learned",
      texts: earlierSamples,
      role: "secondary",
    });
    sources.push("earlier_owner_comments");
  }
  if (anchor.length > 0) {
    samples.push({
      channel: "current voice profile used only as an anchor",
      texts: anchor,
      role: "anchor",
    });
    sources.push("current_voice_anchor");
  }
  const stated = ownerStatedAnchor(opts);
  if (stated) {
    samples.push(stated);
    sources.push("owner_stated_anchor");
  }

  const learned = await learnVoice({
    llm: opts.llm,
    samples,
    target: "comment",
    minTextLength: 0,
    calibrationMode: newSamples.length < 2 ? "conservative" : "full",
  });
  if (!learned) return null;
  return {
    profile: learned.profile,
    sampleCount: learned.sampleCount,
    newSampleCount: newSamples.length,
    sources,
    styleRules: styleRulesFromObservation(
      newSamples.length >= 2 ? learned.profile.observed : undefined,
    ),
  };
}
