import { z } from "zod";
import type { StyleRules } from "@engager/database/schema";
import { getLLM, type LLM } from "../ai/client";
import { modelFor } from "../ai/modelFor";
import { promptRef } from "../ai/prompt/ids";
import { untrusted } from "../ai/prompts";
import type { CapabilitySurface } from "../connector/resolve";
import { OWN_COMMENT_LIMIT, OWN_POST_LIMIT } from "../linkedin/driver";
import { deferTask } from "../tasks/judgment";

/**
 * Structured register observations — the same axes the voice's StyleRules
 * control, observed in the corpus so extraction and settings stay aligned
 * end-to-end. Optional (old fixtures/paths keep validating); the mapper
 * `styleRulesFromObservation` turns strong signals into StyleRules overrides
 * and leaves weak/ambiguous ones null (= inherit the template).
 */
export const VoiceObservation = z.object({
  casing: z.enum(["sentence", "lowercase", "mixed"]),
  em_dashes: z.enum(["never", "rare", "frequent"]),
  /** Average emojis per text, rounded to the nearest integer. 0 = never. */
  emojis_per_text: z.number(),
  semicolons: z.enum(["never", "rare", "frequent"]),
  /** Openers THEY actually use (informational — never turned into bans). */
  common_openers: z.array(z.string()).max(6),
  closes_with_question: z.enum(["rarely", "sometimes", "often"]),
  /** Shorthand they use: "imo", "w/", "&" … empty = writes words out. */
  shorthand: z.array(z.string()).max(8),
});
export type VoiceObservation = z.infer<typeof VoiceObservation>;

export const ToneProfile = z.object({
  persona_description: z.string(),
  style_bullets: z.array(z.string()),
  observed: VoiceObservation.optional(),
});
export type ToneProfile = z.infer<typeof ToneProfile>;

/**
 * Map corpus observations onto StyleRules overrides — CONSERVATIVE: only a
 * strong signal overrides the template; weak/ambiguous stays null (inherit).
 * `bannedOpeners` is never learned (an anti-tell list, not a habit), and
 * `roughEdges` stays null (the prose bullets carry that nuance better).
 * Neither is `closerQuestionPolicy`: how often the owner asks is their
 * measured `traits.questionRate`, counted on the texts they wrote, and a
 * model's "often" over a corpus they did not all write set "encouraged" on
 * voices that seldom ask. Only the owner sets it.
 */
export function styleRulesFromObservation(
  obs: VoiceObservation | undefined,
): StyleRules {
  const rules: StyleRules = {
    emDashes: null,
    semicolons: null,
    emojiMax: null,
    casing: null,
    bannedOpeners: null,
    closerQuestionPolicy: null,
    shorthand: null,
    roughEdges: null,
    extras: null,
  };
  if (!obs) return rules;
  if (obs.em_dashes === "frequent") rules.emDashes = "allow";
  if (obs.semicolons === "frequent") rules.semicolons = "allow";
  if (obs.casing === "lowercase") rules.casing = "lowercase";
  if (Number.isFinite(obs.emojis_per_text)) {
    const avg = Math.round(obs.emojis_per_text);
    // Only override when clearly away from the template's 1: a genuinely
    // emoji-free writer gets 0; a heavy user gets their (capped) average.
    if (avg === 0) rules.emojiMax = 0;
    else if (avg >= 2) rules.emojiMax = Math.min(avg, 3);
  }
  if (obs.shorthand.length === 0) rules.shorthand = null; // absence isn't evidence of forbidding
  return rules;
}

/** Which OUTPUT channel a distillation targets — picks the framing prompt. */
export type VoiceTarget = "comment" | "post";

/**
 * Learn the connected user's writing voice from their OWN LinkedIn posts and
 * distil it into a reusable persona + house-style bullets. (the provider can't list
 * a user's past comments globally; the comment channel layers in their own
 * replies + human-edited drafts — see gatherCommentVoiceSamples in relearn.ts.)
 */
export async function importTone(opts: {
  driver: CapabilitySurface<"own_content">;
  llm?: LLM;
  postLimit?: number;
}): Promise<{ profile: ToneProfile; sampleCount: number } | null> {
  const posts = await opts.driver.fetchOwnPosts(opts.postLimit ?? OWN_POST_LIMIT);
  const samples = posts
    .map((p) => (p.contentText ?? "").trim())
    .filter((t) => t.length > 40);
  if (samples.length === 0) return null;

  const corpus = samples
    .slice(0, OWN_POST_LIMIT)
    .map((s, i) => `--- POST ${i + 1} ---\n${s.slice(0, 800)}`)
    .join("\n\n");

  const llm = opts.llm ?? getLLM();
  const profile = await voiceProfileFromCorpus(llm, corpus, "comment");
  return { profile, sampleCount: samples.length };
}

