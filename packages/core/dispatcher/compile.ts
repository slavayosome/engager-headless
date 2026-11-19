import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { compiledWritingRules } from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import type { LLM } from "../ai/client";
import { modelFor } from "../ai/modelFor";
import { DEFAULT_STYLE_TAXONOMY } from "../ai/promptDefaults";
import { avoidWordList, DEFAULT_STYLE_RULES } from "../ai/styleRules";
import { lengthSpecForTier } from "../ai/writer";
import { hashJson } from "../crypto";
import {
  CompiledRulesSchema,
  CONTENT_POLICIES,
  PLAN_HABITS,
  RuleConflictSchema,
  type CampaignRule,
  type CampaignRuleSource,
  type CompiledRules,
  type PlanHabit,
  type RuleConflict,
  type RuleSource,
  type VoiceChannel,
  type VoiceRule,
} from "./types";

/**
 * The draft dispatcher's COMPILE: one campaign's writing instructions for one
 * channel, merged into the rules every plan on that channel is made within.
 *
 * Code reads what is already structured: the voice's marks, habits, question
 * rate and policy, length, punctuation, register and word lists, each falling
 * back to Engager's starting rule where the voice has none. One model call
 * reads what is prose, the voice's notes and every campaign instruction, and
 * says which compiled field each one touches; it never decides who wins. Code
 * settles each field by authority and writes every disagreement it settled as
 * a sentence the owner reads. So a house style's "use :-) about every other
 * comment" and a step's "no emoticons" end as one answer, said once, rather
 * than as two lines of one prompt that the writer weighs one way and the
 * judge enforces the other.
 */

/** Bumped with any change to what a compile makes of its inputs, the
 *  prompt's or this code's, so no stored compile outlives its meaning. */
const COMPILE_PROMPT = "dispatcher.compile@2";

/** Who wins a compiled field, highest first. Any campaign instruction beats
 *  any voice rule: the voice speaks for every campaign, these for this one.
 *  Within the voice, what the owner said beats what their writing shows,
 *  which beats what a model read off it. */
const AUTHORITY: Record<RuleSource | CampaignRuleSource, number> = {
  step: 6,
  campaign_guidance: 5,
  learned_guidance: 4,
  tone: 4,
  owner: 3,
  brain: 3,
  learned: 2,
  // An inherited rule names the channel it is read from, not who set it
  // there, and what one channel reads from another is measured.
  inherited: 2,
  calibrated: 1,
  default: 0,
};

/** A voice with no length of its own writes the short tier, whose rule
 *  allows a fragment: no floor beyond a word. */
const DEFAULT_LENGTH = { minWords: 1, maxWords: lengthSpecForTier("short").maxWords };
/** A voice whose writing shows no question rate holds a batch to none, as
 *  drafting does without a question cap. */
const UNRATED_QUESTIONS = 1;

const ALLOW_FORBID = CompiledRulesSchema.shape.punctuation.shape.emDash.options;
const ASIDES = CompiledRulesSchema.shape.punctuation.shape.aside.unwrap().options;
const CASINGS = CompiledRulesSchema.shape.register.shape.casing.options;
const AXES = ["opening", "shape", "stance"] as const;

export type CompileInput = {
  channel: VoiceChannel;
  voiceRules: readonly VoiceRule[];
  campaignRules: readonly CampaignRule[];
};

export type CompiledWritingRules = { rules: CompiledRules; conflicts: RuleConflict[] };

type Source = RuleSource | CampaignRuleSource;
type Rule = { id: string; source: Source; text: string };
type Value = string | number | boolean | null;
type Props = Partial<Record<string, Value>>;
type ListField = "bannedOpeners" | "avoidWords";
type Axis = (typeof AXES)[number];
type AxisWeights = CompiledRules["structure"][Axis];
/** What one rule says of one compiled field: `props` as said, and `implied`
 *  as follows from them (a rated mark is allowed), which the rule's own
 *  explicit word overrides. */
type Spec =
  | { field: string; props: Props; implied?: Props }
  | { list: ListField; words: string[] }
  | { axis: Axis; weights: AxisWeights };
type Claim = { rule: Rule; props: Props; implied: Props; structured: boolean; order: number };

// ---------------------------------------------------------------------------
// The model's read of the prose.
// ---------------------------------------------------------------------------

/** The compiled fields an instruction can touch, as the compile's model
 *  names them. `marks.*` and `habits.*` take the mark or habit as `key`. */
export const COMPILE_EFFECT_FIELDS = [
  "marks.rate",
  "marks.allowed",
  "habits.rate",
  "habits.allowed",
  "question.rate",
  "question.must",
  "length.minWords",
  "length.maxWords",
  "punctuation.emDash",
  "punctuation.semicolon",
  "punctuation.aside",
  "register.register",
  "register.casing",
  "register.roughEdges",
  "register.shorthand",
  "emojiMax",
  "bannedOpeners.add",
  "avoidWords.add",
  "content.product",
  "content.link",
  "content.pitch",
] as const;

