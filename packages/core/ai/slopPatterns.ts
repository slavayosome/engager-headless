/**
 * Deterministic AI-tell patterns — the high-precision invariant subset of the
 * slop filter, adapted from "stop-slop" by Hardik Pandya (hvpandya.com, MIT).
 *
 * Only patterns that are unambiguous in 15-90-word LinkedIn comments belong
 * here: a hit floors the slop score at SLOP_PATTERN_FLOOR on the server gate
 * and (once the intake gate ships) hard-rejects at submit. Everything fuzzy —
 * adverb stuffing, passive voice, false agency, rhythm, pull-quotes — lives in
 * the LLM layers instead (writer ANTI-SLOP guidance, judge rubric, the
 * engager-people skill's stop-slop edit pass), where judgment beats regex.
 *
 * Voice-independent by design: no voice may permit these (unlike the rules in
 * styleRules.ts). When in doubt a pattern stays OUT of this file — a false
 * positive here blocks a human-sounding draft. `ai_jargon`'s "deep dive" is the
 * lowest-precision entry; drop it first if traces show false positives.
 */

export type SlopPatternViolation = { rule: string; detail: string };

/** Score floor applied by the client-drafting check when a pattern hits: 0.7 sits in the
 *  "multiple tells / could apply to any post" rubric band — damning but not
 *  the 0.9 mechanical-impossibility band (markdown, raw URLs). Rejects at the
 *  default strictness (threshold ≈ 0.625) and any pinned strictness ≥ 0.4. */
export const SLOP_PATTERN_FLOOR = 0.7;

// Sentence-start anchor: start of text, after terminal punctuation, or a new
// line. Anchoring is the precision discipline — "it turns out" opening a
// sentence is a tell; buried mid-clause it's often innocent.
const S = String.raw`(?:^|[.!?]\s+|\n\s*)`;
// Straight or curly apostrophe, optional (lowercase voices drop it).
const AP = String.raw`['’]?`;

export type SlopPattern = { rule: string; re: RegExp; why: string };

export const SLOP_PATTERNS: SlopPattern[] = [
  {
    rule: "throat_clearing",
    re: new RegExp(
      S +
        String.raw`(?:here${AP}s the thing\b|let me be (?:clear|honest)\b|the (?:truth|reality) is\s*[,:]|the uncomfortable truth\b|it turns out\b|i${AP}ll say it again\b|can we talk about\b)`,
      "i",
    ),
    why: "throat-clearing opener — cut it and state the point",
  },
  {
    rule: "emphasis_crutch",
    re: new RegExp(
      String.raw`\blet that sink in\b|\bmake no mistake\b|` +
        S +
        String.raw`(?:full stop|period)\.(?=\s|$)`,
      "i",
    ),
    why: "empty emphasis crutch — delete it, the point stands alone",
  },
  {
    rule: "meta_commentary",
    re: /\b(?:plot twist|spoiler(?: alert)?|hint|hot take|fun fact)\s*:/i,
    why: "meta-commentary label — make the point without announcing it",
  },
  {
    rule: "binary_contrast",
    re: new RegExp(
      S +
        String.raw`(?:it|this|that)(?:${AP}s| is) not (?:about )?[^.!?\n]{1,60}[.!?]\s+(?:it|this|that)(?:${AP}s| is)\b`,
      "i",
    ),
    why: `"It's not X. It's Y." reversal — state Y directly`,
  },
  {
    rule: "not_the_problem",
    re: new RegExp(
      String.raw`\bisn${AP}t the (?:problem|point|issue|question)[.,]\s+[^.!?\n]{1,60}\bis\s*(?:[.!?]|$)`,
      "i",
    ),
    why: `"X isn't the problem. Y is." reframe — say the point directly`,
  },
  {
    rule: "answer_isnt",
    re: new RegExp(
      String.raw`\bthe (?:answer|question|problem|point|goal|real \w+) (?:isn${AP}t|is not)\b`,
      "i",
    ),
    why: "telegraphed pivot — say what it IS instead of what it isn't",
  },
  {
    rule: "negative_listing",
    re: new RegExp(
      S +
        String.raw`it (?:wasn${AP}t|isn${AP}t) [^.!?\n]{1,50}\.\s+it (?:wasn${AP}t|isn${AP}t)\b`,
      "i",
    ),
    why: "negative listing — state what it IS without the runway",
  },
  {
    rule: "thats_it_thats",
    re: new RegExp(String.raw`\bthat${AP}s it\.\s+that${AP}s the\b`, "i"),
    why: `"That's it. That's the …" fragment — performative simplicity`,
  },
  {
    rule: "vague_declarative",
    re: new RegExp(
      String.raw`\bthe (?:implications are (?:significant|huge|massive)|stakes (?:are|couldn${AP}t be) high(?:er)?|consequences are real|reasons are structural)\b`,
      "i",
    ),
    why: "announces importance without naming the thing — name the specific thing",
  },
  {
    rule: "ai_jargon",
    re: /\b(?:game[- ]?chang(?:er|ing)|paradigm shift|deep[- ]?dive|double[- ]?edged sword)\b/i,
    why: "AI-flavored jargon — use plain words",
  },
];

/** Run every pattern; one violation per rule, quoting the matched text. */
export function slopPatternViolations(text: string): SlopPatternViolation[] {
  const v: SlopPatternViolation[] = [];
  for (const p of SLOP_PATTERNS) {
    const m = text.match(p.re);
    if (m) {
      const snippet = m[0].replace(/^[.!?\s]+/, "").trim();
      v.push({ rule: p.rule, detail: `"${snippet}" — ${p.why}` });
    }
  }
  return v;
}

/** Wire form for get_drafting_context.slop.patterns: JSON-safe,
 *  reconstructable via `new RegExp(source, flags)`. */
export function serializePatterns(): {
  rule: string;
  source: string;
  flags: string;
  why: string;
}[] {
  return SLOP_PATTERNS.map((p) => ({
    rule: p.rule,
    source: p.re.source,
    flags: p.re.flags,
    why: p.why,
  }));
}