/** Texts one sample channel may carry into a distillation: the owner's own
 *  comments, the longest channel any caller sends. */
const MAX_CHANNEL_SAMPLES = OWN_COMMENT_LIMIT;

const VOICE_SYSTEM = `You analyse a person's own writing and stored notes and produce a reusable VOICE PROFILE so an assistant can write comments that sound EXACTLY like them — including the natural imperfections that make writing feel human. Capture how they ACTUALLY write: tone, vocabulary, sentence length and rhythm, stance, humour — AND their concrete quirks: capitalisation habits (do they start lines lowercase?), abbreviations/shorthand they use (imo, tbh, w/, &…), punctuation habits (em-dashes, ellipses, missing full stops, run-ons), emoji use, sentence fragments, and how polished vs raw they are. The imperfections and quirks are the MOST important signal — note them explicitly. Be specific to THIS writer; never generic.`;

/** POST-framed variant: how they compose whole LinkedIn POSTS, not comments —
 *  hooks, line breaks, macro structure, endings, hashtag/emoji habits. */
const VOICE_SYSTEM_POST = `You analyse a person's own LinkedIn posts and produce a reusable VOICE PROFILE so an assistant can write POSTS that sound EXACTLY like them. Beyond tone and vocabulary, capture how they COMPOSE a post: how they open (the hook), how they use line breaks and whitespace (one-line paragraphs? dense blocks?), the macro shape (story → lesson? list? hot take?), how long their posts run, how they end (question, punchline, CTA, nothing), and their hashtag/emoji/formatting habits. Also capture their natural imperfections (capitalisation, shorthand, punctuation quirks, polish level) — those make writing feel human. Be specific to THIS writer; never generic.`;

/** Shared `observed` block spec — the structured register axes that align with
 *  the voice's StyleRules settings, so learning and settings agree end-to-end. */
const OBSERVED_TAIL = `
- observed: REPORT what the corpus actually shows, per axis (never guess from vibes — count):
  - casing: "lowercase" only if they clearly start most lines lowercase; "mixed" when inconsistent; else "sentence".
  - em_dashes / semicolons: "frequent" only if they appear across many texts; a couple of instances = "rare"; none = "never".
  - emojis_per_text: the average number of emojis per text, rounded (0 if they don't use them).
  - common_openers: up to 6 opener phrases they actually repeat (verbatim), if any.
  - closes_with_question: how often a text ENDS on a question.
  - shorthand: the shorthand tokens they actually use ("imo", "w/", "&" …), empty if none.`;

const VOICE_USER_TAIL = `\n\nProduce a voice profile:
- persona_description: 2-4 sentences describing their voice, written so it can be used as "write AS this person". Mention their level of polish and any signature quirks.
- style_bullets: up to 8 short imperative rules. At least HALF must capture concrete natural-writing habits (capitalisation, shorthand/abbreviations, punctuation quirks, fragments, emoji use, polish level), not just abstract tone. Examples: "starts many lines lowercase", "uses '&' and 'w/' instead of writing them out", "rarely ends a thought with a full stop", "occasional run-on when excited".${OBSERVED_TAIL}`;

const VOICE_USER_TAIL_POST = `\n\nProduce a voice profile:
- persona_description: 2-4 sentences describing how this person writes LinkedIn POSTS, written so it can be used as "write posts AS this person". Mention their typical structure and any signature quirks.
- style_bullets: up to 8 short imperative rules. At least HALF must capture concrete composition habits (how they hook, line-break rhythm, macro shape, endings, hashtag/emoji use, polish level), not just abstract tone.${OBSERVED_TAIL}`;

async function voiceProfileFromCorpus(
  llm: LLM,
  corpus: string,
  target: VoiceTarget,
  guidance?: string,
): Promise<ToneProfile> {
  return llm.json({
    model: modelFor("writer"),
    stage: "tone_import",
    promptRef: promptRef(
      target === "post" ? "learn.voice_post" : "learn.voice",
    ),
    // Generous, not 600: persona + 8 bullets + the observed block on a rich real
    // account can exceed a tight forced-tool-use budget, truncating the tool input →
    // JSON fails schema validation → learnVoice throws → the voice silently doesn't
    // save. 1600 covers the observed block on top of the old 1200.
    maxTokens: 1600,
    system: target === "post" ? VOICE_SYSTEM_POST : VOICE_SYSTEM,
    user: `Here is the person's own writing and notes.${
      guidance ? `\n\nSOURCE GUIDANCE:\n${guidance}` : ""
    }\n\n${untrusted("WRITING CORPUS", corpus)}${
      target === "post" ? VOICE_USER_TAIL_POST : VOICE_USER_TAIL
    }`,
    schema: ToneProfile,
  });
}

