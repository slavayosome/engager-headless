import { z } from "zod";
import type {
  DraftingKnobs,
  ResolvedStyleRules,
  StyleRules,
  VoiceExample,
  VoiceSampleAnswer,
  VoiceTraits,
} from "@engager/database/schema";
import { VOICE_EXAMPLE_CAP } from "../voice/examples";
import { renderVoiceTraits, voiceTraitViolations } from "./voiceTraits";

/**
 * The single source of truth for REGISTER rules — the anti-AI-tell settings a
 * Voice owns. Three consumers render from the same resolved object so the gates
 * can never veto what the voice permits:
 *   1. the writer system prompt (`renderStyleRules` → the "YOUR REGISTER" block),
 *   2. the slop judge rubric (`slopSystemPrompt(promo, rules)` in ai/slop.ts),
 *   3. the deterministic lint (`styleLint` here).
 *
 * The hardcoded prompt scaffold gives NO register direction — only invariants
 * (response schema, factual grounding, actual channel limits). Everything about how a
 * comment SOUNDS lives in StyleRules + the voice's persona/houseStyle.
 */

const rate = z.number().min(0).max(1);
/** Traits an owner sets by hand (`StyleRules.traits`); each beats its
 *  measured value. */
export const VoiceTraitsSchema = z
  .object({
    register: z.enum(["casual", "neutral", "formal"]),
    lengthWords: z
      .object({ min: z.number().int().min(1).max(300), max: z.number().int().min(1).max(300) })
      .refine((range) => range.min <= range.max, "min must not exceed max"),
    openers: z.array(z.string().min(1).max(40)).max(8),
    closers: z.array(z.string().min(1).max(40)).max(8),
    questionRate: rate,
    eitherOrRate: rate,
    adviceRate: rate,
    movesPerComment: z.number().min(1).max(4),
    tagPhraseRate: rate,
    exclamationRate: rate,
    bareEndingRate: rate,
    colonRate: rate,
    asideStyle: z.enum(["spaced_hyphen", "em_dash", "parentheses", "comma"]),
    specificityRate: rate,
    signatures: z
      .array(z.object({ phrase: z.string().trim().min(1).max(40), rate }).strict())
      .max(12),
  })
  .partial()
  .strict() satisfies z.ZodType<VoiceTraits>;

/** How the owner says they want to sound, and who they write to, in their own
 *  words; and the words they never use. Each is the owner's to set: no
 *  calibration writes one, and none is a template default. */
export const OwnWordsSchema = z.string().max(1000);
export const WritesToSchema = z.string().max(200);
export const AvoidWordsSchema = z.array(z.string().trim().min(1).max(40)).max(30);

/** The longest example of their writing an owner can give a voice: one
 *  comment, not a post. */
export const VOICE_EXAMPLE_MAX_CHARS = 1200;

const ExampleTextSchema = z.string().trim().min(1).max(VOICE_EXAMPLE_MAX_CHARS);

/** One example of how the owner writes, for one channel. Up to the cap for
 *  each of the three channels. */
const VoiceExampleSchema = z
  .object({
    text: ExampleTextSchema,
    pinned: z.boolean(),
    addedAt: z.number().int().nullable(),
    from: z.enum(["pasted", "kept", "dictated", "answer"]),
    channel: z.enum(["comment", "reply", "dm"]),
  })
  .strict() satisfies z.ZodType<VoiceExample>;

/** How a voice's drafts are written (`DraftingKnobs`); an absent knob is at
 *  its default. */
export const DraftingKnobsSchema = z
  .object({
    exemplarCount: z.number().int().min(1).max(12),
    exemplarMode: z.enum(["rotate", "all"]),
    rationing: z.enum(["off", "soft", "strict"]),
    voiceStrictness: z.enum(["loose", "normal", "strict"]),
  })
  .partial()
  .strict() satisfies z.ZodType<DraftingKnobs>;

/** The most answers to sample comments a voice keeps; the oldest drops. */
export const SAMPLE_ANSWER_CAP = 12;
export const VoiceSampleAnswerSchema = z
  .object({ text: z.string().trim().min(1).max(VOICE_EXAMPLE_MAX_CHARS), soundsLikeMe: z.boolean(), at: z.number().int() })
  .strict() satisfies z.ZodType<VoiceSampleAnswer>;