const CompileEffectSchema = z.object({
  ruleId: z.string().min(1),
  field: z.enum(COMPILE_EFFECT_FIELDS),
  key: z.string().max(60).optional(),
  value: z.string().min(1).max(200),
});
type CompileEffect = z.infer<typeof CompileEffectSchema>;

const CompileReadingSchema = z.object({
  effects: z.array(CompileEffectSchema),
  unmapped: z.array(z.object({ ruleId: z.string().min(1), text: z.string().min(1).max(600) })),
});
type CompileReading = z.infer<typeof CompileReadingSchema>;

const COMPILE_SYSTEM = `You compile the OWNER's own writing instructions for one campaign into structured rules. Every instruction below is theirs: a note on how their voice writes, or what this campaign asks of its drafts. None is a post or anyone else's words, and you are shown no post.

For each instruction, list the effects it has on these fields, citing its id. A value is always a string.
- marks.rate, key = the mark (e.g. ":-)"): the share of drafts that carry it, 0 to 1. "About every other comment" is 0.5.
- marks.allowed, key = the mark, or "*" for every mark the voice uses: "false" where the instruction forbids it, "true" where it expressly permits it.
- habits.rate, habits.allowed, key = eitherOrRate (a question that hands over two options; its rate is a share of the questions), adviceRate (volunteered advice: "I would…", "I'd…"), tagPhraseRate (a short tag as the reaction), colonRate (a clause set off with a colon mid-sentence) or exclamationRate (an exclamation mark).
- question.rate: the share of drafts that end on a question, 0 to 1.
- question.must: "ask" where every draft must ask a question, "never" where none may.
- length.minWords, length.maxWords: a whole number of words.
- punctuation.emDash, punctuation.semicolon: "allow" or "forbid".
- punctuation.aside: how an aside is set off: "spaced_hyphen", "em_dash", "parentheses" or "comma".
- register.register: one word for how formal it reads, e.g. "casual".
- register.casing: "sentence", "lowercase" or "mirror".
- register.roughEdges, register.shorthand: "allow" or "forbid".
- emojiMax: the most emoji one draft may carry, a whole number.
- bannedOpeners.add: one phrase a draft must never open with.
- avoidWords.add: one word or phrase a draft must never use.
- content.product, content.link, content.pitch: "never", "not_on_first_touch" (not in a first contact with someone, fine once you have talked) or "allowed".

Map only what an instruction says, never what it might imply. One instruction may have several effects ("no emoticons or links" has two) or none. Whatever part of it no field captures goes in unmapped, with its id and in the owner's words; an instruction with no effect at all goes there whole. Instructions may disagree: give each one's own effects anyway, since who wins is decided after you.`;

function compilePrompt(channel: VoiceChannel, prose: readonly Rule[], marks: readonly string[]): string {
  return [
    `CHANNEL: ${channel}`,
    `MARKS THE VOICE USES: ${marks.length > 0 ? marks.map((mark) => JSON.stringify(mark)).join(", ") : "none"}`,
    "INSTRUCTIONS:",
    ...prose.map((rule) => `- id: ${rule.id}\n  text: ${rule.text.replace(/\s+/gu, " ").trim()}`),
  ].join("\n");
}

async function readProse(
  llm: LLM,
  channel: VoiceChannel,
  prose: readonly Rule[],
  marks: readonly string[],
): Promise<CompileReading> {
  return CompileReadingSchema.parse(await llm.json({
    // Made once per revision of what the owner said, and binding on every
    // draft until they say something else: the tier the voice reads that
    // persist (`learn.voice`, `learn.structure`) are made at, not the
    // per-item classifier's.
    model: modelFor("writer"),
    stage: "dispatcher_compile",
    promptRef: COMPILE_PROMPT,
    schema: CompileReadingSchema,
    strict: true,
    system: COMPILE_SYSTEM,
    user: compilePrompt(channel, prose, marks),
    maxTokens: 400 + prose.length * 200,
  }));
}

// ---------------------------------------------------------------------------
// Rules and effects as specs on compiled fields.
// ---------------------------------------------------------------------------

const Rate = z.number().min(0).max(1);
const Phrases = z.union([z.string(), z.array(z.string())]).transform((v) => (typeof v === "string" ? [v] : v));
const Weights = z.array(z.object({ id: z.string().min(1), weight: z.number() }));

/** A key as bare letters, so "emDashes", "em_dash" and "em-dash" read alike. */
const letters = (key: string) => key.toLowerCase().replace(/[^a-z]/gu, "");

