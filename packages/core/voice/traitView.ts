import { and, eq, sql } from "drizzle-orm";
import {
  voiceSamples,
  voices,
  type DraftingKnobs,
  type ResolvedStyleRules,
  type StyleRules,
  type Voice,
  type VoiceTraits,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import {
  DEFAULT_STYLE_RULES,
  resolveStyleRules,
  ruleLines,
  ruleProvenance,
  STARTING_RULE_KEYS,
  startingRuleStrength,
  withAsideDashes,
  type StartingRuleKey,
} from "../ai/styleRules";
import {
  asideIn,
  asideMatch,
  asksQuestion,
  readsEnglish,
  avoidance,
  bindFloor,
  bindFloorAt,
  colonIn,
  eitherOrQuestion,
  endsBare,
  measureVoiceTraits,
  movesIn,
  phraseAtEdge,
  questionIn,
  readsCasual,
  readsFormal,
  resolveVoiceTraits,
  sameSignature,
  signatureIn,
  signaturesOf,
  signatureShare,
  specificIn,
  specificity,
  tagPhrase,
  traitStrength,
  traitWindow,
  volunteeredAdvice,
  wordCount,
  type MeasuredVoiceTraits,
  type TraitKey,
  type TraitStrength,
  type VoiceSignature,
} from "../ai/voiceTraits";
import {
  addsMarks,
  channelOwnerSets,
  ownerTexts,
  ownerTraitsFor,
  UNMATERIALISED_DEFAULT_VOICE,
  type OwnerText,
  voiceEvidence,
  writtenIn,
  type WritingChannel,
} from "../voice";
import { exampleTexts } from "./examples";

/**
 * HOW YOU WRITE, AS THE WRITER AND THE JUDGE READ IT.
 *
 * One row per trait of a voice in one channel: what it holds, where that came
 * from, how firmly it applies, and how many of the owner's own texts show it.
 * Nothing here is stored or decided anew. The values are what a draft is
 * resolved with — the owner's set ones over what their writing shows
 * (`resolveVoiceTraits`), Engager's starting rules under both
 * (`resolveStyleRules`) — the strength is `traitStrength`, and every count is
 * the same detector the measurement ran, over the same window
 * (`traitWindow`), so a row can never say what a draft is not held to.
 *
 * The evidence is `voiceEvidence` alone: a draft the owner approved as it was
 * is never counted here, in k or in n.
 */

/** The fifteen traits a voice learns from the owner's writing, in the order
 *  `VoiceTraits` declares them — its `signatures`, the phrases and marks the
 *  owner repeats, last: dealt to drafts at their own rate rather than held as
 *  one value a draft is told or judged by, but learned all the same. */
export const LEARNED_TRAIT_KEYS = [
  "register",
  "lengthWords",
  "openers",
  "closers",
  "questionRate",
  "eitherOrRate",
  "adviceRate",
  "movesPerComment",
  "tagPhraseRate",
  "exclamationRate",
  "bareEndingRate",
  "colonRate",
  "asideStyle",
  "specificityRate",
  "signatures",
] as const satisfies readonly TraitKey[];

export type LearnedTraitKey = (typeof LEARNED_TRAIT_KEYS)[number];

export { STARTING_RULE_KEYS, type StartingRuleKey };

/**
 * Where a row's value came from: the owner set it for this channel; they set
 * it for comments, and this channel takes it (`channelOwnerSets`); their
 * writing in this channel shows it; Engager's start, untouched; their
 * comments, because this channel has too little of its own; or nothing yet.
 */
export type TraitRowSource = "owner" | "inherited" | "learned" | "start" | "comments" | "none";

/** What a row's n counts. */
export type EvidenceUnit = "texts" | "questions" | "asides";

type RowEvidence = {
  /** Of the n, how many show the trait: do what a rate counts, or match the
   *  value a habit holds. Null where nothing is learned to match, or the row
   *  is not read from the writing at all. */
  k: number | null;
  n: number | null;
  unit: EvidenceUnit | null;
  /** How much evidence the writing's "does not" binds on — while it only
   *  guides, the number it is waiting for. Null where more of the same never
   *  makes it firm. */
  firmAt: number | null;
};

type RowBase = RowEvidence & {
  source: TraitRowSource;
  strength: TraitStrength | null;
};

export type LearnedTraitRow = {
  [K in LearnedTraitKey]: RowBase & {
    kind: "learned";
    key: K;
    /** What a draft is held to: the owner's value, else the learned one. */
    value: NonNullable<VoiceTraits[K]> | null;
    /** What the writing shows, whoever set the value — what Use learned
     *  hands back — and how firmly that alone would hold. */
    learned: NonNullable<VoiceTraits[K]> | null;
    learnedStrength: TraitStrength | null;
    /** What the owner set for comments that this channel takes, under any
     *  value set for it — what handing this channel's own value back
     *  returns to. Null on Comment, and where it takes none. */
    inherited: NonNullable<VoiceTraits[K]> | null;
    /** A starting rule the owner set that keeps this value out of every
     *  draft: an em-dash aside under their own em-dash ban
     *  (`withAsideDashes`). Null when nothing does. */
    bannedBy: StartingRuleKey | null;
  };
}[LearnedTraitKey];

export type StartingRuleRow = {
  [K in StartingRuleKey]: RowBase & {
    kind: "start";
    key: K;
    value: ResolvedStyleRules[K];
    /** Engager's start, as it ships. */
    start: ResolvedStyleRules[K];
    /** What the rule resolves to with no value of the owner's: the start, or
     *  the start as their writing lifts it — an em-dash aside lifts the
     *  em-dash ban — and what handing it back returns to. */
    unset: ResolvedStyleRules[K];
  };
}[StartingRuleKey];

export type TraitViewRow = LearnedTraitRow | StartingRuleRow;

export type VoiceTraitView = {
  channel: WritingChannel;
  /** The owner's own texts in this channel, before the window. */
  written: number;
  /** The texts the rows were measured from — the examples the owner gave,
   *  then their newest texts, up to `TRAIT_WINDOW`; Comment's, when this
   *  channel follows Comment. */
  read: number;
  /** Too few texts of its own: the channel resolves to Comment. */
  followsComment: boolean;
  /** How many of the owner's texts a learned "does not" binds on at this
   *  voice's strictness (`bindFloorAt`); null where none ever does. */
  bindsAt: number | null;
  rows: TraitViewRow[];
  /** The free-text rules a draft is written under beside the starting rules:
   *  Engager's starting line, on while the voice holds it, and the lines the
   *  voice keeps of its own, with who set them. */
  rules: VoiceRules;
};

export type VoiceRules = {
  start: { text: string; on: boolean };
  lines: string[];
  /** Who set the lines: the owner, or a rule learned from their edits. */
  by: "owner" | "learned" | null;
};

/** One of the owner's texts that shows a trait, and the words that do. */
export type TraitExample = {
  sampleId: number;
  text: string;
  /** The matched words, as offsets into `text`; null for a text that shows
   *  the trait as a whole, or one shown for what it does not do. */
  hitStart: number | null;
  hitEnd: number | null;
  capturedAt: number;
  campaignId: number | null;
  discoveredPostId: number | null;
};

type ViewVoice = Pick<
  Voice,
  "id" | "isDefault" | "language" | "styleRules" | "learnedDirectives" | "disabledDirectives"
>;

/** The voice asked for, else the default — read, never created. */
async function readVoice(tx: Tx, voiceId: number | null | undefined): Promise<ViewVoice> {
  const [row] = await tx
    .select()
    .from(voices)
    .where(voiceId != null ? eq(voices.id, voiceId) : eq(voices.isDefault, true));
  if (row) return row;
  if (voiceId != null) throw new Error(`voice ${voiceId} not found`);
  return {
    ...UNMATERIALISED_DEFAULT_VOICE,
    language: null,
    styleRules: null,
    learnedDirectives: null,
    disabledDirectives: [],
  };
}

/** A text in the window, trimmed as the measurement reads it, and the sample
 *  it was written as — none for an example the owner gave. */
type WindowText = { text: string; sample: OwnerText | null };

async function channelWindow(
  tx: Tx,
  voice: ViewVoice,
  channel: WritingChannel,
): Promise<WindowText[]> {
  // A channel's measurement reads the examples the owner gave it first,
  // exactly as `readOwnerWriting` hands them to `measureVoiceTraits`.
  const examples: WindowText[] = exampleTexts(voice.styleRules, channel).map((text) => ({
    text: text.trim(),
    sample: null,
  }));
  const samples = (await ownerTexts(tx, voice, channel)).map((sample) => ({
    text: sample.text.trim(),
    sample,
  }));
  return traitWindow([...examples, ...samples], (item) => item.text);
}

type ChannelReading = {
  window: WindowText[];
  measured: MeasuredVoiceTraits | null;
  followsComment: boolean;
  /** The language the voice writes in, and whether it is English, so the
   *  detectors built on English words read it (`readsEnglish`). */
  language: string | null;
  english: boolean;
  /** The voice's `DraftingKnobs.voiceStrictness`: how much writing a learned
   *  "does not" binds on. */
  strictness: DraftingKnobs["voiceStrictness"];
};

/** A channel's own window and measurement, or Comment's where its own
 *  measures nothing — the fallback the DM writer already takes
 *  (`withOwnerWriting`). */
async function readChannel(
  tx: Tx,
  voice: ViewVoice,
  channel: WritingChannel,
): Promise<ChannelReading> {
  const language = { language: voice.language };
  const english = readsEnglish(voice.language);
  const strictness = voice.styleRules?.knobs?.voiceStrictness;
  const window = await channelWindow(tx, voice, channel);
  const measured = measureVoiceTraits(
    window.map((item) => item.text),
    language,
  );
  if (measured || channel === "comment") {
    return {
      window,
      measured,
      followsComment: false,
      language: voice.language,
      english,
      strictness,
    };
  }
  const comments = await channelWindow(tx, voice, "comment");
  return {
    window: comments,
    measured: measureVoiceTraits(
      comments.map((item) => item.text),
      language,
    ),
    followsComment: true,
    language: voice.language,
    english,
    strictness,
  };
}

/**
 * What a voice's writing shows for one trait, measured over `texts`. Its
 * signatures leave out the habitual openers and closers the measurement folds
 * in so drafts are dealt those at the owner's rate too (`measureVoiceTraits`):
 * How you open and How you end already show them, so How you sign off keeps
 * only the phrases the owner's texts repeat as signatures (`signaturesOf`).
 */
function learnedValue<K extends LearnedTraitKey>(
  traits: VoiceTraits | null | undefined,
  key: K,
  texts: readonly string[],
): NonNullable<VoiceTraits[K]> | null {
  const value = traits?.[key] ?? null;
  if (key !== "signatures" || value == null) return value;
  const repeated = signaturesOf(texts);
  const signOffs = (value as VoiceSignature[]).filter((signature) =>
    repeated.some((own) => sameSignature(own.phrase, signature.phrase)),
  );
  return signOffs.length > 0 ? (signOffs as NonNullable<VoiceTraits[K]>) : null;
}

/** Whether a text shows a trait: the words that do, `true` where the whole
 *  text does, null where it does not. */
type Hit = (text: string) => string | true | null;

const ifTrue = (shows: boolean): true | null => (shows ? true : null);

/** The traits read off English words, which a voice in another language is
 *  not measured on (`measureVoiceTraits`). */
const ENGLISH_ONLY: readonly LearnedTraitKey[] = [
  "register",
  "eitherOrRate",
  "adviceRate",
  "movesPerComment",
  "tagPhraseRate",
  "specificityRate",
];

/**
 * How one learned trait is seen in a single text, from the same detectors the
 * measurement counts with. A habit — a register, a range, a phrase, a way of
 * setting an aside off — is matched against what the writing holds, so there
 * is nothing to match until something is learned. A trait read off English
 * words is not looked for in a voice that writes in another language.
 */
function learnedHit<K extends LearnedTraitKey>(
  key: K,
  learned: VoiceTraits[K] | null,
  english: boolean,
): Hit | null {
  if (!english && ENGLISH_ONLY.includes(key)) return null;
  const v = learned as VoiceTraits[LearnedTraitKey] | null;
  switch (key) {
    case "register":
      if (v === "casual") return (text) => ifTrue(readsCasual(text));
      if (v === "formal") return (text) => ifTrue(readsFormal(text));
      if (v === "neutral") return (text) => ifTrue(!readsCasual(text) && !readsFormal(text));
      return null;
    case "lengthWords": {
      const range = v as VoiceTraits["lengthWords"] | null;
      if (!range) return null;
      return (text) => ifTrue(wordCount(text) >= range.min && wordCount(text) <= range.max);
    }
    case "openers":
    case "closers": {
      const phrases = v as string[] | null;
      if (!phrases?.length) return null;
      const edge = key === "openers" ? "start" : "end";
      return (text) => phraseAtEdge(text, phrases, edge);
    }
    case "asideStyle":
      if (!v) return null;
      return (text) => {
        const match = asideMatch(text);
        return match?.style === v ? match.aside : null;
      };
    case "questionRate":
      return (text) => questionIn(text, english);
    case "eitherOrRate":
      return eitherOrQuestion;
    case "adviceRate":
      return volunteeredAdvice;
    case "movesPerComment":
      return (text) => ifTrue(movesIn(text) > 1);
    case "tagPhraseRate":
      return tagPhrase;
    case "exclamationRate":
      return (text) => (text.includes("!") ? "!" : null);
    case "bareEndingRate":
      return (text) => ifTrue(endsBare(text));
    case "colonRate":
      return colonIn;
    case "specificityRate":
      return specificIn;
    case "signatures": {
      const phrases = (v as VoiceSignature[] | null)?.map((signature) => signature.phrase);
      if (!phrases?.length) return null;
      return (text) => signatureIn(text, phrases);
    }
    default:
      return null;
  }
}

const EMOJI = /\p{Extended_Pictographic}/u;

/** How a starting rule is seen in a single text; null where the rule is not
 *  read from the writing at all. */
function startingHit(key: StartingRuleKey): Hit | null {
  switch (key) {
    case "emDashes":
      return (text) => (text.includes("—") ? "—" : null);
    case "semicolons":
      return (text) => (text.includes(";") ? ";" : null);
    case "emojiMax":
      return (text) => EMOJI.exec(text)?.[0] ?? null;
    default:
      return null;
  }
}

/** The texts a trait's n counts: the questions for how the owner asks, the
 *  asides for how they set one off, every text for the rest. */
function population(key: LearnedTraitKey | StartingRuleKey, window: WindowText[]): WindowText[] {
  if (key === "eitherOrRate") return window.filter((item) => asksQuestion(item.text));
  if (key === "asideStyle") return window.filter((item) => asideIn(item.text) != null);
  return window;
}

const UNITS: Partial<Record<LearnedTraitKey, EvidenceUnit>> = {
  eitherOrRate: "questions",
  asideStyle: "asides",
};

/** The evidence a learned "does not" binds on, while what the writing shows
 *  is one: none of it, named to a side, or an aside set off one way, at the
 *  voice's own strictness (`bindFloor`). A habit the owner has however rarely
 *  never binds, so more of the same makes it no firmer. */
function firmAt(key: LearnedTraitKey, learned: VoiceTraits): number | null {
  const floor = bindFloor(learned);
  if (!floor) return null;
  switch (key) {
    case "questionRate":
    case "adviceRate":
    case "movesPerComment":
    case "tagPhraseRate":
    case "colonRate":
    case "eitherOrRate": {
      const held = avoidance(learned, key);
      if (!held || held === "rationed") return null;
      return key === "eitherOrRate" ? floor.questions : floor.texts;
    }
    case "specificityRate":
      return specificity(learned) ? floor.texts : null;
    case "asideStyle":
      return learned.asideStyle ? floor.asides : null;
    default:
      return null;
  }
}

/** The owner's own texts in a channel, before the window. */
async function countWritten(tx: Tx, voice: ViewVoice, channel: WritingChannel): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(voiceSamples)
    .where(and(voiceEvidence(voice), writtenIn(channel)));
  return row?.count ?? 0;
}