export const StyleRulesSchema = z.object({
  emDashes: z.enum(["allow", "forbid"]).nullable(),
  semicolons: z.enum(["allow", "forbid"]).nullable(),
  emojiMax: z.number().int().min(0).max(10).nullable(),
  casing: z.enum(["sentence", "lowercase", "mirror"]).nullable(),
  bannedOpeners: z.array(z.string().max(60)).max(30).nullable(),
  closerQuestionPolicy: z.enum(["natural", "never", "encouraged"]).nullable(),
  shorthand: z.enum(["allow", "forbid"]).nullable(),
  roughEdges: z.enum(["allow", "forbid"]).nullable(),
  extras: z.string().max(2000).nullable(),
  traits: VoiceTraitsSchema.nullable().optional(),
  traitsByChannel: z
    .object({ reply: VoiceTraitsSchema.nullable().optional(), dm: VoiceTraitsSchema.nullable().optional() })
    .strict()
    .nullable()
    .optional(),
  examples: z.array(ExampleTextSchema).max(VOICE_EXAMPLE_CAP).nullable().optional(),
  exampleItems: z.array(VoiceExampleSchema).max(VOICE_EXAMPLE_CAP * 3).nullable().optional(),
  ownWords: OwnWordsSchema.nullable().optional(),
  writesTo: WritesToSchema.nullable().optional(),
  avoidWords: AvoidWordsSchema.nullable().optional(),
  sampleAnswers: z.array(VoiceSampleAnswerSchema).max(SAMPLE_ANSWER_CAP).nullable().optional(),
  knobs: DraftingKnobsSchema.nullable().optional(),
  provenance: z.record(z.string(), z.enum(["owner", "learned"])).nullable().optional(),
}) satisfies z.ZodType<StyleRules>;

/** The words an owner never uses as one list: trimmed, and the same word in
 *  any case once, first spelling kept. */
export function avoidWordList(words: readonly string[]): string[] {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const raw of words) {
    const word = raw.trim();
    const key = word.toLocaleLowerCase();
    if (!word || seen.has(key)) continue;
    seen.add(key);
    list.push(word);
  }
  return list;
}

/**
 * The shipped default template — byte-for-intent equal to the rules that used to
 * be hardcoded across the writer prompt and the slop rubric.
 * An account that never touches its voice gets exactly this; a null field on a
 * stored voice inherits the corresponding value here (per-field, live).
 */
export const DEFAULT_STYLE_RULES: ResolvedStyleRules = {
  emDashes: "forbid",
  semicolons: "forbid",
  emojiMax: 1,
  casing: "sentence",
  // Union of the historical guidance NEVER-list and the validator's sycophancy
  // set — the openers the slop gate always flagged.
  bannedOpeners: [
    "Great post",
    "Great point",
    "Thanks for sharing",
    "Love this",
    "So true",
    "Couldn't agree more",
    "Well said",
    "This is gold",
    "Spot on",
    "Totally agree",
  ],
  closerQuestionPolicy: "natural",
  shorthand: "allow",
  roughEdges: "allow",
  // Energy-matching is register (a deliberately uniform brand voice must be able
  // to turn it off), so it ships as a default extra, not as core scaffold.
  extras:
    "Match the energy of what you're replying to: short and casual gets short and casual back. A brief, genuine reaction is a complete comment.",
};

/** The register fields the template gives a voice that sets none of its own
 *  — the ones a calibration may learn, and whose author `provenance` keeps. */
export const TEMPLATE_RULE_KEYS = Object.keys(DEFAULT_STYLE_RULES) as (keyof StyleRules)[];

/**
 * Who set one register field of a voice: the owner, a calibration that
 * learned it, or no one — a null field is Engager's start. A field set before
 * its author was kept reads as the owner's, which is what every write took it
 * for until then.
 */
export function ruleProvenance(
  styleRules: StyleRules | null | undefined,
  key: keyof StyleRules,
): "owner" | "learned" | null {
  if (styleRules?.[key] == null) return null;
  return styleRules.provenance?.[key] ?? "owner";
}

/** The lines of a free-text rules field (`StyleRules.extras`), as the writer
 *  reads them: one rule a line, without its bullet, none blank. */
export function ruleLines(extras: string | null | undefined): string[] {
  return (extras ?? "")
    .split("\n")
    .map((line) => line.trim().replace(/^-\s*/, ""))
    .filter(Boolean);
}

/** The starting rules an owner reads as how they write: where Engager starts
 *  every voice. */
export const STARTING_RULE_KEYS = [
  "emDashes",
  "semicolons",
  "emojiMax",
  "casing",
  "bannedOpeners",
] as const satisfies readonly (keyof ResolvedStyleRules)[];