const habitNamed = (key: string): PlanHabit | undefined =>
  PLAN_HABITS.find((habit) => letters(habit) === letters(key) || letters(habit) === `${letters(key)}rate`);

const mustOf = (policy: string): "ask" | "never" | null =>
  policy === "ask" || policy === "never" ? policy : null;

/** One field's value of a structured rule, or none where it does not parse. */
function scalar(field: string | null, schema: z.ZodTypeAny, value: unknown): Spec[] | null {
  const parsed = field ? schema.safeParse(value) : null;
  return field && parsed?.success ? [{ field, props: { value: parsed.data as Value } }] : null;
}

const REGISTER_KEYS: Record<string, [string, z.ZodTypeAny]> = {
  register: ["register.register", z.string().min(1).nullable()],
  casing: ["register.casing", z.enum(CASINGS)],
  shorthand: ["register.shorthand", z.enum(ALLOW_FORBID)],
  roughedge: ["register.roughEdges", z.enum(ALLOW_FORBID)],
  roughedges: ["register.roughEdges", z.enum(ALLOW_FORBID)],
};

/** What a structured voice rule says of the compiled fields, by its kind and
 *  key; null for a rule no field holds, which reaches the planner as a note. */
function structuredSpecs(rule: VoiceRule): Spec[] | null {
  const key = letters(rule.key);
  const value = rule.value;
  switch (rule.kind) {
    case "mark": {
      const rate = Rate.safeParse(value);
      return rate.success ? [{ field: `marks.${rule.key}`, props: { rate: rate.data }, implied: { allowed: true } }] : null;
    }
    case "habit": {
      const habit = habitNamed(rule.key);
      const rate = Rate.safeParse(value);
      return habit && rate.success
        ? [{ field: `habits.${habit}`, props: { rate: rate.data }, implied: { allowed: true } }]
        : null;
    }
    case "question": {
      const rate = Rate.safeParse(value);
      if (rate.success) return [{ field: "question", props: { rate: rate.data } }];
      const policy = z.enum(["ask", "never", "natural", "encouraged"]).safeParse(value);
      return policy.success ? [{ field: "question", props: { must: mustOf(policy.data) } }] : null;
    }
    case "length": {
      const words = z.object({ min: z.number().int().positive(), max: z.number().int().positive() }).safeParse(value);
      return words.success && words.data.min <= words.data.max
        ? [{ field: "length", props: { minWords: words.data.min, maxWords: words.data.max } }]
        : null;
    }
    case "punctuation":
      return key.startsWith("emdash")
        ? scalar("punctuation.emDash", z.enum(ALLOW_FORBID), value)
        : key.startsWith("semicolon")
          ? scalar("punctuation.semicolon", z.enum(ALLOW_FORBID), value)
          : scalar(key.includes("aside") ? "punctuation.aside" : null, z.enum(ASIDES).nullable(), value);
    case "register": {
      const [field, schema] = REGISTER_KEYS[key] ?? [null, z.never()];
      return scalar(field, schema, value);
    }
    case "rough_edge":
      return scalar(key === "shorthand" ? "register.shorthand" : "register.roughEdges", z.enum(ALLOW_FORBID), value);
    case "emoji":
      return scalar("emojiMax", z.number().int().nonnegative(), value);
    case "opener_ban":
    case "avoid_word": {
      const words = Phrases.safeParse(value);
      return words.success ? [{ list: rule.kind === "opener_ban" ? "bannedOpeners" : "avoidWords", words: words.data }] : null;
    }
    case "structure": {
      const axis = AXES.find((name) => name === key);
      if (axis) {
        const weights = Weights.safeParse(value);
        return weights.success ? [{ axis, weights: weights.data }] : null;
      }
      const range = z.object({ opening: Weights, shape: Weights, stance: Weights }).partial().safeParse(value);
      return range.success
        ? AXES.flatMap((name) => (range.data[name] ? [{ axis: name, weights: range.data[name] }] : []))
        : null;
    }
    case "note":
      return null;
  }
}

const rateOf = (value: string): number | undefined => {
  const text = value.trim();
  if (!/^\d*\.?\d+%?$/u.test(text)) return undefined;
  const rate = text.endsWith("%") ? Number(text.slice(0, -1)) / 100 : Number(text);
  return rate <= 1 ? rate : undefined;
};
const wholeOf = (value: string, min: number): number | undefined =>
  /^\d+$/u.test(value.trim()) && Number(value) >= min ? Number(value) : undefined;
const flagOf = (value: string): boolean | undefined =>
  value.trim() === "true" ? true : value.trim() === "false" ? false : undefined;
const oneOf = (values: readonly string[]) => (value: string) => values.find((v) => v === value.trim());

