import { z } from "zod";
import type {
  DraftingKnobs,
  StyleAxisItem,
  StyleDirectives,
  StyleStructuralRange,
  VoiceTraits,
} from "@engager/database/schema";
import { getLLM, type LLM } from "../ai/client";
import { modelFor } from "../ai/modelFor";
import { promptRef } from "../ai/prompt/ids";
import {
  DEFAULT_STYLE_TAXONOMY,
  type StyleClass,
  type StyleTaxonomy,
} from "../ai/promptDefaults";
import {
  rationedHabits,
  usesSignature,
  type RationedHabit,
  type TraitViolation,
  type VoiceSignature,
} from "../ai/voiceTraits";
import type { CapabilitySurface } from "../connector/resolve";
import { OWN_POST_LIMIT } from "../linkedin/driver";

// ============================================================================
// Structural fingerprints — the embedder-free anti-template signals.
//
// The PRIMARY signal is `openingSignature` (robust for the "The {noun} is the
// {part}" monoculture). `trigramCosine` is a NOISY SECONDARY for 1-sentence
// comments — tune empirically, never load-bearing alone (plan amendment #11).
// ============================================================================

/** Function words preserved in an opening signature; everything else collapses to `*`. */
const FUNCTION_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "this", "that", "these",
  "those", "it", "its", "i", "you", "we", "they", "he", "she", "to", "of", "in",
  "on", "for", "and", "but", "or", "so", "if", "as", "at", "by", "with", "my",
  "your", "our", "their", "his", "her", "what", "why", "how", "when", "do",
  "does", "did", "not", "no", "yes", "really", "just",
]);