/**
 * Every trait of one voice in one channel, learned first, then the starting
 * rules. `voiceId` null reads the default voice, existing or not.
 */
export async function voiceTraitView(
  tx: Tx,
  input: { voiceId?: number | null; channel: WritingChannel },
): Promise<VoiceTraitView> {
  const voice = await readVoice(tx, input.voiceId);
  const { window, measured, followsComment, english } = await readChannel(tx, voice, input.channel);
  const sets = channelOwnerSets(voice.styleRules, input.channel, followsComment);
  const ownerSet = ownerTraitsFor(voice.styleRules, input.channel, followsComment);
  const language = {
    language: voice.language,
    strictness: voice.styleRules?.knobs?.voiceStrictness,
  };
  const resolved = resolveVoiceTraits(measured, ownerSet, language);
  const learnedOnly = resolveVoiceTraits(measured, null, language);
  const texts = window.map((item) => item.text);

  // The rules a draft in this channel is held to, as `withOwnerWriting` and
  // `resolveVoiceV2` lay them: a learned em-dash aside lifts an em-dash ban
  // the voice only inherits, an owner's own ban drops the aside instead, and
  // saves that add marks lift a zero emoji cap. Every row reads these, so a
  // trait a rule keeps out of drafts never shows as held.
  const rulesFor = (styleRules: StyleRules | null) => {
    const { resolved: base, overridden } = resolveStyleRules(styleRules);
    const laid = withAsideDashes({ ...base, traits: resolved }, overridden);
    if (addsMarks(voice) && laid.emojiMax === 0) laid.emojiMax = 1;
    return laid;
  };
  const rules = rulesFor(voice.styleRules);
  const held = rules.traits ?? {};

  const learnedRows = LEARNED_TRAIT_KEYS.map((key): LearnedTraitRow => {
    const owned = sets.own?.[key] != null;
    const taken = !owned && sets.inherited?.[key] != null;
    const learned = learnedValue(measured?.traits, key, texts);
    const hit = learnedHit(key, learned, english);
    const counted = population(key, window).map((item) => item.text);
    const banned = resolved[key] != null && held[key] == null;
    // What drafts hold, but for the openers and closers the learned
    // signatures also carry, which their own rows show.
    const value = key === "signatures" && !owned && !taken ? learned : (held[key] ?? null);
    return {
      kind: "learned",
      key,
      value,
      learned,
      learnedStrength: learned == null ? null : traitStrength(learnedOnly, key),
      inherited: sets.inherited?.[key] ?? null,
      bannedBy: banned ? "emDashes" : null,
      source:
        banned || (!owned && !taken && learned == null)
          ? "none"
          : owned
            ? "owner"
            : taken
              ? "inherited"
              : followsComment
                ? "comments"
                : "learned",
      strength: value == null ? null : traitStrength(held, key),
      k: hit ? counted.filter((text) => hit(text) != null).length : null,
      n: counted.length,
      unit: UNITS[key] ?? "texts",
      firmAt: firmAt(key, learnedOnly),
    } as LearnedTraitRow;
  });

  const startingRows = STARTING_RULE_KEYS.map((key): StartingRuleRow => {
    const hit = startingHit(key);
    const value = rules[key];
    const start = DEFAULT_STYLE_RULES[key];
    const by = ruleProvenance(voice.styleRules, key);
    const unset = by ? rulesFor({ ...voice.styleRules!, [key]: null })[key] : value;
    const moved = JSON.stringify(value) !== JSON.stringify(start);
    return {
      kind: "start",
      key,
      value,
      start,
      unset,
      // The owner's, a calibration's, the writing's (an em-dash aside lifts
      // the ban it only inherits), or Engager's start untouched.
      source: by ?? (moved ? "learned" : "start"),
      strength: startingRuleStrength(key, value),
      k: hit ? texts.filter((text) => hit(text) != null).length : null,
      n: hit ? texts.length : null,
      unit: hit ? "texts" : null,
      firmAt: null,
    } as StartingRuleRow;
  });

  return {
    channel: input.channel,
    written: await countWritten(tx, voice, input.channel),
    read: window.length,
    followsComment,
    bindsAt: bindFloorAt(voice.styleRules?.knobs?.voiceStrictness)?.texts ?? null,
    rows: [...learnedRows, ...startingRows],
    rules: voiceRules(voice.styleRules),
  };
}