/** The effects whose value is one field's whole value. */
const SCALAR_EFFECTS: Partial<Record<CompileEffect["field"], (value: string) => Value | undefined>> = {
  "punctuation.emDash": oneOf(ALLOW_FORBID),
  "punctuation.semicolon": oneOf(ALLOW_FORBID),
  "punctuation.aside": oneOf(ASIDES),
  "register.register": (value) => value.trim().toLowerCase() || undefined,
  "register.casing": oneOf(CASINGS),
  "register.roughEdges": oneOf(ALLOW_FORBID),
  "register.shorthand": oneOf(ALLOW_FORBID),
  emojiMax: (value) => wholeOf(value, 0),
  "content.product": oneOf(CONTENT_POLICIES),
  "content.link": oneOf(CONTENT_POLICIES),
  "content.pitch": oneOf(CONTENT_POLICIES),
};

/** What one effect the model read says of the compiled fields; none where its
 *  key or value does not parse. `marks` are the ones "*" stands for. */
function effectSpecs(effect: CompileEffect, marks: readonly string[]): Spec[] {
  const key = effect.key?.trim() ?? "";
  const { field, value } = effect;
  switch (field) {
    case "marks.rate": {
      const rate = rateOf(value);
      return key && key !== "*" && rate !== undefined
        ? [{ field: `marks.${key}`, props: { rate }, implied: { allowed: true } }]
        : [];
    }
    case "marks.allowed": {
      const allowed = flagOf(value);
      return allowed === undefined || !key
        ? []
        : (key === "*" ? marks : [key]).map((mark) => ({ field: `marks.${mark}`, props: { allowed } }));
    }
    case "habits.rate":
    case "habits.allowed": {
      const habit = PLAN_HABITS.find((name) => name === key);
      const said = field === "habits.rate" ? rateOf(value) : flagOf(value);
      if (!habit || said === undefined) return [];
      return field === "habits.rate"
        ? [{ field: `habits.${habit}`, props: { rate: said }, implied: { allowed: true } }]
        : [{ field: `habits.${habit}`, props: { allowed: said } }];
    }
    case "question.rate": {
      const rate = rateOf(value);
      return rate === undefined ? [] : [{ field: "question", props: { rate } }];
    }
    case "question.must": {
      const must = oneOf(["ask", "never"])(value);
      return must ? [{ field: "question", props: { must } }] : [];
    }
    case "length.minWords":
    case "length.maxWords": {
      const words = wholeOf(value, 1);
      return words === undefined ? [] : [{ field: "length", props: { [field.slice("length.".length)]: words } }];
    }
    case "bannedOpeners.add":
    case "avoidWords.add":
      return value.trim() ? [{ list: field === "bannedOpeners.add" ? "bannedOpeners" : "avoidWords", words: [value.trim()] }] : [];
    default: {
      const parsed = SCALAR_EFFECTS[field]?.(value);
      return parsed === undefined ? [] : [{ field, props: { value: parsed } }];
    }
  }
}

// ---------------------------------------------------------------------------
// Settling each field by authority.
// ---------------------------------------------------------------------------

const rank = (claim: Claim) => AUTHORITY[claim.rule.source];
/** Highest authority first; at one authority a structured value before prose,
 *  then the first said. */
const byAuthority = (a: Claim, b: Claim) =>
  rank(b) - rank(a) || Number(b.structured) - Number(a.structured) || a.order - b.order;
const said = (claim: Claim): Props => ({ ...claim.implied, ...claim.props });

/** Each field's value where no rule sets it: Engager's starting rules. */
const FALLBACK: Record<string, Props> = {
  question: { rate: UNRATED_QUESTIONS, must: mustOf(DEFAULT_STYLE_RULES.closerQuestionPolicy) },
  length: { ...DEFAULT_LENGTH },
  "punctuation.emDash": { value: DEFAULT_STYLE_RULES.emDashes },
  "punctuation.semicolon": { value: DEFAULT_STYLE_RULES.semicolons },
  "punctuation.aside": { value: null },
  "register.register": { value: null },
  "register.casing": { value: DEFAULT_STYLE_RULES.casing },
  "register.roughEdges": { value: DEFAULT_STYLE_RULES.roughEdges },
  "register.shorthand": { value: DEFAULT_STYLE_RULES.shorthand },
  emojiMax: { value: DEFAULT_STYLE_RULES.emojiMax },
  // No instruction narrows what a draft may bring up. Whether a product may
  // come up at all is the objective's gate, which a plan is made within.
  "content.product": { value: "allowed" },
  "content.link": { value: "allowed" },
  "content.pitch": { value: "allowed" },
};
const fallbackFor = (field: string): Props =>
  field.startsWith("marks.") || field.startsWith("habits.") ? { rate: 0, allowed: true } : (FALLBACK[field] ?? {});