const N_OPENING_TOKENS = 4;

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Collapse the first few words of a comment to a STRUCTURAL signature: function
 * words survive verbatim, content words become `*`. So "The framing is the part"
 * and "The line is the part" both → "the * is the". Empty/whitespace → "".
 *
 * This is the single source of truth for the opening class — `inferOpeningType`
 * derives FROM it (no separate classifier to drift, plan amendment eng-#4).
 */
export function openingSignature(text: string): string {
  const tokens = tokenize(text).slice(0, N_OPENING_TOKENS);
  if (tokens.length === 0) return "";
  return tokens.map((t) => (FUNCTION_WORDS.has(t) ? t : "*")).join(" ");
}

/**
 * Map an opening signature to one of the DEFAULT_STYLE_TAXONOMY `opening` class
 * ids, used to label legacy message rows that have no persisted `styleDirectives`
 * so the LRU rotation can still exclude what recent drafts opened with. Derived
 * SOLELY from `openingSignature` — same input → same class, no drift.
 */
export function inferOpeningType(text: string): string {
  const sig = openingSignature(text);
  if (sig === "") return "lead_point";
  const tokens = sig.split(" ");
  const first = tokens[0] ?? "";
  // A leading question word (or a trailing "?") → question_open.
  if (/^(what|why|how|when|do|does|did)$/.test(first)) return "question_open";
  if (text.trim().split(/\s+/).length <= 2) return "fragment";
  // Leads with a self pronoun → lead_self.
  if (/^(i|we|my|our)$/.test(first)) return "lead_self";
  // Opens on a contrast/turn word → contrast.
  if (/^(but|so|and|or)$/.test(first)) return "contrast";
  // A signature that opens with a content word reacting to a detail.
  if (first === "*") return "react_detail";
  return "lead_point";
}

/** Character-trigram multiset. */
function trigrams(s: string): Map<string, number> {
  const norm = s.toLowerCase().replace(/\s+/g, " ").trim();
  const m = new Map<string, number>();
  if (norm.length < 3) {
    if (norm.length > 0) m.set(norm, 1);
    return m;
  }
  for (let i = 0; i <= norm.length - 3; i++) {
    const g = norm.slice(i, i + 3);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Cosine similarity over character-trigram multisets (0..1). Pure, no embedder. */
export function trigramCosine(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let dot = 0;
  for (const [g, av] of ta) {
    const bv = tb.get(g);
    if (bv) dot += av * bv;
  }
  let na = 0;
  for (const v of ta.values()) na += v * v;
  let nb = 0;
  for (const v of tb.values()) nb += v * v;
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Max structural similarity of `candidate` to any of `recent`: 1 on an
 * openingSignature collision (the strong template tell), else the max trigram
 * cosine. Returns 0 when there's nothing to compare against.
 */
export function maxStructuralSimilarity(candidate: string, recent: string[]): number {
  if (recent.length === 0) return 0;
  const candSig = openingSignature(candidate);
  let max = 0;
  for (const r of recent) {
    if (candSig !== "" && openingSignature(r) === candSig) return 1;
    max = Math.max(max, trigramCosine(candidate, r));
  }
  return max;
}

// ============================================================================
// Blended taxonomy — learned ∪ defaults with a guaranteed default share.
// ============================================================================

export type BlendedAxis = { id: string; directive: string; weight: number };
export type BlendedRange = {
  opening: BlendedAxis[];
  shape: BlendedAxis[];
  stance: BlendedAxis[];
};

/** The minimum fraction of total axis weight the DEFAULT classes must hold, so a
 *  narrow learned corpus can't re-introduce a monoculture (plan amendment #8). */
export const MIN_DEFAULT_SHARE = 0.4;

function blendAxis(
  learned: StyleAxisItem[] | undefined,
  defaults: StyleClass[],
): BlendedAxis[] {
  const byId = new Map(defaults.map((d) => [d.id, d]));
  // Learned weights, but only for ids we have a directive for (keep ids stable +
  // renderable). Learned shapes are weighted higher (their raw weight, default 1).
  const learnedItems = (learned ?? []).filter((l) => byId.has(l.id));
  const learnedIds = new Set(learnedItems.map((l) => l.id));
  const learnedTotal = learnedItems.reduce((s, l) => s + Math.max(0, l.weight), 0);

  const out: BlendedAxis[] = [];
  for (const l of learnedItems) {
    const d = byId.get(l.id)!;
    out.push({ id: d.id, directive: d.directive, weight: Math.max(0.0001, l.weight) });
  }
  // Every default not present in the learned set is added so the full spread is
  // always available (the diversity FLOOR). Defaults that ARE learned keep their
  // learned weight above; we don't double-count them.
  const defaultOnly = defaults.filter((d) => !learnedIds.has(d.id));

  // Scale the default-only weights so the DEFAULTS hold at least MIN_DEFAULT_SHARE
  // of the total. With no learned items this is just a uniform default spread.
  if (learnedTotal <= 0 || defaultOnly.length === 0) {
    for (const d of defaults) {
      if (!learnedIds.has(d.id)) out.push({ id: d.id, directive: d.directive, weight: 1 });
    }
    return out.length > 0 ? out : defaults.map((d) => ({ ...d, weight: 1 }));
  }
  // total = learnedTotal + defaultWeight; want defaultWeight/total >= share.
  // defaultWeight >= share/(1-share) * learnedTotal.
  const targetDefaultWeight = (MIN_DEFAULT_SHARE / (1 - MIN_DEFAULT_SHARE)) * learnedTotal;
  const perDefault = targetDefaultWeight / defaultOnly.length;
  for (const d of defaultOnly) {
    out.push({ id: d.id, directive: d.directive, weight: Math.max(perDefault, 0.0001) });
  }
  return out;
}

/**
 * Blend the voice-learned structural range with the hardcoded default taxonomy:
 * always a superset of the defaults (the FLOOR), learned shapes weighted higher,
 * with a guaranteed minimum default selection share (so "learned weighted higher"
 * cannot collapse to the user's own monoculture). Nil/degenerate learned ranges
 * fall through to a uniform default spread.
 */
export function blendRanges(
  learned: StyleStructuralRange | null | undefined,
  defaults: StyleTaxonomy = DEFAULT_STYLE_TAXONOMY,
): BlendedRange {
  return {
    opening: blendAxis(learned?.opening, defaults.opening),
    shape: blendAxis(learned?.shape, defaults.shape),
    stance: blendAxis(learned?.stance, defaults.stance),
  };
}

// ============================================================================
// LRU rotation — pick one class per axis, avoiding what recent drafts used.
// ============================================================================

/** Deterministic 32-bit hash of a seed string (for stable per-post rotation). */
export function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Pick one class per axis from `blended`, EXCLUDING the ids the recent window
 * used (LRU), tie-broken deterministically by `seed` (so concurrent serverless
 * drains of the same post pick the same directives — batch-awareness is then
 * best-effort across DIFFERENT posts). Falls back gracefully when every class on
 * an axis is excluded (saturation): rotates by seed over the full axis instead.
 */
export function pickAxis(
  blended: BlendedAxis[],
  usedIds: Set<string>,
  seed: string,
  axisName: string,
): { id: string; directive: string } {
  if (blended.length === 0) return { id: "default", directive: "" };
  const fresh = blended.filter((b) => !usedIds.has(b.id));
  const pool = fresh.length > 0 ? fresh : blended; // saturation → rotate over all
  // Weighted-but-deterministic: order by weight desc, then rotate by seed so we
  // don't always pick the single heaviest class (which would re-create a fingerprint).
  const ordered = [...pool].sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
  const idx = hashSeed(`${seed}:${axisName}`) % ordered.length;
  const chosen = ordered[idx]!;
  return { id: chosen.id, directive: chosen.directive };
}

export type PickedDirectives = { ids: StyleDirectives; block: string };

// ============================================================================
// Rationing — the owner's own habits, at the owner's own rate.
//
// A phrase the owner uses in a quarter of their comments, shown to a writer
// as an example, comes back in every draft. Each draft is therefore dealt
// its signatures the way the owner's own comments are: a seeded draw at the
// owner's rate, and none at all while recent drafts already run over it.
// A move the owner makes rarely — a tag, two options, a colon
// (`rationedHabits`) — is dealt the same way, so rare never becomes either
// every time or never. The judge holds a run of drafts to the same rates.
// Rationing deals words and moves only: the register is the voice's own in
// every draft, dealt one or not.
// ============================================================================

/** The agent drafts rationing is read over, newest first. */
export const SIGNATURE_WINDOW = 10;
/** Drafts, the judged one among them, before a share of them says anything. */
const SIGNATURE_JUDGE_MIN = 5;
/** How far over the owner's rate a run of drafts may land by chance, in
 *  standard deviations of a binomial at that rate, by the voice's
 *  `DraftingKnobs.rationing`. */
export const RATIONING_SLACK_SD = { strict: 2, soft: 3 } as const;

export type Rationing = NonNullable<DraftingKnobs["rationing"]>;

/** A signature this draft is to leave out, and why. */
export type HeldSignature = VoiceSignature & {
  /** Recent drafts that already carry it, where they run over the owner. */
  over?: { used: number; of: number };
};

/** A rare habit this draft is to leave out, and why. */
export type HeldHabit = Pick<RationedHabit, "key" | "label" | "rate"> & {
  /** Recent drafts that already carry it, of those its rate is a share of,
   *  where they run over the owner. */
  over?: { used: number; of: number };
};

const unitDraw = (seed: string) => hashSeed(seed) / 0x1_0000_0000;
const percentOf = (rate: number) => `${Math.round(rate * 100)}%`;

/**
 * The signatures THIS draft is to leave out: each one recent drafts already
 * carry more often than the owner does, and each one the draft's seeded draw
 * at the owner's rate does not deal it — so across a batch about the owner's
 * share of drafts may carry each, and the rest leave it out. Deterministic
 * per seed. Never a reason to add a phrase: a draft dealt one may still do
 * without it.
 */
export function heldSignatures(opts: {
  signatures: readonly VoiceSignature[] | undefined;
  recent: readonly string[];
  seed: string;
}): HeldSignature[] {
  const held: HeldSignature[] = [];
  for (const signature of opts.signatures ?? []) {
    const used = opts.recent.filter((text) => usesSignature(text, signature.phrase)).length;
    if (opts.recent.length > 0 && used / opts.recent.length > signature.rate) {
      held.push({ ...signature, over: { used, of: opts.recent.length } });
    } else if (unitDraw(`${opts.seed}:signature:${signature.phrase}`) >= signature.rate) {
      held.push(signature);
    }
  }
  return held;
}

/**
 * The rare habits (`rationedHabits`) THIS draft is to leave out, dealt the way
 * signatures are: each one recent drafts already carry past the owner's rate
 * — counted over the drafts that rate is a share of — and each one the
 * draft's seeded draw at that rate does not deal it. Deterministic per seed.
 */
export function heldHabits(opts: {
  habits: readonly RationedHabit[];
  recent: readonly string[];
  seed: string;
}): HeldHabit[] {
  const held: HeldHabit[] = [];
  for (const { key, label, rate, carries, among } of opts.habits) {
    const pool = opts.recent.filter(among);
    const used = pool.filter(carries).length;
    if (pool.length > 0 && used / pool.length > rate) {
      held.push({ key, label, rate, over: { used, of: pool.length } });
    } else if (unitDraw(`${opts.seed}:habit:${key}`) >= rate) {
      held.push({ key, label, rate });
    }
  }
  return held;
}

/** What a draft leaves out as a per-comment line for the writer — a rule when
 *  rationing is strict, a preference when it is soft; "" for none. */
function renderHeld(
  signatures: readonly HeldSignature[],
  habits: readonly HeldHabit[],
  rationing: Exclude<Rationing, "off">,
): string {
  const over = (held: { over?: { used: number; of: number } }, drafts = "drafts") =>
    held.over ? `; ${held.over.used} of the last ${held.over.of} ${drafts} already did` : "";
  const items = [
    ...signatures.map(
      (s) => `"${s.phrase}" (you use it in about ${percentOf(s.rate)} of what you write${over(s)})`,
    ),
    ...habits.map((h) =>
      h.key === "eitherOrRate"
        ? `${h.label} (you do it in about ${percentOf(h.rate)} of your questions${over(h, "drafts that asked")})`
        : `${h.label} (you do it in about ${percentOf(h.rate)} of what you write${over(h)})`,
    ),
  ];
  if (items.length === 0) return "";
  return rationing === "soft"
    ? `\nFor THIS comment, rather leave out ${items.join(", ")}. Each is yours, but only some of your comments carry it.`
    : `\nHARD RULE for THIS comment: leave out ${items.join(", ")}. Each is yours, but only some of your comments carry it, and this one is not one of them.`;
}

/** Binomial reach: the most of `of` drafts that may carry a habit at rate `r`
 *  by chance, `slack` standard deviations over its mean. */
export const reachOf = (r: number, of: number, slack: number) =>
  Math.floor(r * of + slack * Math.sqrt(of * r * (1 - r)));

/**
 * The judge: a draft that carries a signature the run of drafts before it —
 * `recent`, newest first, this batch's earlier drafts among them — already
 * carries well past the owner's rate. Silent below `SIGNATURE_JUDGE_MIN`
 * drafts, and for a voice whose share is high enough that every draft
 * carrying it is within reach of chance.
 */
export function signatureOveruse(
  text: string,
  recent: readonly string[],
  signatures: readonly VoiceSignature[] | undefined,
  slack: number = RATIONING_SLACK_SD.strict,
): TraitViolation[] {
  const v: TraitViolation[] = [];
  const of = recent.length + 1;
  if (of < SIGNATURE_JUDGE_MIN) return v;
  for (const signature of signatures ?? []) {
    if (!usesSignature(text, signature.phrase)) continue;
    const used = recent.filter((other) => usesSignature(other, signature.phrase)).length + 1;
    const r = signature.rate;
    if (used > reachOf(r, of, slack)) {
      v.push({
        rule: "voice_signature_overuse",
        detail: `"${signature.phrase}" would be in ${used} of the last ${of} drafts — this voice uses it in about ${percentOf(r)} of what it writes`,
      });
    }
  }
  return v;
}

/**
 * The same judge for the moves a voice makes rarely: a draft that makes one
 * the run before it already makes past the owner's rate, counted over the
 * drafts that rate is a share of. One draft making it is never flagged.
 */
export function habitOveruse(
  text: string,
  recent: readonly string[],
  habits: readonly RationedHabit[],
  slack: number = RATIONING_SLACK_SD.strict,
): TraitViolation[] {
  const v: TraitViolation[] = [];
  for (const { key, label, rate, carries, among } of habits) {
    if (!among(text) || !carries(text)) continue;
    const pool = recent.filter(among);
    const of = pool.length + 1;
    if (of < SIGNATURE_JUDGE_MIN) continue;
    const used = pool.filter(carries).length + 1;
    if (used > reachOf(rate, of, slack)) {
      const asking = key === "eitherOrRate";
      v.push({
        rule: "voice_habit_overuse",
        detail: `${label} would be in ${used} of the last ${of} drafts${asking ? " that ask" : ""} — this voice does it in about ${percentOf(rate)} of ${asking ? "its questions" : "what it writes"}`,
      });
    }
  }
  return v;
}

/**
 * Every run-of-drafts check a voice's rationing makes — its signatures and
 * its rare habits — at the slack its `rationing` knob sets; none when it is
 * off. What the judge, the intake gate and a preview all read.
 */
export function rationingOveruse(
  text: string,
  recent: readonly string[],
  traits: VoiceTraits | undefined,
  rationing: Rationing = "strict",
): TraitViolation[] {
  if (rationing === "off") return [];
  const slack = RATIONING_SLACK_SD[rationing];
  return [
    ...signatureOveruse(text, recent, traits?.signatures, slack),
    ...habitOveruse(text, recent, rationedHabits(traits), slack),
  ];
}

// ============================================================================
// Owner examples — a different few for each draft.
// ============================================================================

/** How many of the owner's examples one draft is shown, by default
 *  (`DraftingKnobs.exemplarCount`). */
export const EXAMPLES_PER_DRAFT = 6;

/** Every drafting knob at the value a voice that turned none of them drafts
 *  with — what each absent knob means. */
export const DEFAULT_DRAFTING_KNOBS: Required<DraftingKnobs> = {
  exemplarCount: EXAMPLES_PER_DRAFT,
  exemplarMode: "rotate",
  rationing: "strict",
  voiceStrictness: "normal",
};

/**
 * The owner's examples one draft is shown. Rotated (the default): all of them
 * up to `exemplarCount`, else a seeded few in their own order — so no single
 * example's phrasing reads as the template every draft copies. "all": every
 * one, every draft. Deterministic per seed; undefined stays undefined.
 */
export function examplesForDraft(
  examples: readonly string[] | undefined,
  seed: string,
  knobs: Pick<DraftingKnobs, "exemplarCount" | "exemplarMode"> = {},
): string[] | undefined {
  if (!examples) return undefined;
  const count = knobs.exemplarCount ?? EXAMPLES_PER_DRAFT;
  if (knobs.exemplarMode === "all" || examples.length <= count) return [...examples];
  const draw = (index: number) => hashSeed(`${seed}:example:${index}`);
  return examples
    .map((_, index) => index)
    .sort((a, b) => draw(a) - draw(b) || a - b)
    .slice(0, count)
    .sort((a, b) => a - b)
    .map((index) => examples[index]!);
}

/**
 * Does this comment END as a question? Deterministic, multilingual-aware: trailing
 * `?` (plus full-width `？` and Arabic `؟`), tolerating closing quotes/brackets and
 * a trailing `!` (`?!`). Mid-text questions deliberately don't count — the cap
 * targets the "…so what do you think?" closer pattern, not rhetorical questions.
 */
export function endsWithQuestion(text: string): boolean {
  return /[?？؟]["'!)\]]*\s*$/u.test(text.trim());
}

/**
 * Pick one OPENING + SHAPE + STANCE directive for a draft, avoiding the classes
 * the recent org-wide window used. `recent` are the persisted `styleDirectives`
 * of the recent window (or inferred opening ids for legacy rows).
 */
export function pickStyleDirectives(opts: {
  blendedRange: BlendedRange;
  recent: { opening?: string; shape?: string; stance?: string }[];
  seed: string;
  /** SHAPE ids to remove from the pool for this draft (length-aware exclusion). The
   *  filter is best-effort: if it would empty the pool it falls back to the full pool. */
  excludeShape?: Set<string>;
  /** Question-ending control appended to the directive block, resolved by the
   *  caller from the voice's closerQuestionPolicy × the campaign question-cap:
   *  - "hard_no": a HARD no-question line — binds the OUTPUT, not just the pool
   *    (guidance elsewhere may still push toward question hooks; this must win).
   *  - "soft_no": a softer nudge for question-encouraging voices at over-cap —
   *    prefer a stance, without forbidding a genuinely earned question. */
  questionMode?: "hard_no" | "soft_no";
  /** The owner's signatures THIS draft leaves out (`heldSignatures`). */
  heldSignatures?: readonly HeldSignature[];
  /** The rare habits THIS draft leaves out (`heldHabits`). */
  heldHabits?: readonly HeldHabit[];
  /** How what it leaves out is put: a rule (default) or, "soft", a
   *  preference. "off" leaves nothing out. */
  rationing?: Rationing;
  /** The voice's register, which every draft keeps whatever it is built from
   *  and whatever it leaves out. */
  register?: VoiceTraits["register"];
}): PickedDirectives {
  const usedOpening = new Set(opts.recent.map((r) => r.opening).filter(Boolean) as string[]);
  const usedShape = new Set(opts.recent.map((r) => r.shape).filter(Boolean) as string[]);
  const usedStance = new Set(opts.recent.map((r) => r.stance).filter(Boolean) as string[]);

  const shapePool =
    opts.excludeShape && opts.excludeShape.size
      ? opts.blendedRange.shape.filter((s) => !opts.excludeShape!.has(s.id))
      : opts.blendedRange.shape;

  const opening = pickAxis(opts.blendedRange.opening, usedOpening, opts.seed, "opening");
  const shape = pickAxis(
    shapePool.length ? shapePool : opts.blendedRange.shape,
    usedShape,
    opts.seed,
    "shape",
  );
  const stance = pickAxis(opts.blendedRange.stance, usedStance, opts.seed, "stance");

  const ids: StyleDirectives = { opening: opening.id, shape: shape.id, stance: stance.id };
  let block = renderDirectiveBlock({ opening, shape, stance });
  if (opts.questionMode === "hard_no" && block) {
    block +=
      "\nHARD RULE for THIS comment: do NOT end with a question — recent comments already skew question-heavy. Land a stance or a specific detail and stop; it must stand on its own.";
  } else if (opts.questionMode === "soft_no" && block) {
    block +=
      "\nFor THIS comment: recent comments skew question-heavy — prefer landing a stance or a specific detail over a closing question, unless the question is genuinely the strongest move.";
  }
  const rationing = opts.rationing ?? "strict";
  if (block && rationing !== "off") {
    block += renderHeld(opts.heldSignatures ?? [], opts.heldHabits ?? [], rationing);
  }
  const register = opts.register ? REGISTER_KEPT[opts.register] : undefined;
  if (block && register) {
    block += `\nWhatever this comment is built from and leaves out, it still sounds like you: ${register}.`;
  }
  return { ids, block };
}

/** A register as a directive restates it: a shape varies how a thought is
 *  built, and a phrase left out changes words, never how the owner sounds. */
const REGISTER_KEPT: Partial<Record<NonNullable<VoiceTraits["register"]>, string>> = {
  casual: "casual, in plain words, short sentences and contractions, never polished or analytic",
  formal: "complete, considered sentences, no slang",
};

/** Render the chosen directives into the writer's user-turn STYLE DIRECTIVE block. */
export function renderDirectiveBlock(d: {
  opening: { directive: string };
  shape: { directive: string };
  stance: { directive: string };
}): string {
  const lines = [d.opening.directive, d.shape.directive, d.stance.directive].filter(Boolean);
  if (lines.length === 0) return "";
  return (
    `\n\nSTYLE DIRECTIVE for THIS comment — vary structure within the facts available. Factual grounding takes precedence over every opening, shape and stance below. A profile's expertise or product features do not establish a past incident: never expand them into actions, failures, timings, quantities or results the owner did not document. If a directive needs an unsupported experience, use a present-tense observation about the post instead. Do not invent a contrary fact or an author's problem to satisfy a contrast or question. The SHAPE varies how you BUILD the thought, NOT how long it runs:\n` +
    lines.map((l) => `- ${l}`).join("\n") +
    `\n(Your LENGTH is fixed by the STYLE rule in the system prompt above — never run longer just to satisfy a shape.)`
  );
}

// ============================================================================
// Voice-derived structural-range extractor (mirrors toneImport).
// ============================================================================

const StyleAxisItemSchema = z.object({
  id: z.string(),
  weight: z.number(),
});

export const StructuralRangeResult = z.object({
  opening: z.array(StyleAxisItemSchema),
  shape: z.array(StyleAxisItemSchema),
  stance: z.array(StyleAxisItemSchema),
});
export type StructuralRangeResult = z.infer<typeof StructuralRangeResult>;

const STRUCTURAL_SYSTEM = `You analyse a person's OWN writing and report the RANGE OF STRUCTURES they use to OPEN, SHAPE, and POSITION a short comment — so an assistant can rotate through their natural variety instead of repeating one template. Report ONLY classes the writer actually exhibits, with a relative weight (1 = rare, 5 = very frequent). Do NOT invent variety they don't have; an honest narrow range is fine (the system floors it with defaults).

You MUST use ONLY these class ids (any others are dropped):
- opening: lead_point, lead_self, question_open, fragment, react_detail, contrast
- shape: one_liner, two_beat, mini_story, claim_evidence
- stance: agree_extend, push_back, reframe, ask`;

const STRUCTURAL_USER_TAIL = `\n\nReport the structural range:
- opening / shape / stance: each an array of {id, weight} using ONLY the allowed ids, weight 1-5 reflecting how often they do it. Omit a class they never use.`;

/**
 * Distil the user's structural style range from their OWN LinkedIn posts (reuses
 * the toneImport corpus pattern: `driver.fetchOwnPosts` + forced tool-use). Drops
 * any class id not in the default taxonomy. Best-effort: empty/refusal/zero-posts
 * → null (the caller falls back to the DEFAULT taxonomy via `blendRanges`).
 */
export async function extractStructuralRange(opts: {
  driver: CapabilitySurface<"own_content">;
  llm?: LLM;
  postLimit?: number;
  /** Re-authorize immediately before each driver/model phase. Access errors are
   *  deliberately not swallowed by this best-effort extractor. */
  beforeExternalPhase?: () => Promise<void>;
}): Promise<{ range: StyleStructuralRange; sampleCount: number } | null> {
  let posts: { contentText?: string | null }[];
  await opts.beforeExternalPhase?.();
  try {
    posts = await opts.driver.fetchOwnPosts(opts.postLimit ?? OWN_POST_LIMIT);
  } catch {
    return null; // no connected account
  }
  const samples = posts
    .map((p) => (p.contentText ?? "").trim())
    .filter((t) => t.length > 40);
  if (samples.length === 0) return null;

  const corpus = samples
    .slice(0, OWN_POST_LIMIT)
    .map((s, i) => `--- POST ${i + 1} ---\n${s.slice(0, 800)}`)
    .join("\n\n");

  const llm = opts.llm ?? getLLM();
  let result: StructuralRangeResult;
  await opts.beforeExternalPhase?.();
  try {
    result = await llm.json({
      model: modelFor("writer"),
      stage: "structural_range_extract",
      promptRef: promptRef("learn.structure"),
      system: STRUCTURAL_SYSTEM,
      user: `Here is the person's own writing:\n\n${corpus}${STRUCTURAL_USER_TAIL}`,
      schema: StructuralRangeResult,
      maxTokens: 600,
    });
  } catch {
    return null; // parse/refusal → defaults
  }

  const range = sanitizeRange(result, samples.length);
  // Fully degenerate (every axis empty after sanitization) → fall back to defaults.
  if (
    range.opening.length === 0 &&
    range.shape.length === 0 &&
    range.stance.length === 0
  ) {
    return null;
  }
  return { range, sampleCount: samples.length };
}

const VALID_IDS: Record<keyof StyleTaxonomy, Set<string>> = {
  opening: new Set(DEFAULT_STYLE_TAXONOMY.opening.map((c) => c.id)),
  shape: new Set(DEFAULT_STYLE_TAXONOMY.shape.map((c) => c.id)),
  stance: new Set(DEFAULT_STYLE_TAXONOMY.stance.map((c) => c.id)),
};

function sanitizeAxis(items: StyleAxisItem[], valid: Set<string>): StyleAxisItem[] {
  const seen = new Set<string>();
  const out: StyleAxisItem[] = [];
  for (const it of items) {
    if (!valid.has(it.id) || seen.has(it.id)) continue;
    const w = Number.isFinite(it.weight) ? it.weight : 1;
    out.push({ id: it.id, weight: Math.max(0, w) });
    seen.add(it.id);
  }
  return out;
}

function sanitizeRange(r: StructuralRangeResult, learnedFrom: number): StyleStructuralRange {
  return {
    opening: sanitizeAxis(r.opening, VALID_IDS.opening),
    shape: sanitizeAxis(r.shape, VALID_IDS.shape),
    stance: sanitizeAxis(r.stance, VALID_IDS.stance),
    learnedFrom,
  };
}