export type VoiceChannelSamples = {
  channel: string;
  texts: string[];
  /** Source authority. Ordinary learning leaves it absent; a relearn names
   *  only what it anchors on, which is never counted as a sample. */
  role?: "primary" | "secondary" | "anchor";
};

/** The `sourceText` bound a prepared task accepts (`StartTask`), minus
 *  headroom for the task envelope. A corpus longer than this is truncated
 *  rather than refused: a partly-read voice is still a voice. */
const MAX_DEFERRED_CORPUS_CHARS = 60_000;

/**
 * Learn the user's voice from MULTIPLE active channels (LinkedIn posts + Brain
 * facts). The caller gathers the raw texts per channel; this blends them into one
 * persona + house-style. `target` picks the framing: "comment" (default — how
 * they comment/react) vs "post" (how they compose whole posts). Returns null if
 * nothing usable.
 */
export async function learnVoice(opts: {
  llm?: LLM;
  samples: VoiceChannelSamples[];
  target?: VoiceTarget;
  /** Keep the historic threshold by default; direct first-Radar comments may be
   * short but still carry intentional voice signal. */
  minTextLength?: number;
  /** One direct sample should refine, not replace, the provisional profile. */
  calibrationMode?: "conservative" | "full";
  /**
   * What a DEFERRED distillation must write when the caller's agent submits
   * it. Only a caller that knows — `runVoiceRelearn` resolved the selected voice
   * and read `persist` — can say; a seed's bonus voice pass leaves it absent
   * and means the default voice's comment channel, which is what it always
   * wrote.
   */
  defer?: { voiceId?: number; persist?: boolean };
}): Promise<{ profile: ToneProfile; sampleCount: number } | null> {
  const blocks: string[] = [];
  const roles: string[] = [];
  let sampleCount = 0;
  for (const s of opts.samples) {
    const texts = s.texts
      .map((t) => t.trim())
      .filter((t) => t.length > (opts.minTextLength ?? 20))
      .slice(0, MAX_CHANNEL_SAMPLES);
    if (texts.length === 0) continue;
    // An anchor steers the distillation and is none of the texts it learned
    // from, so it is never counted as one.
    if (s.role !== "anchor") sampleCount += texts.length;
    const body = texts
      .map((t, i) => `[${i + 1}] ${t.slice(0, 800)}`)
      .join("\n");
    const channel = s.channel.replace(/[^\p{L}\p{N} _-]/gu, "").slice(0, 80);
    blocks.push(`=== ${channel.toUpperCase()} ===\n${body}`);
    if (s.role) roles.push(`${s.role}: ${channel}`);
  }
  if (sampleCount === 0) return null;

  // The corpus is I/O; the distillation is the model phase. Under the
  // external-judgment policy the second one belongs to the caller's own agent,
  // so hand over the EXACT bytes this call was about to send and answer null —
  // which every caller already reads as "this channel learned nothing", the
  // same graceful arm a thin history produces. Nothing is refused and nothing
  // half-written: the owed `voice_analysis` task carries the corpus forward.
  //
  // Keyed on the CHANNEL, not on the task kind. A relearn on `both` calls this
  // twice over two different corpora, and one owed `voice_analysis` merged
  // them first-wins — silently dropping the post distillation and writing the
  // comment channel twice. Two channels are two stages.
  const corpus = blocks.join("\n\n");
  const channel = opts.target ?? "comment";
  if (
    deferTask({
      kind: "voice_analysis",
      dedupeKey: `voice_analysis:${channel}`,
      sourceText: corpus.slice(0, MAX_DEFERRED_CORPUS_CHARS),
      intent: {
        voiceTarget: channel,
        ...(opts.defer?.voiceId ? { voiceId: opts.defer.voiceId } : {}),
        ...(opts.defer?.persist === false ? { persist: false } : {}),
      },
    })
  )
    return null;

  const guidance = [
    roles.length > 0
      ? `Source authority is ordered PRIMARY > SECONDARY > ANCHOR. When evidence conflicts, follow the higher-authority source. ${roles.join("; ")}.`
      : "",
    opts.calibrationMode === "conservative"
      ? "This is a conservative refinement from one direct first-Radar comment. Preserve the current provisional profile unless the direct comment gives concrete evidence of a wording, rhythm, casing, punctuation, or polish habit. Do not infer broad personality traits from one sample."
      : opts.calibrationMode === "full"
        ? "This is a first-Radar calibration. Treat the direct first-Radar comments as the clearest evidence of how the person actually comments; use other sources only to fill gaps and prevent overfitting."
        : "",
  ]
    .filter(Boolean)
    .join("\n");
  const llm = opts.llm ?? getLLM();
  const profile = await voiceProfileFromCorpus(
    llm,
    blocks.join("\n\n"),
    opts.target ?? "comment",
    guidance || undefined,
  );
  return { profile, sampleCount };
}