export type StartingRuleKey = (typeof STARTING_RULE_KEYS)[number];

/**
 * How firmly a starting rule holds a draft, in the three words traits use
 * (`traitStrength`): a ban the lint enforces is firm, a cap the gate holds a
 * draft to is firm, casing is the writer's alone, and an allowance asks
 * nothing. Null for an empty opener list, which holds nothing.
 */
export function startingRuleStrength<K extends StartingRuleKey>(
  key: K,
  value: ResolvedStyleRules[K],
): "firm" | "guides" | "free" | null {
  switch (key) {
    case "emDashes":
    case "semicolons":
      return value === "forbid" ? "firm" : "free";
    case "emojiMax":
      return "firm";
    case "casing":
      return "guides";
    case "bannedOpeners":
      return (value as string[]).length > 0 ? "firm" : null;
  }
  return null;
}

/**
 * Per-field template fallback: null/absent fields inherit DEFAULT_STYLE_RULES.
 * Returns which fields the voice actually overrides (UI + trace honesty).
 */
export function resolveStyleRules(sr: StyleRules | null | undefined): {
  resolved: ResolvedStyleRules;
  overridden: (keyof StyleRules)[];
} {
  const overridden: (keyof StyleRules)[] = [];
  const resolved = { ...DEFAULT_STYLE_RULES };
  if (sr) {
    for (const key of TEMPLATE_RULE_KEYS) {
      const v = sr[key];
      if (v !== null && v !== undefined) {
        (resolved as Record<string, unknown>)[key] = v;
        overridden.push(key);
      }
    }
    // The template sets no traits: only the owner's own, which the measured
    // ones are laid under where a voice's samples are read (voice.ts).
    if (sr.traits && Object.keys(sr.traits).length > 0) {
      resolved.traits = sr.traits;
      overridden.push("traits");
    }
    // Neither does it say how the owner wants to sound: only the owner does.
    for (const key of ["ownWords", "writesTo"] as const) {
      const words = sr[key]?.trim();
      if (words) {
        resolved[key] = words;
        overridden.push(key);
      }
    }
    if (sr.avoidWords?.length) {
      resolved.avoidWords = sr.avoidWords;
      overridden.push("avoidWords");
    }
    // Nor knobs: a voice with none drafts at every default.
    if (sr.knobs && Object.keys(sr.knobs).length > 0) {
      resolved.knobs = sr.knobs;
      overridden.push("knobs");
    }
  }
  return { resolved: withAsideDashes(resolved, overridden), overridden };
}

/**
 * A voice whose asides are em dashes writes them: its `asideStyle`, measured
 * or set, lifts an em-dash ban it only inherits from the template. A rule the
 * owner set wins either way — under their ban an em-dash aside is not asked
 * for. Applied wherever traits reach the rules (here, and `withOwnerWriting`),
 * so the writer, the judge and the gate read one answer.
 */
export function withAsideDashes(
  rules: ResolvedStyleRules,
  overridden: readonly (keyof StyleRules)[],
): ResolvedStyleRules {
  if (rules.traits?.asideStyle !== "em_dash" || rules.emDashes === "allow") return rules;
  if (!overridden.includes("emDashes")) return { ...rules, emDashes: "allow" };
  const traits = { ...rules.traits };
  delete traits.asideStyle;
  return { ...rules, traits };
}

/**
 * Render the resolved rules into the writer's "YOUR REGISTER" prompt block.
 *
 * Omission semantics matter: an "allow" renders NO line (silence — the voice's
 * houseStyle governs), never an explicit "X is fine" that would push the model
 * toward the tell. Only restrictions and positive habits are spelled out.
 */