/** A voice's free-text rules, as `VoiceTraitView.rules` reads them: what the
 *  writer is given (`resolveStyleRules`), split into Engager's line and the
 *  voice's own. */
function voiceRules(styleRules: StyleRules | null): VoiceRules {
  const start = DEFAULT_STYLE_RULES.extras;
  const held = ruleLines(resolveStyleRules(styleRules).resolved.extras);
  return {
    start: { text: start, on: held.includes(start) },
    lines: held.filter((line) => line !== start),
    by: ruleProvenance(styleRules, "extras"),
  };
}

/**
 * The phrases an owner sets as theirs, each at the rate a draft is dealt it:
 * the one their writing was learned at, where the voice learned it, else the
 * share of their own texts that carry it. Read off the channel they are set
 * for — the texts its owner-set values stand beside, or the comments it
 * follows — never off what a page sent. A phrase none of their texts carry
 * comes back at 0, which no draft is dealt.
 */
export async function signatureRates(
  tx: Tx,
  input: { voiceId?: number | null; channel?: WritingChannel; phrases: readonly string[] },
): Promise<VoiceSignature[]> {
  const voice = await readVoice(tx, input.voiceId);
  const { window, measured } = await readChannel(tx, voice, input.channel ?? "comment");
  const texts = window.map((item) => item.text);
  const learned = measured?.traits.signatures ?? [];
  return input.phrases.map((phrase) => {
    const twin = learned.find((signature) => sameSignature(signature.phrase, phrase));
    return { phrase, rate: twin?.rate ?? signatureShare(texts, phrase) };
  });
}