/**
 * One field's value: each of its properties from the highest authority that
 * says it, else the fallback. A rule that said something else of it is a
 * conflict, won by whichever rule its value gave way to.
 */
function settle(
  field: string,
  claims: readonly Claim[],
  channel: VoiceChannel,
  conflicts: RuleConflict[],
): { props: Props; ruleIds: string[] } {
  const ranked = [...claims].sort(byAuthority);
  const props: Props = { ...fallbackFor(field) };
  const suppliers = new Map<string, Claim>();
  for (const claim of ranked) {
    for (const [prop, value] of Object.entries(said(claim))) {
      if (suppliers.has(prop)) continue;
      suppliers.set(prop, claim);
      props[prop] = value;
    }
  }
  if (field === "length" && Number(props.minWords) > Number(props.maxWords)) {
    // The bound said with more authority holds; the other gives way to it.
    const min = suppliers.get("minWords");
    const max = suppliers.get("maxWords");
    if (min && (!max || byAuthority(min, max) < 0)) props.maxWords = props.minWords;
    else props.minWords = props.maxWords;
  }
  const outcome = outcomeOf(field, props, channel);
  for (const loser of ranked) {
    const own = said(loser);
    const [winner] = Object.keys(own)
      .filter((prop) => suppliers.get(prop) !== loser && own[prop] !== props[prop])
      .map((prop) => suppliers.get(prop)!)
      .sort(byAuthority);
    if (winner) {
      conflicts.push({ field, winner: winner.rule.id, loser: loser.rule.id, sentence: conflictSentence(winner, loser, outcome, channel) });
    }
  }
  const ruleIds = [...new Set([...suppliers.values()].sort(byAuthority).map((claim) => claim.rule.id))];
  return { props, ruleIds };
}

// ---------------------------------------------------------------------------
// Conflicts in the owner's words.
// ---------------------------------------------------------------------------

const STEP_NAMES: Record<VoiceChannel, string> = { comment: "Comment", reply: "Reply", dm: "DM" };
const UNITS: Record<VoiceChannel, [string, string]> = {
  comment: ["comment", "comments"],
  reply: ["reply", "replies"],
  dm: ["message", "messages"],
};
const WINNERS: Record<Source, string> = {
  step: "The step",
  campaign_guidance: "The campaign guidance",
  learned_guidance: "Learned campaign guidance",
  tone: "The campaign preference",
  owner: "Your own setting",
  brain: "Your Brain",
  learned: "What your own writing shows",
  inherited: "What your own writing shows",
  calibrated: "The calibrated rule",
  default: "Engager's default",
};
export const HABIT_WORDS: Record<PlanHabit, string> = {
  eitherOrRate: "a question that hands over two options",
  adviceRate: "volunteered advice",
  tagPhraseRate: "a short tag as the reaction",
  colonRate: "a colon mid-sentence",
  exclamationRate: "an exclamation mark",
};
const ASIDE_WORDS: Record<string, string> = {
  spaced_hyphen: "a spaced hyphen",
  em_dash: "em dashes",
  parentheses: "parentheses",
  comma: "commas",
};
const CASING_WORDS: Record<string, string> = {
  sentence: "sentence case",
  lowercase: "lowercase",
  mirror: "as in your own writing",
};
const CONTENT_WORDS: Record<string, string> = { product: "the product", link: "a link", pitch: "a pitch" };
const POLICY_WORDS: Record<string, string> = {
  never: "never comes up",
  not_on_first_touch: "waits until after a first exchange",
  allowed: "may come up",
};

function speaker(source: Source, channel: VoiceChannel): string {
  switch (source) {
    case "step":
      return `Your ${STEP_NAMES[channel]} step says`;
    case "campaign_guidance":
      return "Your campaign guidance says";
    case "learned_guidance":
      return "Your learned campaign guidance says";
    case "tone":
      return "Your campaign preferences say";
    case "brain":
      return "Your Brain says";
    default:
      return "Your voice says";
  }
}

/** A rule's words as the middle of a sentence: no closing mark, no em dash,
 *  and its capital lowered unless it starts "I" or an acronym. */