export function renderStyleRules(
  rules: ResolvedStyleRules,
  channel: "comment" | "reply",
): string {
  const lines: string[] = [];

  const punct: string[] = [];
  if (rules.emDashes === "forbid") punct.push("no em-dashes");
  if (rules.semicolons === "forbid") punct.push("no semicolons");
  if (punct.length > 0) {
    lines.push(
      `${punct.join(" and ").replace(/^no/, "No")}. A period or a comma reads more human.`,
    );
  }

  // A voice whose own writing carries an emoji is dealt it at its own rate
  // (`heldSignatures`), so "none is the norm" would be somebody else's norm.
  const emojiHabit =
    rules.traits?.signatures?.some((s) => /\p{Extended_Pictographic}/u.test(s.phrase)) === true;
  if (rules.emojiMax === 0) {
    lines.push("No emoji, ever.");
  } else if (rules.emojiMax === 1) {
    lines.push(
      `At most 1 emoji, and only when it genuinely fits.${emojiHabit ? "" : " Zero is the norm."}`,
    );
  } else {
    lines.push(
      `At most ${rules.emojiMax} emojis, and only when they genuinely fit.${emojiHabit ? "" : " Fewer is the norm."}`,
    );
  }

  switch (rules.casing) {
    case "sentence":
      lines.push('Normal sentence case. Do not lowercase as a shortcut to "casual".');
      break;
    case "lowercase":
      lines.push("Start lines lowercase — that's how you always type.");
      break;
    case "mirror":
      lines.push("Casing: follow YOUR WRITING STYLE above exactly.");
      break;
  }

  if (rules.bannedOpeners.length > 0) {
    const list = rules.bannedOpeners.map((o) => `"${o}"`).join(", ");
    lines.push(
      `NEVER open with formulaic praise: ${list} — or anything that could head any comment.`,
    );
  }

  // The owner's own list, held firm: the lint refuses a draft that uses one.
  if (rules.avoidWords?.length) {
    lines.push(`Never use: ${rules.avoidWords.map((w) => `"${w}"`).join(", ")}. The owner never does.`);
  }

  const target = channel === "reply" ? "the reply" : "the comment";
  switch (rules.closerQuestionPolicy) {
    case "natural":
      lines.push(
        `End with a question only when ${target} genuinely needs the answer — never tack one on by reflex, and never a limp closer ("Thoughts?", "What do you think?", "Curious to hear more", "Would love your take").`,
      );
      break;
    case "never":
      lines.push("Never end with a question — land a stance and stop.");
      break;
    case "encouraged":
      lines.push(
        "Prefer to end on a pointed question when it's genuinely invited — a real one about THEIR specific situation, never a reflex closer.",
      );
      break;
  }

  if (rules.shorthand === "allow") {
    lines.push("Shorthand (imo, tbh, w/, &) is fine where it fits how you write.");
  } else {
    lines.push("No shorthand — write words out in full (no imo/tbh/w//&).");
  }

  if (rules.roughEdges === "allow") {
    lines.push(
      "Don't be too perfect: an occasional rough edge — a fragment, a dropped comma — reads human. Never force errors or gibberish; flawless, tidy parallel grammar is the biggest AI tell.",
    );
  } else {
    lines.push(
      "Write complete, correctly punctuated sentences — no fragments, no dropped commas.",
    );
  }

  // Reply-only register: a reply is a conversation already in motion, not a
  // fresh comment performing for the feed — prompt-only direction, no lint
  // counterpart.
  if (channel === "reply") {
    lines.push(
      "When continuing an evidenced conversation, prefer answering directly without a hook or repeating introductions.",
      "Mirror their energy and length — a one-liner gets a one-liner back; never out-write them.",
    );
  }

  // How this owner actually writes — measured from their own comments or set
  // by them. Nothing renders for a voice with no traits.
  lines.push(...renderVoiceTraits(rules.traits));

  lines.push(...ruleLines(rules.extras));

  return (
    `YOUR REGISTER (inherited preferences; explicit step instructions can override):\n` +
    lines.map((l) => `- ${l}`).join("\n")
  );
}

export type StyleLintViolation = { rule: string; detail: string };

/** Grace over the prompt's emoji cap before the lint flags: the prompt says "at
 *  most N", the lint flags only at N+2 — mirrors the historical "max 1 in
 *  prompt, flag at >2" behavior. */
export const EMOJI_LINT_GRACE = 1;

/** How many leading characters the banned-opener check scans. */
export const OPENER_WINDOW = 40;

/**
 * The words the owner never uses, each found as a whole word anywhere in the
 * text and in any case: "Synergy." holds "synergy", "synergyx" does not. One
 * violation per word, quoting it.
 */
export function avoidWordViolations(
  text: string,
  avoidWords: readonly string[] | undefined,
): StyleLintViolation[] {
  return (avoidWords ?? [])
    .filter((word) => wholeWord(word).test(text))
    .map((word) => ({ rule: "avoid_word", detail: `"${word}" is a word the owner never uses` }));
}