function spanOf(text: string, hit: string | true, last: boolean): Pick<TraitExample, "hitStart" | "hitEnd"> {
  if (hit === true) return { hitStart: null, hitEnd: null };
  const at = last ? text.lastIndexOf(hit) : text.indexOf(hit);
  return at < 0 ? { hitStart: null, hitEnd: null } : { hitStart: at, hitEnd: at + hit.length };
}

/** A row's texts from one reading of its channel. */
function examplesIn(
  { window, measured, english, language, strictness }: ChannelReading,
  key: LearnedTraitKey | StartingRuleKey,
  limit: number,
): TraitExample[] {
  const learnedKey = (LEARNED_TRAIT_KEYS as readonly string[]).includes(key)
    ? (key as LearnedTraitKey)
    : null;
  const learned = learnedKey
    ? learnedValue(measured?.traits, learnedKey, window.map((item) => item.text))
    : null;
  if (learnedKey && learned == null) return [];
  const hit = learnedKey ? learnedHit(learnedKey, learned, english) : startingHit(key as StartingRuleKey);
  if (!hit) return [];

  const counted = population(key, window);
  const sampled = counted.flatMap(({ text, sample }) => (sample ? [{ text, sample }] : []));
  const example = (
    { text, sample }: { text: string; sample: OwnerText },
    span: Pick<TraitExample, "hitStart" | "hitEnd">,
  ): TraitExample => ({
    sampleId: sample.id,
    text,
    ...span,
    capturedAt: sample.capturedAt,
    campaignId: sample.campaignId,
    discoveredPostId: sample.discoveredPostId,
  });

  if (counted.some((item) => hit(item.text) != null)) {
    return sampled
      .flatMap((item) => {
        const found = hit(item.text);
        return found == null ? [] : [example(item, spanOf(item.text, found, key === "closers"))];
      })
      .slice(0, limit);
  }
  const learnedOnly = resolveVoiceTraits(measured, null, { language, strictness });
  const guides = learnedKey != null && traitStrength(learnedOnly, learnedKey) === "guides";
  return guides
    ? sampled.slice(0, limit).map((item) => example(item, { hitStart: null, hitEnd: null }))
    : [];
}