function clause(text: string): string {
  const plain = text.trim().replace(/\s*[—–]\s*/gu, ", ").replace(/[\s.!;:,]+$/u, "");
  const first = /^[\p{L}'’]+/u.exec(plain)?.[0] ?? "";
  const keep = first === "I" || /^I['’]/u.test(first) || (first.length > 1 && first === first.toUpperCase());
  return keep ? plain : plain.charAt(0).toLowerCase() + plain.slice(1);
}

/** What a settled field now says, as the end of a conflict's sentence. */
function outcomeOf(field: string, props: Props, channel: VoiceChannel): string {
  const [unit, units] = UNITS[channel];
  const percent = (rate: Value | undefined) => `${Math.round(Number(rate) * 100)}%`;
  const fine = (value: Value | undefined) => (value === "allow" ? "fine" : "off");
  const dot = field.indexOf(".");
  const group = dot < 0 ? field : field.slice(0, dot);
  const key = field.slice(dot + 1);
  if (group === "marks") {
    return props.allowed === false ? `${key} is off` : `${key} goes in about ${percent(props.rate)} of ${units}`;
  }
  if (group === "habits") {
    const habit = HABIT_WORDS[key as PlanHabit];
    return props.allowed === false
      ? `${habit} is off`
      : `${habit} goes in about ${percent(props.rate)} of ${key === "eitherOrRate" ? "questions" : units}`;
  }
  if (group === "content") return `${CONTENT_WORDS[key]} ${POLICY_WORDS[String(props.value)]}`;
  switch (field) {
    case "question":
      return props.must === "ask"
        ? `every ${unit} asks a question`
        : props.must === "never"
          ? `no ${unit} ends on a question`
          : `about ${percent(props.rate)} of ${units} end on a question`;
    case "length":
      return `${units} run ${props.minWords} to ${props.maxWords} words`;
    case "punctuation.emDash":
      return `em dashes are ${fine(props.value)}`;
    case "punctuation.semicolon":
      return `semicolons are ${fine(props.value)}`;
    case "punctuation.aside":
      return props.value ? `asides are set off with ${ASIDE_WORDS[String(props.value)]}` : "asides are set off any way";
    case "register.register":
      return props.value ? `the register is ${props.value}` : "the register is open";
    case "register.casing":
      return `casing is ${CASING_WORDS[String(props.value)]}`;
    case "register.roughEdges":
      return `rough edges are ${fine(props.value)}`;
    case "register.shorthand":
      return `shorthand is ${fine(props.value)}`;
    default: // emojiMax
      return props.value === 0 ? "emoji are off" : `a ${unit} carries at most ${props.value} emoji`;
  }
}

function conflictSentence(winner: Claim, loser: Claim, outcome: string, channel: VoiceChannel): string {
  const stands = winner.structured
    ? winner.rule.source === "brain" ? "the one in your Brain" : "the one on your Voice page"
    : "the first one";
  const verdict = rank(winner) > rank(loser)
    ? `${WINNERS[winner.rule.source]} wins, so ${outcome} for this campaign.`
    : `Both carry the same weight, so ${stands} stands and ${outcome} for this campaign.`;
  return `${speaker(loser.rule.source, channel)} ${clause(loser.rule.text)}. ${speaker(winner.rule.source, channel)} ${clause(winner.rule.text)}. ${verdict}`;
}

// ---------------------------------------------------------------------------
// The compile.
// ---------------------------------------------------------------------------

function assemble(input: CompileInput, prose: readonly Rule[], reading: CompileReading): CompiledWritingRules {
  const claims = new Map<string, Claim[]>();
  const listed: { list: ListField; words: string[]; structured: boolean }[] = [];
  const axes: Partial<Record<Axis, { claim: Claim; weights: AxisWeights }>> = {};
  const notes: CompiledRules["notes"] = [];
  let order = 0;

  const note = (text: string, ruleId: string) => {
    const same = notes.find((n) => n.text === text);
    if (!same) notes.push({ text, ruleIds: [ruleId] });
    else if (!same.ruleIds.includes(ruleId)) same.ruleIds.push(ruleId);
  };
  const apply = (rule: Rule, spec: Spec, structured: boolean) => {
    if ("list" in spec) {
      listed.push({ list: spec.list, words: spec.words, structured });
      return;
    }
    // What the owner's writing shows is a habit, never a law: only the owner
    // and their campaigns make every comment ask, or none.
    if ("field" in spec && spec.field === "question" && "must" in spec.props && AUTHORITY[rule.source] < AUTHORITY.owner) {
      const { must: _must, ...rest } = spec.props;
      if (Object.keys(rest).length === 0) return;
      spec = { ...spec, props: rest };
    }
    const claim: Claim = { rule, props: {}, implied: {}, structured, order: order++ };
    if ("axis" in spec) {
      const best = axes[spec.axis];
      if (!best || byAuthority(claim, best.claim) < 0) axes[spec.axis] = { claim, weights: spec.weights };
      return;
    }
    // One rule says one thing of a field: its effects on it are one claim,
    // and what it says outright beats what follows from another of them.
    const onField = claims.get(spec.field) ?? [];
    const own = onField.find((c) => c.rule.id === rule.id);
    if (own) {
      Object.assign(own.props, spec.props);
      Object.assign(own.implied, spec.implied);
    } else {
      onField.push({ ...claim, props: { ...spec.props }, implied: { ...spec.implied } });
      claims.set(spec.field, onField);
    }
  };

  for (const rule of input.voiceRules) {
    if (rule.kind === "note") continue;
    const specs = structuredSpecs(rule);
    if (specs) for (const spec of specs) apply(rule, spec, true);
    else note(rule.text, rule.id);
  }

  const effects = new Map<string, CompileEffect[]>();
  for (const effect of reading.effects) effects.set(effect.ruleId, [...(effects.get(effect.ruleId) ?? []), effect]);
  // What "every mark" stands for: the voice's, and any an instruction rates.
  const everyMark = [...new Set([
    ...[...claims.keys()].filter((field) => field.startsWith("marks.")).map((field) => field.slice("marks.".length)),
    ...reading.effects.flatMap((e) => (e.field === "marks.rate" && e.key && e.key !== "*" ? [e.key.trim()] : [])),
  ])];
  // Freeze enforcement: an effect or a note counts only for a prose rule
  // handed in; one cited to any other id is dropped.
  for (const rule of prose) {
    const specs = (effects.get(rule.id) ?? []).flatMap((effect) => effectSpecs(effect, everyMark));
    for (const spec of specs) apply(rule, spec, false);
    const left = reading.unmapped.filter((u) => u.ruleId === rule.id);
    for (const part of left) note(part.text, rule.id);
    // An instruction nothing captured still reaches the planner, whole.
    if (specs.length === 0 && left.length === 0) note(rule.text, rule.id);
  }

  const conflicts: RuleConflict[] = [];
  const settled = (field: string) => settle(field, claims.get(field) ?? [], input.channel, conflicts);
  const rated = (prefix: "marks." | "habits.") =>
    Object.fromEntries([...claims.keys()].filter((field) => field.startsWith(prefix)).map((field) => {
      const { props, ruleIds } = settled(field);
      return [field.slice(prefix.length), { rate: props.rate, allowed: props.allowed, ruleIds }];
    }));
  const grouped = (group: string, keys: readonly string[]) => {
    const fields = keys.map((key) => [key, settled(`${group}.${key}`)] as const);
    return {
      ...Object.fromEntries(fields.map(([key, s]) => [key, s.props.value])),
      ruleIds: [...new Set(fields.flatMap(([, s]) => s.ruleIds))],
    };
  };
  const phrases = (list: ListField, defaults: readonly string[]) => {
    const said = listed.filter((l) => l.list === list);
    const voice = said.filter((l) => l.structured);
    return avoidWordList([
      ...(voice.length > 0 ? voice.flatMap((l) => l.words) : defaults),
      ...said.filter((l) => !l.structured).flatMap((l) => l.words),
    ]);
  };

  const marks = rated("marks.");
  const habits = rated("habits.");
  const question = settled("question");
  const length = settled("length");
  const rules = CompiledRulesSchema.parse({
    channel: input.channel,
    voiceId: input.voiceRules[0]?.voiceId ?? null,
    marks,
    habits,
    question: { rate: question.props.rate, must: question.props.must, ruleIds: question.ruleIds },
    length: { minWords: length.props.minWords, maxWords: length.props.maxWords, ruleIds: length.ruleIds },
    punctuation: grouped("punctuation", ["emDash", "semicolon", "aside"]),
    register: grouped("register", ["register", "casing", "roughEdges", "shorthand"]),
    emojiMax: settled("emojiMax").props.value,
    bannedOpeners: phrases("bannedOpeners", DEFAULT_STYLE_RULES.bannedOpeners),
    avoidWords: phrases("avoidWords", []),
    structure: Object.fromEntries(AXES.map((axis) => [
      axis,
      axes[axis]?.weights ?? DEFAULT_STYLE_TAXONOMY[axis].map((style) => ({ id: style.id, weight: 1 })),
    ])),
    content: grouped("content", ["product", "link", "pitch"]),
    notes,
  });
  return { rules, conflicts };
}

/** A voice's rules as one channel is written by: a voice's rules come for
 *  every channel, and another channel's must never reach this compile or its
 *  revision. */
function forChannel(input: CompileInput): CompileInput {
  return { ...input, voiceRules: input.voiceRules.filter((rule) => rule.channel === input.channel) };
}

/** What only a model can read: the voice's notes and every campaign
 *  instruction. */
const proseOf = (input: CompileInput): Rule[] => [
  ...input.voiceRules.filter((rule) => rule.kind === "note"),
  ...input.campaignRules,
];

/**
 * Compile one campaign's rules for one channel. A model reads the prose only
 * where there is some: a voice with no notes and a campaign with no
 * instructions compile in code alone.
 */
export async function compileRules(llm: LLM, whole: CompileInput): Promise<CompiledWritingRules> {
  const input = forChannel(whole);
  const prose = proseOf(input);
  const marks = input.voiceRules.filter((rule) => rule.kind === "mark").map((rule) => rule.key);
  const reading = prose.length > 0
    ? await readProse(llm, input.channel, prose, marks)
    : { effects: [], unmapped: [] };
  return assemble(input, prose, reading);
}

/**
 * The revision of a compile's inputs: a hash of what the compile reads of
 * them and its own version, so unchanged inputs name the compile already
 * stored and any change compiles anew. A rule's detail (when it was measured,
 * from how many texts) is not read, so re-measuring an unchanged rate keeps
 * the compile.
 */
export function writingRulesRevision(whole: CompileInput): string {
  const input = forChannel(whole);
  return hashJson({
    compile: COMPILE_PROMPT,
    channel: input.channel,
    voiceRules: input.voiceRules.map(({ id, voiceId, kind, key, value, source, text }) =>
      ({ id, voiceId, kind, key, value, source, text })),
    campaignRules: input.campaignRules.map(({ id, source, text }) => ({ id, source, text })),
  });
}

const ConflictsSchema = z.array(RuleConflictSchema);

/**
 * The compile for one campaign and channel at its inputs' revision: read in a
 * short transaction, or compiled with no connection held across the model
 * call and stored in another. Two runs racing on one revision store one row,
 * and both read it.
 */
export async function compiledRulesFor(
  organizationId: string,
  llm: LLM,
  input: CompileInput & { campaignId: number },
): Promise<CompiledWritingRules & { revision: string }> {
  const revision = writingRulesRevision(input);
  const read = async (tx: Tx) => {
    const [row] = await tx
      .select()
      .from(compiledWritingRules)
      .where(and(
        eq(compiledWritingRules.campaignId, input.campaignId),
        eq(compiledWritingRules.channel, input.channel),
        eq(compiledWritingRules.revision, revision),
      ))
      .limit(1);
    return row
      ? { revision, rules: CompiledRulesSchema.parse(row.rules), conflicts: ConflictsSchema.parse(row.conflicts) }
      : null;
  };

  // ---- stored compile (short tx) ------------------------------------------
  const stored = await withOrg(organizationId, read);
  if (stored) return stored;

  // ---- compile, NO connection held ----------------------------------------
  const compiled = await compileRules(llm, input);

  // ---- store (short tx) ---------------------------------------------------
  return withOrg(organizationId, async (tx) => {
    await tx
      .insert(compiledWritingRules)
      .values({
        campaignId: input.campaignId,
        channel: input.channel,
        revision,
        rules: compiled.rules,
        conflicts: compiled.conflicts,
      })
      .onConflictDoNothing({
        target: [
          compiledWritingRules.organizationId,
          compiledWritingRules.campaignId,
          compiledWritingRules.channel,
          compiledWritingRules.revision,
        ],
      });
    return (await read(tx))!;
  });
}

/**
 * The compile a draft the owner is waiting on is planned by, with no compile
 * in its way. The one at its inputs' revision where it is stored. Else the
 * newest stored for the campaign and channel, every instruction of the
 * owner's it keeps no note of added as a note of its own, raw, while the
 * compile at the new revision is made in the background for the next draft.
 * Only where none was ever stored is it compiled here. The revision is the
 * inputs' own either way: the instructions the draft was asked under.
 */
export async function compiledRulesAtHand(
  organizationId: string,
  llm: LLM,
  input: CompileInput & { campaignId: number },
): Promise<CompiledWritingRules & { revision: string }> {
  const revision = writingRulesRevision(input);
  const [row] = await withOrg(organizationId, (tx) =>
    tx
      .select()
      .from(compiledWritingRules)
      .where(and(eq(compiledWritingRules.campaignId, input.campaignId), eq(compiledWritingRules.channel, input.channel)))
      .orderBy(sql`${compiledWritingRules.revision} = ${revision} desc`, desc(compiledWritingRules.compiledAt), desc(compiledWritingRules.id))
      .limit(1),
  );
  if (!row) return compiledRulesFor(organizationId, llm, input);
  const rules = CompiledRulesSchema.parse(row.rules);
  const conflicts = ConflictsSchema.parse(row.conflicts);
  if (row.revision === revision) return { revision, rules, conflicts };
  void compiledRulesFor(organizationId, llm, input).catch((error: unknown) => {
    console.error("[dispatcher] compiling changed writing rules failed:", error instanceof Error ? error.message : error);
  });
  const noted = new Set(rules.notes.map((note) => note.text));
  const raw = proseOf(forChannel(input))
    .filter((rule) => !noted.has(rule.text))
    .map((rule) => ({ text: rule.text, ruleIds: [rule.id] }));
  return { revision, rules: { ...rules, notes: [...rules.notes, ...raw] }, conflicts };
}