/** `word` as a whole word in any case, any run of space between its words. */
export function wholeWord(word: string): RegExp {
  const pattern = word
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${pattern}(?![\\p{L}\\p{N}_])`, "iu");
}

/**
 * The banned opener the text starts on, past any leading quotes or space and
 * in any case, or null. Anchored, so a phrase later in the opening sentence
 * is not one.
 */
export function bannedOpenerIn(text: string, bannedOpeners: readonly string[]): string | null {
  const head = text.replace(/^["'“”‘’\s]+/, "").toLowerCase();
  return (
    bannedOpeners.find((o) => {
      const lo = o.toLowerCase();
      if (!head.startsWith(lo)) return false;
      // Require a word boundary after the opener so "Great post" does not match
      // "Great posture" ("post" being a prefix of "posture").
      const after = head[lo.length];
      return after === undefined || /\W/.test(after);
    }) ?? null
  );
}

/**
 * Deterministic, voice-aware register lint. Regex-only by construction (the
 * submit-intake path must stay LLM-free). Casing / shorthand / roughEdges /
 * closer policy are prompt-and-judge concerns — not reliably decidable in code,
 * so they are deliberately NOT linted. The voice's traits are: what the owner
 * does not do is checked by the detectors in ai/voiceTraits.ts.
 *
 * The INVARIANT floor (markdown, raw URLs) stays in `mechanicalViolations`
 * (ai/slop.ts) — this function only covers the rules a voice can flip.
 * `ownerStory` says the text tells one of the owner's documented stories.
 */
export function styleLint(
  text: string,
  rules: ResolvedStyleRules,
  opts: { ownerStory?: boolean } = {},
): StyleLintViolation[] {
  const v: StyleLintViolation[] = [...voiceTraitViolations(text, rules.traits, opts)];

  if (rules.emDashes === "forbid") {
    const n = (text.match(/—/g) ?? []).length;
    if (n > 0) v.push({ rule: "em_dash", detail: `${n} em-dash(es) — use a period or comma` });
  }
  if (rules.semicolons === "forbid" && /;/.test(text)) {
    v.push({ rule: "semicolon", detail: "semicolon — use a period or comma" });
  }

  const emoji = (text.match(/\p{Extended_Pictographic}/gu) ?? []).length;
  if (emoji > rules.emojiMax + EMOJI_LINT_GRACE) {
    v.push({
      rule: "emoji",
      detail: `${emoji} emojis — the voice allows at most ${rules.emojiMax}`,
    });
  }

  if (rules.bannedOpeners.length > 0) {
    const head = text.slice(0, OPENER_WINDOW).toLowerCase();
    const hit = rules.bannedOpeners.find((o) => head.includes(o.toLowerCase()));
    if (hit) {
      v.push({ rule: "sycophantic_opener", detail: `opens with banned phrase "${hit}"` });
    }
  }

  v.push(...avoidWordViolations(text, rules.avoidWords));
  return v;
}

/**
 * The HARD-GATEABLE subset of styleLint — used by the MCP intake gate to reject
 * a client draft (styleLint itself only warns). em-dash/semicolon/emoji and a
 * word the owner never uses are deterministic and trivially fixable, so they
 * gate as-is. Banned openers gate
 * ONLY when the phrase ANCHORS at the start of the text (after stripping leading
 * quotes/space) — the 40-char substring window styleLint uses is fine for a
 * warning but false-positives as a hard reject ("Great posture tips…" contains
 * "great post"). The agent received these exact rules in
 * get_drafting_context.outputRules.style, so a well-behaved client never trips it.
 */
export function styleLintGate(
  text: string,
  rules: ResolvedStyleRules,
  opts: { ownerStory?: boolean } = {},
): StyleLintViolation[] {
  const v: StyleLintViolation[] = [...voiceTraitViolations(text, rules.traits, opts)];

  if (rules.emDashes === "forbid") {
    const n = (text.match(/—/g) ?? []).length;
    if (n > 0) v.push({ rule: "em_dash", detail: `${n} em-dash(es) — use a period or comma` });
  }
  if (rules.semicolons === "forbid" && /;/.test(text)) {
    v.push({ rule: "semicolon", detail: "semicolon — use a period or comma" });
  }

  const emoji = (text.match(/\p{Extended_Pictographic}/gu) ?? []).length;
  if (emoji > rules.emojiMax + EMOJI_LINT_GRACE) {
    v.push({
      rule: "emoji",
      detail: `${emoji} emojis — the voice allows at most ${rules.emojiMax}`,
    });
  }

  const hit = bannedOpenerIn(text, rules.bannedOpeners);
  if (hit) {
    v.push({ rule: "sycophantic_opener", detail: `opens with banned phrase "${hit}"` });
  }

  v.push(...avoidWordViolations(text, rules.avoidWords));
  return v;
}