/**
 * The owner's own texts behind one row, newest first, the words that show it
 * marked. A row whose writing does the thing shows the texts that do. A "does
 * not" shows the texts it rests on, unmarked — but only while it guides:
 * those few texts are why a draft that does it still goes through. A firm one
 * is said by its count, and a row with nothing learned has nothing to show.
 * The examples the owner gave count in the measurement and are their own
 * section's to show, so only sampled texts come back here.
 */
export async function examplesFor(
  tx: Tx,
  input: {
    voiceId?: number | null;
    channel: WritingChannel;
    key: LearnedTraitKey | StartingRuleKey;
    limit?: number;
  },
): Promise<TraitExample[]> {
  const voice = await readVoice(tx, input.voiceId);
  return examplesIn(await readChannel(tx, voice, input.channel), input.key, input.limit ?? 3);
}

/** `examplesFor` for every row of a channel, off one reading of it — what a
 *  page that offers every row's texts loads. */
export async function examplesByTrait(
  tx: Tx,
  input: { voiceId?: number | null; channel: WritingChannel; limit?: number },
): Promise<Record<LearnedTraitKey | StartingRuleKey, TraitExample[]>> {
  const voice = await readVoice(tx, input.voiceId);
  const reading = await readChannel(tx, voice, input.channel);
  const keys = [...LEARNED_TRAIT_KEYS, ...STARTING_RULE_KEYS];
  return Object.fromEntries(
    keys.map((key) => [key, examplesIn(reading, key, input.limit ?? 3)]),
  ) as Record<LearnedTraitKey | StartingRuleKey, TraitExample[]>;
}
