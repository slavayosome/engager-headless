import type {
  Campaign,
  LearnedEdit,
  ResolvedStyleRules,
  StyleRules,
  SurfaceVoice,
  Voice,
  VoiceTraits,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { resolveStyleRules, ruleLines, ruleProvenance, withAsideDashes } from "../ai/styleRules";
import { avoidance, resolveVoiceTraits, traitProvenance, type TraitKey } from "../ai/voiceTraits";
import { draftingVoiceId } from "../strategy/draftingVoice";
import { brainWritingPreferences, savedStrategy } from "../strategy/writingInstructions";
import type { KnowledgeRetrievalSnapshot } from "../brain/knowledge";
import { blendRanges, type BlendedAxis } from "../learning/styleVariety";
import {
  addsMarks,
  channelOwnerSets,
  DEFAULT_VOICE_TEMPLATE,
  getVoiceForCampaign,
  hasWords,
  ownerTraitsFor,
  readOwnerWriting,
  UNMATERIALISED_DEFAULT_VOICE,
  type OwnerWriting,
} from "../voice";
import { activeDirectives } from "../voice/habits";
import {
  PLAN_HABITS,
  VOICE_CHANNELS,
  type PlanHabit,
  type RuleSource,
  type VoiceChannel,
  type VoiceRule,
  type VoiceRuleKind,
} from "./types";

/**
 * A VOICE AS ITS RULES: every choice a voice makes about a draft, one rule
 * each, with where it came from, so a plan can cite the rule behind each of
 * its choices and the owner can read why.
 *
 * Derived, never stored. More than twenty paths write the voice row, and a
 * second copy of it would drift; the rules are read off the row and the
 * owner's own writing on every read, through the helpers drafting resolves a
 * voice with. An id is `<channel>.<kind>.<key>` and names the same rule on
 * every read.
 */

/** What of a voice row its rules are read from. */
export type RuleVoice = Pick<
  Voice,
  "id" | "name" | "channels" | "styleRules" | "structuralRange" | "learnedDirectives" | "disabledDirectives"
>;

export type VoiceRuleInputs = {
  /** Null where the drafts are written in the built-in template. */
  voice: RuleVoice | null;
  /** What the owner's own texts show, channel by channel (`readOwnerWriting`). */
  measured: OwnerWriting["measured"];
  /** The writing preferences the owner keeps in the Brain, one a line
   *  (`brainWritingPreferences`). */
  brainPreferences?: string;
};

export type CampaignVoiceRules = { voiceId: number | null; voiceName: string; rules: VoiceRule[] };

/** Where one rule came from, and how its sentence says so. */
type Origin = { source: RuleSource; detail: VoiceRule["detail"]; says: string };

type Add = (kind: VoiceRuleKind, key: string, value: unknown, origin: Origin, statement: string) => void;

type Noun = { one: string; many: string };

const NOUNS: Record<VoiceChannel, Noun> = {
  comment: { one: "comment", many: "comments" },
  reply: { one: "reply", many: "replies" },
  dm: { one: "DM", many: "DMs" },
};
const SAMPLES: Noun = { one: "sample of your writing", many: "samples of your writing" };
const TEXTS: Noun = { one: "text", many: "texts" };

const OWNER: Origin = { source: "owner", detail: {}, says: "set by you" };
const DEFAULT: Origin = { source: "default", detail: {}, says: "Engager's default" };
const BRAIN: Origin = { source: "brain", detail: {}, says: "from your Brain" };
/** A register field a calibration model set from the owner's writing
 *  (`mergeLearnedStyleRules`): read by a model, not measured, so no count. */
const CALIBRATED: Origin = { source: "calibrated", detail: {}, says: "calibrated from your writing" };

const counted = (count: number, noun: Noun) => `${count} ${count === 1 ? noun.one : noun.many}`;
const percent = (rate: number) => `${Math.round(rate * 100)}%`;
const quoted = (words: readonly string[]) => words.map((word) => `"${word}"`).join(", ");

/** Measured from the owner's texts, with how many. */
function learned(evidence: { count: number; noun: Noun }): Origin {
  return {
    source: "learned",
    detail: { count: evidence.count },
    says: `learned from ${counted(evidence.count, evidence.noun)}`,
  };
}

function inherited(channel: VoiceChannel): Origin {
  return {
    source: "inherited",
    detail: { from: "comment" },
    says: `your ${NOUNS[channel].many} follow your comments`,
  };
}

/** A habit from the owner's rewrites of drafts, counted in the saves it
 *  showed in. */
function edited(edit: LearnedEdit): Origin {
  return {
    source: "learned",
    detail: { count: edit.seen, ...(edit.firstAppliedAt === undefined ? {} : { at: edit.firstAppliedAt }) },
    says: `seen in ${edit.seen} of your recent edits`,
  };
}

/** Who wrote a channel's description: the owner by hand, or a calibration
 *  that read their writing. */
function describedBy(words: SurfaceVoice): Origin {
  if (words.sources.includes("manual")) return { ...OWNER, detail: { at: words.updatedAt } };
  return {
    source: "calibrated",
    detail: { count: words.learnedFrom, at: words.updatedAt },
    says:
      words.learnedFrom > 0
        ? `calibrated from ${counted(words.learnedFrom, SAMPLES)}`
        : "calibrated from your writing",
  };
}

/** Who set one register field the template would otherwise give. */
function fieldOrigin(styleRules: StyleRules | null | undefined, key: keyof StyleRules): Origin {
  switch (ruleProvenance(styleRules, key)) {
    case "owner":
      return OWNER;
    case "learned":
      return CALIBRATED;
    case null:
      return DEFAULT;
  }
}

/**
 * The traits one channel is written by (`withOwnerWriting`), and where each
 * came from: set by the owner for this channel; taken from Comment, as what
 * was set for comments or as what they show while the channel has too few
 * texts of its own; or measured from the owner's texts in this channel.
 */
function channelTraits(
  styleRules: StyleRules | null | undefined,
  measured: OwnerWriting["measured"],
  channel: VoiceChannel,
): { traits: VoiceTraits; origin: (key: TraitKey) => Origin } {
  const follows = measured[channel] == null;
  const evidence = measured[channel] ?? measured.comment;
  const set = ownerTraitsFor(styleRules, channel, follows);
  const { own } = channelOwnerSets(styleRules, channel, follows);
  const by = traitProvenance(evidence?.traits, set);
  const origin = (key: TraitKey): Origin => {
    if (by[key] === "owner") return own?.[key] != null ? OWNER : inherited(channel);
    if (channel !== "comment" && follows) return inherited(channel);
    return learned({ count: evidence?.samples ?? 0, noun: NOUNS[channel] });
  };
  return { traits: resolveVoiceTraits(evidence, set), origin };
}

/** "About 30% of your comments ask a question", or "None of" them at zero. */
function share(rate: number, whose: string, verb: string): string {
  return rate === 0 ? `None of ${whose} ${verb}` : `About ${percent(rate)} of ${whose} ${verb}`;
}

const HABIT_VERBS: Record<PlanHabit, string> = {
  eitherOrRate: "offer two options to pick from",
  adviceRate: "volunteer advice",
  tagPhraseRate: "end a sentence on a short tag",
  colonRate: "set a clause off with a colon",
  exclamationRate: "use an exclamation mark",
};

const ASIDES = {
  spaced_hyphen: "with a spaced hyphen",
  em_dash: "with an em dash",
  parentheses: "in parentheses",
  comma: "with commas",
} as const;

const CASINGS = {
  sentence: "Normal sentence case",
  lowercase: "Lines start lowercase",
  mirror: "Casing follows your description exactly",
} as const;

const QUESTION_POLICIES = {
  natural: "End on a question only when the answer is genuinely needed",
  never: "Never end on a question",
  encouraged: "End on a pointed question when the post invites one",
} as const;

/** A learned edit as the owner reads it. Null where the writer is told
 *  nothing of it either (`learnedEditsBlock`). */
function editStatement(edit: LearnedEdit, channel: VoiceChannel): string | null {
  const { one, many } = NOUNS[channel];
  const values = quoted(edit.values ?? []);
  switch (edit.kind) {
    case "question_first":
      return "You lead with the question when you ask something";
    case "no_self_intro":
      return "You cut a draft's introduction of yourself";
    case "softeners":
      return values ? `You open a sentence your own way, like ${values}, at most once per ${one}` : null;
    case "emoticons":
      return values ? `You add ${values} to your ${many}` : null;
    case "dropped_apostrophes":
      return `You write about ${percent(edit.rate ?? 0)} of contractions without the apostrophe`;
    case "typos":
      return `You leave about ${edit.rate ?? 0} small slips per 100 words`;
    case "shorter":
      return `You cut drafts about ${percent(edit.rate ?? 0)} shorter`;
    case "longer":
      return `You make drafts about ${percent(edit.rate ?? 0)} longer`;
    case "no_owner_story":
      return "You take your own stories out of a draft unless asked for one";
    case "no_closing_question":
      return "You cut the closing question a draft ends on";
    case "no_advice":
      return "You take out the advice a draft volunteers";
    case "no_tag_phrase":
      return "You cut the short tag a draft sets off at the end of a sentence";
    case "own_opener":
      return values ? `You open in your own words, like ${values}, not the way a draft would` : null;
  }
}

/** The description a channel is written with: its own words, else, for a
 *  reply or a DM, Comment's (`resolveVoiceV2`). */
function addDescription(add: Add, voice: RuleVoice | null, channel: VoiceChannel): void {
  const own = voice?.channels?.[channel];
  const comment = voice?.channels?.comment;
  const described =
    own && hasWords(own)
      ? { words: own, origin: describedBy(own) }
      : channel !== "comment" && comment && hasWords(comment)
        ? { words: comment, origin: inherited(channel) }
        : null;
  if (!described) return;
  const { words, origin } = described;
  const persona = words.persona?.trim();
  if (persona) add("note", "persona", persona, origin, `Your description: ${persona}`);
  ruleLines(words.houseStyle).forEach((line, i) => add("note", `house_style.${i + 1}`, line, origin, line));
}

/**
 * The register fields, as one channel is written under them. `beforeAsides`
 * is the voice's em-dash rule before the channel's traits reached it: a ban
 * the voice only inherits is lifted by an em-dash aside, and the aside is
 * then where the rule came from.
 */
function addRegister(
  add: Add,
  style: ResolvedStyleRules,
  beforeAsides: ResolvedStyleRules["emDashes"],
  field: (key: keyof StyleRules) => Origin,
  traitOrigin: (key: TraitKey) => Origin,
  marksEdit: LearnedEdit | undefined,
): void {
  const lifted = style.emDashes !== beforeAsides;
  add(
    "punctuation",
    "em_dash",
    style.emDashes,
    lifted ? traitOrigin("asideStyle") : field("emDashes"),
    style.emDashes === "forbid"
      ? "No em dashes"
      : lifted
        ? "Em dashes are allowed, since you set asides off with them"
        : "Em dashes are allowed",
  );
  add(
    "punctuation",
    "semicolon",
    style.semicolons,
    field("semicolons"),
    style.semicolons === "forbid" ? "No semicolons" : "Semicolons are allowed",
  );
  if (marksEdit) {
    add("emoji", "max", 1, edited(marksEdit), "At most 1 emoji, since your edits add them");
  } else {
    const max = style.emojiMax;
    add("emoji", "max", max, field("emojiMax"), max === 0 ? "No emoji" : `At most ${max} ${max === 1 ? "emoji" : "emojis"}`);
  }
  add("register", "casing", style.casing, field("casing"), CASINGS[style.casing]);
  add(
    "opener_ban",
    "openers",
    style.bannedOpeners,
    field("bannedOpeners"),
    style.bannedOpeners.length > 0 ? `Never open with ${quoted(style.bannedOpeners)}` : "No opener is ruled out",
  );
  add(
    "question",
    "policy",
    style.closerQuestionPolicy,
    field("closerQuestionPolicy"),
    QUESTION_POLICIES[style.closerQuestionPolicy],
  );
  add(
    "rough_edge",
    "shorthand",
    style.shorthand,
    field("shorthand"),
    style.shorthand === "allow" ? "Shorthand like imo or tbh is fine" : "No shorthand, every word written out",
  );
  add(
    "rough_edge",
    "rough_edges",
    style.roughEdges,
    field("roughEdges"),
    style.roughEdges === "allow"
      ? "An occasional rough edge, like a fragment or a dropped comma, is fine"
      : "Complete, correctly punctuated sentences",
  );
  const extras = ruleLines(style.extras);
  if (extras.length > 0) add("note", "extras", extras.join("\n"), field("extras"), extras.join(" "));
  if (style.ownWords) {
    add("note", "own_words", style.ownWords, OWNER, `How you want to sound, in your words: ${style.ownWords}`);
  }
  if (style.writesTo) add("note", "writes_to", style.writesTo, OWNER, `You write to ${style.writesTo}`);
  if (style.avoidWords?.length) {
    add("avoid_word", "words", style.avoidWords, OWNER, `Never use ${quoted(style.avoidWords)}`);
  }
}

/** How the owner writes in one channel: each trait, its sentence naming the
 *  channel it was read off. */
function addTraits(
  add: Add,
  traits: VoiceTraits,
  channel: VoiceChannel,
  traitOrigin: (key: TraitKey) => Origin,
): void {
  // A trait taken from Comment describes the owner's comments.
  const about = (key: TraitKey) => {
    const origin = traitOrigin(key);
    return { origin, noun: NOUNS[origin.source === "inherited" ? "comment" : channel].many };
  };
  const note = (key: TraitKey, statement: (noun: string) => string) => {
    const { origin, noun } = about(key);
    const words = statement(noun);
    add("note", key, words, origin, words);
  };
  const { lengthWords, register, questionRate, signatures, asideStyle, openers, closers } = traits;

  if (lengthWords) {
    const { origin, noun } = about("lengthWords");
    add("length", "words", lengthWords, origin, `Most of your ${noun} run ${lengthWords.min} to ${lengthWords.max} words`);
  }
  if (register) {
    const { origin, noun } = about("register");
    add("register", "register", register, origin, `Your ${noun} read ${register}`);
  }
  if (questionRate !== undefined) {
    const { origin, noun } = about("questionRate");
    add("question", "rate", questionRate, origin, share(questionRate, `your ${noun}`, "ask a question"));
  }
  for (const habit of PLAN_HABITS) {
    const rate = traits[habit];
    if (rate === undefined) continue;
    // None of it in too little of the owner's writing only leans away from a
    // habit, so a plan is not told the owner never has it: it stays unrated.
    if (habit !== "exclamationRate" && avoidance(traits, habit) === "leans") continue;
    const { origin, noun } = about(habit);
    const whose = habit === "eitherOrRate" ? `the questions in your ${noun}` : `your ${noun}`;
    add("habit", habit, rate, origin, share(rate, whose, HABIT_VERBS[habit]));
  }
  if (signatures) {
    const { origin, noun } = about("signatures");
    const seen = new Set<string>();
    for (const { phrase, rate } of signatures) {
      if (seen.has(phrase)) continue;
      seen.add(phrase);
      const statement =
        rate === 0 ? `None of your ${noun} use ${phrase}` : `You use ${phrase} in about ${percent(rate)} of your ${noun}`;
      add("mark", phrase, rate, origin, statement);
    }
  }
  if (asideStyle) {
    add("punctuation", "aside", asideStyle, traitOrigin("asideStyle"), `You set an aside off ${ASIDES[asideStyle]}`);
  }
  if (openers?.length) note("openers", (noun) => `You often open your ${noun} with ${quoted(openers)}`);
  if (closers?.length) note("closers", (noun) => `You often end your ${noun} with ${quoted(closers)}`);
  const { bareEndingRate, specificityRate, movesPerComment } = traits;
  if (bareEndingRate !== undefined) {
    note("bareEndingRate", (noun) => share(bareEndingRate, `your ${noun}`, "leave the last full stop off"));
  }
  if (specificityRate !== undefined) {
    note("specificityRate", (noun) =>
      share(specificityRate, `your ${noun}`, "name a figure, a product, a tool or a company"),
    );
  }
  if (movesPerComment !== undefined) {
    const moves = Math.round(movesPerComment * 10) / 10;
    note(
      "movesPerComment",
      (noun) =>
        `Your ${noun} make about ${moves} ${moves === 1 ? "move" : "moves"} each, counting a question or a piece of advice as one`,
    );
  }
}

const weights = (axis: BlendedAxis[]) => axis.map(({ id, weight }) => ({ id, weight }));

/**
 * Every rule of a voice, for comments, replies and DMs. Pure. The register
 * fields are the voice's own and hold every channel; the traits, the
 * description and the learned edits are each channel's, a reply or a DM
 * reading Comment's where it has none of its own.
 */
export function deriveVoiceRules({ voice, measured, brainPreferences }: VoiceRuleInputs): VoiceRule[] {
  const styleRules = voice?.styleRules;
  // Traits are laid on channel by channel below, where an em-dash aside
  // lifts a ban the voice only inherits (`withAsideDashes`).
  const base = resolveStyleRules(styleRules ? { ...styleRules, traits: null } : null);
  const field = (key: keyof StyleRules) => fieldOrigin(styleRules, key);
  // A voice whose own saves add marks may use one whatever its register says
  // (`resolveVoiceV2`).
  const marksEdit =
    voice && addsMarks(voice) && base.resolved.emojiMax === 0
      ? voice.learnedDirectives?.directives.find((edit) => edit.kind === "emoticons")
      : undefined;
  const range = voice?.structuralRange;
  const learnedRange = range && (range.learnedFrom ?? 0) > 0 ? range : null;
  const blended = blendRanges(learnedRange);
  const axes = { opening: weights(blended.opening), shape: weights(blended.shape), stance: weights(blended.stance) };

  return VOICE_CHANNELS.flatMap((channel) => {
    const rules: VoiceRule[] = [];
    const add: Add = (kind, key, value, origin, statement) => {
      rules.push({
        id: `${channel}.${kind}.${key}`,
        voiceId: voice?.id ?? null,
        voiceName: voice?.name ?? DEFAULT_VOICE_TEMPLATE.name,
        channel,
        kind,
        key,
        value,
        source: origin.source,
        detail: { ...origin.detail },
        text: `${statement} (${origin.says})`,
      });
    };
    const { traits, origin: traitOrigin } = channelTraits(styleRules, measured, channel);
    const style = withAsideDashes({ ...base.resolved, traits }, base.overridden);

    addDescription(add, voice, channel);
    addRegister(add, style, base.resolved.emDashes, field, traitOrigin, marksEdit);
    addTraits(add, style.traits ?? {}, channel, traitOrigin);
    add(
      "structure",
      "axes",
      axes,
      learnedRange ? learned({ count: learnedRange.learnedFrom ?? 0, noun: TEXTS }) : DEFAULT,
      learnedRange
        ? "Drafts open, take a shape and take a stance the ways you do, with Engager's other ways kept in the mix"
        : "Drafts rotate evenly over Engager's ways to open, shape and take a stance",
    );
    for (const edit of activeDirectives(voice, channel)) {
      const statement = editStatement(edit, channel);
      if (statement) add("note", `edit.${edit.kind}`, statement, edited(edit), statement);
    }
    ruleLines(brainPreferences).forEach((line, i) => add("note", `brain.${i + 1}`, line, BRAIN, line));
    return rules;
  });
}

/**
 * The rules of the voice a campaign's drafts are written in, found the way
 * drafting finds it (`resolveSavedWritingVoice`): its saved strategy's own
 * voice, else the campaign's, else the org default, else the template; with
 * what the owner's own writing shows and what they keep in the Brain.
 */
export async function voiceRulesForCampaign(
  tx: Tx,
  campaign: Pick<Campaign, "id" | "voiceId">,
  knowledge?: KnowledgeRetrievalSnapshot,
): Promise<CampaignVoiceRules> {
  const saved = await savedStrategy(tx, campaign.id);
  const hit = await getVoiceForCampaign(tx, {
    voiceId: saved ? draftingVoiceId(saved.document.voice, campaign) : campaign.voiceId,
  });
  const voice = hit?.voice ?? null;
  const writing = await readOwnerWriting(tx, voice ?? UNMATERIALISED_DEFAULT_VOICE);
  return {
    voiceId: voice?.id ?? null,
    voiceName: voice?.name ?? DEFAULT_VOICE_TEMPLATE.name,
    rules: deriveVoiceRules({
      voice,
      measured: writing.measured,
      brainPreferences: await brainWritingPreferences(tx, knowledge),
    }),
  };
}
