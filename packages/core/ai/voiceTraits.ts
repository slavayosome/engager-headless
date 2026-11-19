import type { DraftingKnobs, VoiceTraits } from "@engager/database/schema";

/**
 * VOICE TRAITS — how one owner's own writing reads, as rates and ranges.
 *
 * The detectors below are the only thing that ships: what a question is, what
 * volunteered advice looks like, what a tag set off at the end of a sentence
 * is, how an aside is set off, what names something specific. Whether a voice
 * USES any of them is never decided here. It is measured
 * from the comments the owner wrote (`measureVoiceTraits`), or set by the owner
 * (`StyleRules.traits`, which beats the measurement field by field), and the
 * writer, the judge and the lint all read the resolved result — so a voice
 * that never hands over two options gets an either/or question flagged, a
 * voice that does keeps it, and a voice that does it once in a while keeps it
 * that often (`avoidance`): rare is never forbidden.
 *
 * An agent draft the owner approved is never a sample here: the callers read
 * owner-written samples only (`ownerAuthoredSample`, voice.ts).
 *
 * The detectors built on English words — a question's opening words, "or",
 * "I'd", a praise word — read an English voice only (`readsEnglish`). For a
 * voice in any other language they step aside: nothing is measured with them
 * and nothing is flagged by them, and the judge decides from what the owner
 * set and from the measures any language has — a question mark, a colon, how
 * an aside is set off, the phrases and marks the owner repeats.
 */

/** Newest owner-written texts a measurement reads. Older ones age out, so a
 *  habit the owner drops fades as they write past it. */
export const TRAIT_WINDOW = 30;
/** Fewer owner-written texts than this measure nothing. */
export const TRAIT_MIN_SAMPLES = 5;
/** Fewer questions than this say nothing about how the owner asks. */
export const TRAIT_MIN_QUESTIONS = 2;
/** A share under this is rare for the owner — still a habit of theirs, at
 *  its rate. */
export const TRAIT_AVOID = 0.1;
/** None of a thing in this much of the owner's writing — texts, or questions
 *  for how they ask — binds the judge and the gate; on less it is a soft line
 *  in the prompt, since five plain statements do not ban a question. Some of
 *  it, however little, never binds: a rare habit is the owner's own, and a
 *  draft carries it at about their rate (`rationedHabits`). */
export const TRAIT_BIND_TEXTS = 10;
export const TRAIT_BIND_QUESTIONS = 5;
/** Fewer asides than this say nothing about how the owner sets one off, and
 *  how many it takes before the way they do binds. */
export const TRAIT_MIN_ASIDES = 2;
export const TRAIT_BIND_ASIDES = 5;
/** A share at or over this uses colons as a habit, which the writer keeps. */
const COLON_HABIT = 0.3;
/** Volunteered advice this often is a habit the writer is told about. */
const ADVICE_HABIT = 0.4;
/** Exclamation marks under this share are rare for a voice; at or over the
 *  second, used freely. Between the two the writer is told nothing. */
const EXCLAMATION_RARE = 0.05;
const EXCLAMATION_FREE = 0.5;
/** A share at or over this leaves the last full stop off as a habit. */
const BARE_ENDING_HABIT = 0.5;
/** Shares at or over, and under, which a voice names the figures and names
 *  of what it answers, or refers to them loosely. */
const SPECIFIC_HIGH = 0.6;
const SPECIFIC_LOW = 0.3;
/** An opener or closer counts as a habit once this share of texts use it,
 *  and at least two do. */
const PHRASE_HABIT = 0.2;
const MAX_PHRASES = 4;
/** A signature recurs in at least this share of the owner's texts, and in
 *  `SIGNATURE_MIN_TEXTS` of them at the least; a voice keeps its most used
 *  few. */
const SIGNATURE_SHARE = 0.15;
const SIGNATURE_MIN_TEXTS = 3;
const MAX_SIGNATURES = 8;
/** Signatures a voice carries at the most, its habitual openers and closers
 *  among them — what an owner may set (`VoiceTraitsSchema`). */
const SIGNATURE_LIMIT = 12;
/** The longest run of words a signature is. */
const SIGNATURE_WORDS = 4;

/** Whether the detectors built on English words may read a voice: one with
 *  no language set, or an English one. */
export function readsEnglish(language: string | null | undefined): boolean {
  const tag = language?.trim();
  return !tag || /^en(?:[-_]|$)/i.test(tag);
}

/** A face typed in punctuation (";)", ":D", "=(", "<3") — never the colon
 *  of a URL, a time or a ratio, which a letter or a digit touches. */
const EMOTICON = String.raw`(?<![\p{L}\p{N}])(?:[:;=][-'^o]?[)(\][DPpO3*/\\|]+|<3+|\^_*\^)(?![\p{L}\p{N}])`;
const EMOJI = String.raw`\p{Extended_Pictographic}(?:\u{FE0F}|\p{Emoji_Modifier}|\u{200D}\p{Extended_Pictographic})*`;
/** The marks a writer can make a habit of: a face, an emoji, a trailing-off
 *  ellipsis, a doubled "!!" or "?!". */
const MARK = new RegExp(String.raw`${EMOTICON}|${EMOJI}|\.{3,}|…|[!?]{2,}`, "gu");

/** Sentences, split after a closing mark and after a face or an emoji. */
const SENTENCE_BREAK = new RegExp(
  String.raw`(?<=[.!?…？؟])\s+|(?<=(?:${EMOTICON}|${EMOJI}))\s+|\n+`,
  "u",
);
const sentencesOf = (text: string): string[] =>
  text
    .trim()
    .split(SENTENCE_BREAK)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

const wordsOf = (text: string): string[] =>
  text.trim().split(/\s+/u).filter((word) => /[\p{L}\p{N}]/u.test(word));

/** Faces and emoji a sentence trails off on, which close nothing. */
const TRAILING_MARKS = new RegExp(String.raw`(?:\s*(?:${EMOTICON}|${EMOJI}))+\s*$`, "u");
const QUESTION_MARK = /[?？؟][!"')\]]*$/u;
/** A full stop or an exclamation mark closes a statement; an ellipsis does not. */
const CLOSED = /(?<!\.)[.!]["')\]]*$/u;

/** Where a clause starts: the sentence's start, after a comma, a semicolon or
 *  a colon, or after a spaced dash. */
const CLAUSE_START = String.raw`(?:^|[,;:]\s+|\s[-–—]\s+)`;
const ASKING_VERB = String.raw`(?:do|does|did|is|are|was|were|can|could|would|will|should|has|have|had)`;
/** Who or what a question asks about, after its verb. */
const ASKED_ABOUT = String.raw`(?:you|they|he|she|it|we|i|any(?:one|body)?|some(?:one|body)|people|the|a|an|that|this|these|those|there|your|their|his|her|its|our|my)`;
/** How an English question opens a clause: a question word with its verb
 *  ("how did", "how many", "which one did") — a form of "be" only ahead of
 *  who or what it asks about ("where is the", "what's your") — a question
 *  word turned on the reader ("what made you"), or a verb ahead of who it
 *  asks about ("did any of them", "do you", "is the"). A
 *  statement built on a question word — "what matters is…", "which is
 *  why…", "what helped was…", "how we did it", "do the math" — opens none. */
const QUESTION_CLAUSE = new RegExp(
  CLAUSE_START +
    String.raw`(?:(?:how|what|where|which|who|why|when)(?:(?:['’]?s|['’]?re|\s+(?:is|are|was|were))\s+${ASKED_ABOUT}\b|\s+(?:do|does|did|can|could|would|will|should|has|have|had)(?:n['’]?t)?\b|\s+(?:long|many|much|often|far|soon|come)\b)` +
    String.raw`|(?:what|which)\s+[\p{L}'’]+\s+(?:do|does|did|can|could|would|will|should|has|have|had)\b` +
    String.raw`|(?:what|which|who)\s+[\p{L}'’]+\s+you\b` +
    String.raw`|${ASKING_VERB}(?:n['’]?t)?\s+(?:you|they|he|she|it|we|i|any(?:one|body)?|some(?:one|body)|people)\b` +
    String.raw`|(?:does|did|is|are|was|were|can|could|would|will|should|has)(?:n['’]?t)?\s+(?:the|that|this|these|those|there|your|their|his|her|its|our|my)\b)`,
  "iu",
);

/** A sentence that asks: one closed by a question mark, in any language; in
 *  English, also one that trails off — "…", "...", a face, or nothing — on a
 *  clause that opens like a question. */
function isQuestion(sentence: string, english: boolean): boolean {
  const bare = sentence.replace(TRAILING_MARKS, "");
  if (QUESTION_MARK.test(bare)) return true;
  if (!english || CLOSED.test(bare)) return false;
  return QUESTION_CLAUSE.test(bare);
}

/** "or" as a choice, not "or so", "or two", "or not", "more or less". */
const CHOICE_OR =
  /\bor\b(?!\s+(?:so|two|three|not|something|anything|similar|whatever|less|more|otherwise)\b)/i;

/** First-person conditional advice opening a sentence or a clause. Case-
 *  sensitive so "ID" never reads as "I'd"; the verbs that wish, hedge or
 *  recall ("I'd love", "I'd say", "I'd seen") are not advice. */
const ADVICE = new RegExp(
  String.raw`(?:^|[.!?]\s+|\n\s*|,\s+)(?:(?:[Hh]onestly|[Pp]ersonally|[Aa]lso|[Bb]ut|[Ss]o|[Aa]nd)\s+)?` +
    String.raw`[Ii](?: would|['’]?d)\s+(?:(?:also|probably|definitely|still|just|personally|honestly|really|actually|first)\s+)?` +
    String.raw`(?!(?:love|like|be|have|say|guess|bet|imagine|think|expect|assume|hope|want|agree|argue|call|wonder|rather|never|been|seen|heard|known|read|had|thought|gotten)\b)[a-z]+`,
);

/** A tag of one to three words set off by a comma to close a sentence of
 *  three words or more ("[the detail], [tag]."), or standing as a sentence of
 *  its own. An interjection ahead of a short reaction is not one. */
const TAG_WORDS = String.raw`[\p{L}\p{N}'’]+(?:\s+[\p{L}\p{N}'’]+){0,2}`;
const CLAUSE_WORD = String.raw`(?:[^\s,.!?;:]|\.(?=\d))+`;
const TRAILING_TAG = new RegExp(
  String.raw`(?:^|[.!?]\s+|\n\s*)(?:${CLAUSE_WORD}\s+){2,}${CLAUSE_WORD},\s*(${TAG_WORDS})\s*[.!]+["')\]]*(?=\s|$)`,
  "u",
);
const STANDALONE_TAG = new RegExp(String.raw`^${TAG_WORDS}\s*[.!]+["')\]]*$`, "u");
/** Generic English words a reaction is tagged with — a detector only: whether
 *  a voice uses them is its measured `tagPhraseRate`, so a voice that does
 *  keeps them. Tagged on by opening a sentence ("Kudos on…", "Hats off to…"),
 *  closing one ("…, love it"), or standing as one ("Bravo."). */
const PRAISE = String.raw`(?:(?:mad|huge|big|much|massive|serious|full)\s+)?(?:respect|kudos|props)|hats\s+off|love\s+(?:this|it)|big\s+fan|chef['’]?s\s+kiss|this\s+is\s+the\s+way|well\s+played|nailed\s+it|bravo|legend(?:ary)?|love\s+to\s+see\s+(?:it|this)`;
const PRAISE_END = String.raw`\s*(?:[.!…]+\s*)?(?:(?:${EMOTICON}|${EMOJI})\s*)*["')\]]*$`;
const PRAISE_OPENER = new RegExp(
  String.raw`^(${PRAISE})(?=\s*(?:[,.!:;…\-–—]|$)|\s*(?:${EMOTICON}|${EMOJI})|\s+(?:for|to|on|of|in|that|how|the|this|you|your|here)\b)`,
  "iu",
);
const PRAISE_CLOSER = new RegExp(String.raw`(?:,|\s[-–—])\s*(${PRAISE})${PRAISE_END}`, "iu");
const PRAISE_ALONE = new RegExp(String.raw`^(${PRAISE})${PRAISE_END}`, "iu");

/** A contraction, never a possessive: "it's" and "that's", not "the board's". */
const CONTRACTION =
  /\b(?:\p{L}+n['’]t|i['’]m|(?:you|we|they)['’]re|(?:i|you|we|they|could|would|should|might|must)['’]ve|(?:i|you|he|she|it|we|they|that|there)['’]ll|(?:i|you|he|she|we|they)['’]d|(?:it|that|there|here|what|who|where|how|let|he|she)['’]s)\b/iu;
const SHORTHAND = /(?:^|\s)(?:imo|imho|tbh|btw|ngl|lol|w\/|&)(?=\s|$|[.,!?])/i;

/** Every question the text asks, quoted, in order. `english` false reads a
 *  question mark only. */
export function questionsIn(text: string, english = true): string[] {
  return sentencesOf(text).filter((sentence) => isQuestion(sentence, english));
}

/** The first question the text asks, quoted. `english` false reads a
 *  question mark only. */
export function questionIn(text: string, english = true): string | null {
  return sentencesOf(text).find((sentence) => isQuestion(sentence, english)) ?? null;
}

/** The text asks at least one question. `english` false reads a question
 *  mark only. */
export function asksQuestion(text: string, english = true): boolean {
  return questionIn(text, english) != null;
}

/** A question that hands over two options to pick from ("…, A or B?",
 *  "where is it going first - A or B..."). English only. */
export function eitherOrQuestion(text: string): string | null {
  return sentencesOf(text).find((s) => isQuestion(s, true) && CHOICE_OR.test(s)) ?? null;
}

/** Advice the text volunteers ("I would…", "I'd…"), quoted. */
export function volunteeredAdvice(text: string): string | null {
  const match = text.match(ADVICE);
  return match ? match[0].replace(/^[.!?,\s]+/u, "").trim() : null;
}

/** A short tag as the reaction, quoted: one set off at the end of a
 *  sentence, one standing as a sentence, or a praise word opening or closing
 *  one. English only. */
export function tagPhrase(text: string): string | null {
  const trailing = text.match(TRAILING_TAG);
  if (trailing) return trailing[1]!;
  for (const sentence of sentencesOf(text)) {
    if (STANDALONE_TAG.test(sentence)) return sentence;
    const praise =
      sentence.match(PRAISE_ALONE) ?? sentence.match(PRAISE_OPENER) ?? sentence.match(PRAISE_CLOSER);
    if (praise) return praise[1]!;
  }
  return null;
}

/** What a colon in a URL, a time or a ratio ("9:30", "3:1") is: not one. */
const NOT_A_COLON = /\S+:\/\/\S+|\d:\d/gu;

/** Where the text sets a clause off with a colon mid-sentence ("the catch:
 *  it…"), quoted around the colon. What is no colon is blanked to its own
 *  length, so the quote is cut from the text as written. */
export function colonIn(text: string): string | null {
  const blanked = text.replace(NOT_A_COLON, (match) => " ".repeat(match.length));
  const match = /[\p{L}\p{N})"'’]:\s+\S/u.exec(blanked);
  return match ? text.slice(match.index, match.index + match[0].length) : null;
}

/** The text sets a clause off with a colon mid-sentence. */
export function usesColon(text: string): boolean {
  return colonIn(text) != null;
}

export type AsideStyle = NonNullable<VoiceTraits["asideStyle"]>;

/** How an aside is set off, the most marked first: a text that has a dash
 *  aside and a comma one is read by its dash. Spaces around the hyphen are
 *  what make it an aside rather than a compound or a list's bullet. */
const ASIDES: ReadonlyArray<readonly [AsideStyle, RegExp]> = [
  ["em_dash", /\p{L}\s*(?:—|--)\s*\p{L}/u],
  ["spaced_hyphen", /\p{L},? [-–] \p{L}/u],
  ["parentheses", /\(\s*\p{L}[^)]*\)/u],
  // A few words between two commas, and no list ("A, B and C", "A, B, or C").
  ["comma", /,\s(?:[\p{L}'’]+\s){1,5}[\p{L}'’]+,\s(?!(?:and|or)\b)/u],
];

/** Where a dash aside ends: the end of its sentence, a semicolon, a line
 *  break, or the dash that closes it. A comma inside it is part of it. */
const ASIDE_CLOSE = /[.!?…;\n]|\s[-–]\s|—|--/u;

/**
 * The aside as written: a dash aside from its dash to where it closes
 * (`ASIDE_CLOSE`), a bracketed one with its brackets, a comma one between its
 * commas — never the letters either side of the mark that found it.
 */
function asideClause(text: string, style: AsideStyle, match: RegExpExecArray): string {
  if (style === "parentheses") return match[0];
  if (style === "comma") return match[0].replace(/^,\s*|,\s*$/gu, "");
  const at = match.index + match[0].search(style === "em_dash" ? /—|--/u : /[-–]/u);
  const opener = text.startsWith("--", at) ? 2 : 1;
  const close = text.slice(at + opener).search(ASIDE_CLOSE);
  return text.slice(at, close < 0 ? text.length : at + opener + close).trimEnd();
}

/** How the text sets an aside off, and the aside as written, if it has one. */
export function asideMatch(text: string): { style: AsideStyle; aside: string } | null {
  for (const [style, pattern] of ASIDES) {
    const match = pattern.exec(text);
    if (match) return { style, aside: asideClause(text, style, match) };
  }
  return null;
}

/** How the text sets an aside off, if it has one. */
export function asideIn(text: string): AsideStyle | null {
  return asideMatch(text)?.style ?? null;
}

/** Tools often written in lower case, where capitals cannot find them. */
const TOOL_NAMES =
  /\b(?:chatgpt|claude|cursor|notion|figma|slack|linkedin|github|stripe|zapier|openai|hubspot|salesforce|shopify)\b/iu;
const FIGURE = /\d/u;
/** "I" and its contractions are capitalised without naming anything. */
const PRONOUN_I = /^I(?:['’]\p{L}+)?$/u;

/** The first specific thing the text names, quoted: a figure — a number, an
 *  amount, a percentage — or a tool, or a name, which is a capitalised word
 *  past the first of its sentence. */
export function specificIn(text: string): string | null {
  const figure = wordsOf(text).find((word) => FIGURE.test(word));
  if (figure) return bare(figure) || figure;
  const tool = TOOL_NAMES.exec(text);
  if (tool) return tool[0];
  for (const sentence of sentencesOf(text)) {
    const name = wordsOf(sentence)
      .slice(1)
      .map(bare)
      .find((word) => /^\p{Lu}/u.test(word) && !PRONOUN_I.test(word));
    if (name) return name;
  }
  return null;
}

/** The text names something specific. */
export function namesSpecifics(text: string): boolean {
  return specificIn(text) != null;
}

/** The last sentence ends with no closing mark. */
export function endsBare(text: string): boolean {
  return /[\p{L}\p{N}]$/u.test(text);
}

const sentenceWords = (text: string) => wordsOf(text).length / Math.max(1, sentencesOf(text).length);

/** A text reads casual on two different markers, never on one: a single
 *  short sentence or a lowercase start is not a register. */
export function readsCasual(text: string): boolean {
  return (
    [
      CONTRACTION.test(text),
      SHORTHAND.test(text),
      /^\p{Ll}/u.test(text),
      endsBare(text),
      sentenceWords(text) <= 8,
    ].filter(Boolean).length >= 2
  );
}

/** Long sentences and no contraction. */
export function readsFormal(text: string): boolean {
  return !CONTRACTION.test(text) && sentenceWords(text) >= 18;
}

/** How many words the text runs. */
export function wordCount(text: string): number {
  return wordsOf(text).length;
}

/** The opener or closer of a voice's own the text starts or ends on, in its
 *  own casing, compared word by word as the measurement counts them. */
export function phraseAtEdge(
  text: string,
  phrases: readonly string[],
  edge: "start" | "end",
): string | null {
  const words =
    edge === "start"
      ? wordsOf(text).map(bare).filter(Boolean)
      : wordsOf(sentencesOf(text).at(-1) ?? "").map(bare).filter(Boolean);
  for (const phrase of phrases) {
    const size = phrase.split(" ").length;
    const at = edge === "start" ? words.slice(0, size) : words.slice(-size);
    if (at.length === size && at.join(" ").toLowerCase() === phrase.toLowerCase()) {
      return at.join(" ");
    }
  }
  return null;
}

/** A question and a piece of advice are each a move; a comment with neither
 *  makes one. */
export function movesIn(text: string): number {
  return Math.max(1, (asksQuestion(text) ? 1 : 0) + (volunteeredAdvice(text) ? 1 : 0));
}

const share = (count: number, of: number) => (of === 0 ? 0 : Math.round((count / of) * 100) / 100);

/** Nearest-rank percentile of an ascending list. */
function percentile(sorted: number[], p: number): number {
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1]!;
}

/** The phrases (one or two words) a share of the texts open or end on, in the
 *  owner's own casing, most used first, each with that share. */
function habitualPhrases(edges: string[][], total: number): VoiceSignature[] {
  const counts = new Map<string, { phrase: string; n: number }>();
  for (const words of edges) {
    const seen = new Set<string>();
    for (const size of [2, 1]) {
      if (words.length < size) continue;
      const phrase = words.slice(0, size).join(" ");
      const key = phrase.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = counts.get(key) ?? { phrase, n: 0 };
      entry.n += 1;
      counts.set(key, entry);
    }
  }
  const floor = Math.max(2, Math.ceil(PHRASE_HABIT * total));
  const habits = [...counts.values()]
    .filter((entry) => entry.n >= floor)
    .sort((a, b) => b.n - a.n || b.phrase.length - a.phrase.length);
  // A one-word habit inside a two-word one is the same habit.
  const kept: typeof habits = [];
  for (const entry of habits) {
    const key = entry.phrase.toLowerCase();
    if (kept.some((k) => k.phrase.toLowerCase().split(" ").includes(key))) continue;
    kept.push(entry);
  }
  return kept
    .slice(0, MAX_PHRASES)
    .map((entry) => ({ phrase: entry.phrase, rate: share(entry.n, total) }));
}

const bare = (word: string) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}'’]+$/gu, "");

export type VoiceSignature = NonNullable<VoiceTraits["signatures"]>[number];

/** Words too common to make a run of words anyone's own in English. */
const COMMON_WORDS = new Set(
  (
    "a an the and or but so if as at by to of in on for with from into about up out " +
    "i me my we us our you your he him his she her it its they them their this that these those " +
    "is are was were be been am do does did have has had will would can could should " +
    "not no yes just really very too also then than there here what how why when where who which"
  ).split(" "),
);
/** A word this voice uses as a function word, whatever its language: in a
 *  good share of its texts, next to all sorts of words. A word the owner
 *  repeats as part of a phrase keeps the same company. */
const GENERIC_SHARE = 0.3;
const GENERIC_COMPANY = 3;

/** Where a run of words stops: a mark, punctuation, a dash. */
const CLAUSE_BREAK = new RegExp(
  String.raw`${EMOTICON}|${EMOJI}|[.,;:!?…()"“”？؟¡¿]+|\s[-–]\s|—|\n`,
  "gu",
);
const normalWords = (text: string): string[] =>
  text.toLowerCase().replace(/’/gu, "'").match(/[\p{L}\p{N}]+(?:'\p{L}+)*/gu) ?? [];
const clausesOf = (text: string): string[][] =>
  text
    .split(CLAUSE_BREAK)
    .map(normalWords)
    .filter((words) => words.length > 0);

/** A mark as a habit is counted: a face as typed, an emoji without its
 *  presentation selector, any ellipsis as "...", a doubled "!!" or "?!". */
function normalMark(mark: string): string {
  if (mark === "…" || /^\.{3,}$/u.test(mark)) return "...";
  if (/^[!?]+$/u.test(mark)) return mark.includes("?") ? (mark.includes("!") ? "?!" : "??") : "!!";
  return mark.replace(/\u{FE0F}/gu, "");
}
const marksOf = (text: string): string[] => [...text.matchAll(MARK)].map(([mark]) => normalMark(mark));

/**
 * The words that could make a run of words this owner's own. Language-
 * agnostic: four letters or more, since the short words of most languages
 * are their function words; never one this voice uses as a function word
 * (`GENERIC_SHARE` of its texts, `GENERIC_COMPANY` different neighbours or
 * more); and never a common English one.
 */
function tellingWords(texts: readonly string[]): (word: string) => boolean {
  const seenIn = new Map<string, number>();
  const company = new Map<string, Set<string>>();
  for (const text of texts) {
    const clauses = clausesOf(text);
    for (const word of new Set(clauses.flat())) seenIn.set(word, (seenIn.get(word) ?? 0) + 1);
    for (const words of clauses) {
      words.forEach((word, i) => {
        const near = company.get(word) ?? new Set<string>();
        if (i > 0) near.add(words[i - 1]!);
        if (i < words.length - 1) near.add(words[i + 1]!);
        company.set(word, near);
      });
    }
  }
  const generic = (word: string) =>
    (seenIn.get(word) ?? 0) >= GENERIC_SHARE * texts.length &&
    (company.get(word)?.size ?? 0) >= GENERIC_COMPANY;
  return (word) => /^\p{L}{4,}/u.test(word) && !COMMON_WORDS.has(word) && !generic(word);
}

/** What a text could be repeating: the run of words that opens or closes
 *  each of its clauses — two to four words with a telling one among them, or
 *  a clause of one word — and its marks. */
function signatureCandidates(text: string, telling: (word: string) => boolean): Set<string> {
  const found = new Set(marksOf(text));
  for (const words of clausesOf(text)) {
    if (words.length === 1) {
      if (/^\p{L}{3,}$/u.test(words[0]!) && !COMMON_WORDS.has(words[0]!)) found.add(words[0]!);
      continue;
    }
    for (let size = 2; size <= Math.min(SIGNATURE_WORDS, words.length); size++) {
      for (const run of [words.slice(0, size), words.slice(-size)]) {
        if (run.some(telling)) found.add(run.join(" "));
      }
    }
  }
  return found;
}

/** A signature as drafts are matched against it, however it was written. */
const normalSignature = (phrase: string): string =>
  /[\p{L}\p{N}]/u.test(phrase) ? normalWords(phrase).join(" ") : normalMark(phrase.trim());

/** Two signatures are one however each was written: case, curly quotes and
 *  the punctuation between their words aside. */
export const sameSignature = (a: string, b: string): boolean =>
  normalSignature(a) === normalSignature(b);

const overlapping = (a: string, b: string) =>
  ` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `);

/** The signatures with the owner's habitual openers and closers among them, so
 *  a draft is dealt those at the owner's rate too: each run of words no
 *  signature already covers, with a telling word in it (`tellingWords`). A
 *  single word is a signature only where it is a clause of its own
 *  (`signatureCandidates`), never for being the last word of a sentence. */
function withEdgePhrases(
  texts: readonly string[],
  signatures: readonly VoiceSignature[],
  edges: readonly VoiceSignature[],
): VoiceSignature[] {
  const telling = tellingWords(texts);
  const all = [...signatures];
  for (const edge of edges) {
    const phrase = normalSignature(edge.phrase);
    const words = phrase.split(" ");
    if (words.length < 2 || !words.some(telling)) continue;
    if (all.some((other) => overlapping(normalSignature(other.phrase), phrase))) continue;
    all.push({ phrase, rate: edge.rate });
  }
  return all.slice(0, SIGNATURE_LIMIT);
}

/** The share of the owner's texts that carry this phrase, where a signature
 *  says it. */
function signatureRate(traits: VoiceTraits, phrase: string): number | undefined {
  const wanted = normalSignature(phrase);
  return traits.signatures?.find((s) => normalSignature(s.phrase) === wanted)?.rate;
}

/**
 * The phrases and marks the owner repeats across their own texts, each with
 * the share of texts that carry it, most used first. Found in their writing —
 * nothing here names a phrase — so a voice that signs off with a face, opens
 * on an interjection or leans on a stock phrase has exactly that, at its own
 * rate, and a voice that repeats nothing has none. Any language: what is a
 * function word is read off the owner's own texts (`tellingWords`).
 */
export function signaturesOf(texts: readonly string[]): VoiceSignature[] {
  const telling = tellingWords(texts);
  const counts = new Map<string, number>();
  for (const text of texts) {
    for (const candidate of signatureCandidates(text, telling)) {
      counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
    }
  }
  const floor = Math.max(SIGNATURE_MIN_TEXTS, Math.ceil(SIGNATURE_SHARE * texts.length));
  const recurring = [...counts]
    .filter(([, count]) => count >= floor)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
  // A run inside one already kept is the same habit.
  const kept: Array<[string, number]> = [];
  for (const [phrase, count] of recurring) {
    if (kept.some(([other]) => overlapping(other, phrase))) continue;
    kept.push([phrase, count]);
  }
  return kept
    .slice(0, MAX_SIGNATURES)
    .map(([phrase, count]) => ({ phrase, rate: share(count, texts.length) }));
}

/** How often a phrase is in the texts: the share of them that use it, as a
 *  signature's rate is a share — what a draft is dealt it at. */
export function signatureShare(texts: readonly string[], phrase: string): number {
  return share(texts.filter((text) => usesSignature(text, phrase)).length, texts.length);
}

/** What may sit between two words of one clause. */
const IN_CLAUSE = String.raw`[^\p{L}\p{N}.,;:!?…()"“”？؟¡¿—\n]+`;

/**
 * The words or the mark in a text that carry the first of the signatures it
 * uses, as they are written there — so a page can mark them — or null where
 * it uses none. A one-word signature is marked where the word first stands.
 */
export function signatureIn(text: string, phrases: readonly string[]): string | null {
  for (const phrase of phrases) {
    if (!usesSignature(text, phrase)) continue;
    const signature = normalSignature(phrase);
    if (!/[\p{L}\p{N}]/u.test(signature)) {
      const mark = [...text.matchAll(MARK)].find(([found]) => normalMark(found) === signature);
      if (mark) return mark[0];
      continue;
    }
    const words = signature.split(" ").map((word) => word.replace(/'/gu, "['’]"));
    const run = new RegExp(
      String.raw`(?<![\p{L}\p{N}'’])${words.join(IN_CLAUSE)}(?![\p{L}\p{N}])`,
      "iu",
    ).exec(text);
    if (run) return run[0];
  }
  return null;
}

/** The text uses the signature: its words in a run within one clause — a
 *  one-word one opening a clause — or its mark anywhere. */
export function usesSignature(text: string, phrase: string): boolean {
  const signature = normalSignature(phrase);
  if (!signature) return false;
  if (!/[\p{L}\p{N}]/u.test(signature)) return marksOf(text).includes(signature);
  const single = !signature.includes(" ");
  return clausesOf(text).some((words) =>
    single ? words[0] === signature : ` ${words.join(" ")} `.includes(` ${signature} `),
  );
}

export type MeasuredVoiceTraits = {
  traits: VoiceTraits;
  /** Owner-written texts measured. */
  samples: number;
  /** Of which asked a question — the evidence behind `eitherOrRate`. */
  questions: number;
  /** Of which set an aside off — the evidence behind `asideStyle`. */
  asides: number;
};

/** The way most of the asides are set off; none where two ways tie. */
function majorityAside(asides: readonly AsideStyle[]): AsideStyle | null {
  const counts = new Map<AsideStyle, number>();
  for (const style of asides) counts.set(style, (counts.get(style) ?? 0) + 1);
  const [first, second] = [...counts].sort((a, b) => b[1] - a[1]);
  return first && first[1] !== second?.[1] ? first[0] : null;
}

/** How formal a set of English texts reads. */
function registerOf(window: readonly string[]): NonNullable<VoiceTraits["register"]> {
  const n = window.length;
  const casual = window.filter(readsCasual).length;
  const formal = window.filter(readsFormal).length;
  return casual / n >= 0.5 ? "casual" : formal / n >= 0.5 ? "formal" : "neutral";
}

/** The texts a measurement reads: the newest `TRAIT_WINDOW`, trimmed, none
 *  blank. */
export function traitWindow<T>(items: readonly T[], textOf: (item: T) => string): T[] {
  return items.filter((item) => textOf(item).trim()).slice(0, TRAIT_WINDOW);
}

/**
 * What the owner's own texts, newest first, show about how they write. Pure.
 * Null below `TRAIT_MIN_SAMPLES`: a couple of comments are an anecdote, not a
 * habit. In a voice that does not write in English (`language`), what is
 * read off English words — register, advice, moves, tags, either/or
 * questions — and off English capitals — how specifically a post is named —
 * is not measured at all, and a question is a question mark.
 */
export function measureVoiceTraits(
  texts: readonly string[],
  opts: { language?: string | null } = {},
): MeasuredVoiceTraits | null {
  const window = traitWindow(texts, (text) => text).map((text) => text.trim());
  const n = window.length;
  if (n < TRAIT_MIN_SAMPLES) return null;
  const english = readsEnglish(opts.language);

  const lengths = window.map(wordCount).sort((a, b) => a - b);
  const questioning = window.filter((text) => asksQuestion(text, english));
  const traits: VoiceTraits = {
    ...(english ? { register: registerOf(window) } : {}),
    lengthWords: { min: percentile(lengths, 0.2), max: percentile(lengths, 0.8) },
    questionRate: share(questioning.length, n),
    ...(english
      ? {
          adviceRate: share(window.filter((text) => volunteeredAdvice(text) != null).length, n),
          movesPerComment:
            Math.round((window.reduce((sum, text) => sum + movesIn(text), 0) / n) * 100) / 100,
          tagPhraseRate: share(window.filter((text) => tagPhrase(text) != null).length, n),
        }
      : {}),
    exclamationRate: share(window.filter((text) => text.includes("!")).length, n),
    bareEndingRate: share(window.filter(endsBare).length, n),
    colonRate: share(window.filter(usesColon).length, n),
    ...(english ? { specificityRate: share(window.filter(namesSpecifics).length, n) } : {}),
  };
  const asides = window.map(asideIn).filter((style): style is AsideStyle => style !== null);
  const aside = asides.length >= TRAIT_MIN_ASIDES ? majorityAside(asides) : null;
  if (aside) traits.asideStyle = aside;
  if (english && questioning.length >= TRAIT_MIN_QUESTIONS) {
    traits.eitherOrRate = share(
      questioning.filter((text) => eitherOrQuestion(text) != null).length,
      questioning.length,
    );
  }
  const openers = habitualPhrases(
    window.map((text) => wordsOf(text).map(bare).filter(Boolean)),
    n,
  );
  if (openers.length > 0) traits.openers = openers.map((o) => o.phrase);
  const closers = habitualPhrases(
    window.map((text) => {
      const words = wordsOf(sentencesOf(text).at(-1) ?? "").map(bare).filter(Boolean);
      return words.slice(-2).reverse();
    }),
    n,
  ).map((c) => ({ ...c, phrase: c.phrase.split(" ").reverse().join(" ") }));
  if (closers.length > 0) traits.closers = closers.map((c) => c.phrase);
  const signatures = withEdgePhrases(window, signaturesOf(window), [...openers, ...closers]);
  if (signatures.length > 0) traits.signatures = signatures;
  return { traits, samples: n, questions: questioning.length, asides: asides.length };
}

export type TraitKey = Exclude<keyof VoiceTraits, "evidence" | "language">;
export type TraitSource = "owner" | "learned";

/**
 * The traits a voice writes by: each one the owner set, else the measured
 * one — carrying, for the measured ones, how much of the owner's writing they
 * rest on (`VoiceTraits.evidence`), which is what decides whether a measured
 * "does not do" binds the judge and the gate or only guides the writer.
 */
export function resolveVoiceTraits(
  measured: MeasuredVoiceTraits | null | undefined,
  ownerSet: VoiceTraits | null | undefined,
  opts: {
    language?: string | null;
    /** The voice's `DraftingKnobs.voiceStrictness`. */
    strictness?: DraftingKnobs["voiceStrictness"];
  } = {},
): VoiceTraits {
  const resolved: VoiceTraits = { ...(measured?.traits ?? {}) };
  const set = new Set<string>();
  for (const [key, value] of Object.entries(ownerSet ?? {})) {
    if (key === "evidence" || key === "language" || value === undefined || value === null) continue;
    (resolved as Record<string, unknown>)[key] = value;
    set.add(key);
  }
  const learned = (Object.keys(measured?.traits ?? {}) as TraitKey[]).filter((key) => !set.has(key));
  if (measured && learned.length > 0) {
    resolved.evidence = {
      learned,
      texts: measured.samples,
      questions: measured.questions,
      asides: measured.asides,
      ...(opts.strictness && opts.strictness !== "normal" ? { strictness: opts.strictness } : {}),
    };
  }
  // The detectors built on English words step aside for any other language.
  if (!readsEnglish(opts.language) && Object.keys(resolved).length > 0) {
    resolved.language = opts.language!.trim();
  }
  return resolved;
}

/** Where each resolved trait came from — for the owner reading their voice. */
export function traitProvenance(
  measured: VoiceTraits | null | undefined,
  ownerSet: VoiceTraits | null | undefined,
): Partial<Record<TraitKey, TraitSource>> {
  const out: Partial<Record<TraitKey, TraitSource>> = {};
  for (const key of Object.keys(measured ?? {}) as TraitKey[]) out[key] = "learned";
  for (const [key, value] of Object.entries(ownerSet ?? {}) as [TraitKey, unknown][]) {
    if (value !== undefined && value !== null) out[key] = "owner";
  }
  return out;
}

/** A share smoothed toward the middle by half a text each way, (k + ½)/(n + 1):
 *  thin evidence never reads as a firm 0 or 1. */
const smoothedShare = (rate: number, n: number) => (rate * n + 0.5) / (n + 1);

/** How much of the owner's writing a measured trait takes to bind the judge
 *  and the gate, by the voice's `voiceStrictness` (`VoiceTraits.evidence`):
 *  none is enough when it is loose, the measurement floors are when it is
 *  strict. */
export function bindFloor(
  traits: VoiceTraits | undefined,
): { texts: number; questions: number; asides: number } | null {
  return bindFloorAt(traits?.evidence?.strictness);
}

/** `bindFloor` at a strictness, for a reader that holds the voice's knob
 *  rather than a measurement. */
export function bindFloorAt(
  strictness: DraftingKnobs["voiceStrictness"] | undefined,
): { texts: number; questions: number; asides: number } | null {
  switch (strictness) {
    case "loose":
      return null;
    case "strict":
      return { texts: TRAIT_MIN_SAMPLES, questions: TRAIT_MIN_QUESTIONS, asides: TRAIT_MIN_ASIDES };
    default:
      return { texts: TRAIT_BIND_TEXTS, questions: TRAIT_BIND_QUESTIONS, asides: TRAIT_BIND_ASIDES };
  }
}

/** The "does not do" traits, each as the share of texts that DO it. */
export type AvoidKey =
  | "questionRate"
  | "eitherOrRate"
  | "adviceRate"
  | "movesPerComment"
  | "tagPhraseRate"
  | "colonRate";

/** The share of texts that do it: for moves, which are one or two a text, the
 *  share that stacks two. */
function shareOf(traits: VoiceTraits | undefined, key: AvoidKey): number | undefined {
  const value = traits?.[key];
  if (value === undefined) return undefined;
  return key === "movesPerComment" ? Math.round((value - 1) * 100) / 100 : value;
}

export type Avoidance = "binds" | "leans" | "rationed";

/**
 * How a voice holds what it does in under `TRAIT_AVOID` of its writing.
 * "binds": none of it — the owner set none, or none shows in enough of their
 * writing (`bindFloor`) — and the judge and the gate hold every draft to that.
 * "leans": none so far, on thinner evidence, and the writer is told so,
 * softly. "rationed": some of it, however little, set or measured. A rare
 * habit is still the owner's: a draft is dealt it at about their rate, and
 * only a run of drafts past that rate is flagged (`rationedHabits`,
 * learning/styleVariety.ts) — never one draft for having it. Null: a habit at
 * or over `TRAIT_AVOID`, which the writer is told at its rate.
 */
export function avoidance(traits: VoiceTraits | undefined, key: AvoidKey): Avoidance | null {
  const share = shareOf(traits, key);
  if (share === undefined || share >= TRAIT_AVOID) return null;
  if (share > 0) return "rationed";
  const evidence = traits?.evidence;
  if (!evidence?.learned.includes(key)) return "binds";
  const floor = bindFloor(traits);
  if (!floor) return "leans";
  const [n, needed] =
    key === "eitherOrRate"
      ? [evidence.questions, floor.questions]
      : [evidence.texts, floor.texts];
  return n >= needed ? "binds" : "leans";
}

/** A habit a voice has at a low rate, as a run of drafts is held to it. */
export type RationedHabit = {
  key: AvoidKey;
  /** The share of the owner's texts that have it — of their questions, for
   *  how they ask. */
  rate: number;
  /** What it is, as a draft is told to leave it out and a run is flagged. */
  label: string;
  /** The text has it. */
  carries: (text: string) => boolean;
  /** The texts its rate is a share of: those that ask, for how they ask. */
  among: (text: string) => boolean;
};

const HABITS: Record<
  AvoidKey,
  { label: string; carries: (text: string, english: boolean) => boolean; anyLanguage?: true }
> = {
  questionRate: { label: "a question", carries: asksQuestion, anyLanguage: true },
  eitherOrRate: {
    label: "a question that hands over two options",
    carries: (text) => eitherOrQuestion(text) != null,
  },
  adviceRate: {
    label: `volunteered advice ("I would…", "I'd…")`,
    carries: (text) => volunteeredAdvice(text) != null,
  },
  movesPerComment: {
    label: "advice and a question in one comment",
    carries: (text) => movesIn(text) > 1,
  },
  tagPhraseRate: { label: "a short tag as the reaction", carries: (text) => tagPhrase(text) != null },
  colonRate: {
    label: "a clause set off with a colon mid-sentence",
    carries: (text) => usesColon(text),
    anyLanguage: true,
  },
};

/** What a voice does rarely ("rationed"), each with the detector a run of
 *  drafts is counted by. A detector built on English words reads an English
 *  voice only, as everywhere else here. */
export function rationedHabits(traits: VoiceTraits | undefined): RationedHabit[] {
  const english = readsEnglish(traits?.language);
  return (Object.keys(HABITS) as AvoidKey[]).flatMap((key) => {
    const habit = HABITS[key];
    if (avoidance(traits, key) !== "rationed" || (!english && !habit.anyLanguage)) return [];
    return [
      {
        key,
        rate: shareOf(traits, key)!,
        label: habit.label,
        carries: (text: string) => habit.carries(text, english),
        among:
          key === "eitherOrRate" ? (text: string) => asksQuestion(text, english) : () => true,
      },
    ];
  });
}

/**
 * How firmly a voice holds its register: firm where the owner set it, or on
 * `bindFloor` texts of theirs; a lean below. Never rationed — rationing deals
 * phrases, and a draft that leaves one out still sounds like its owner.
 */
export function registerLevel(traits: VoiceTraits | undefined): "binds" | "leans" | null {
  if (!traits?.register || traits.register === "neutral") return null;
  const evidence = traits.evidence;
  if (!evidence?.learned.includes("register")) return "binds";
  const floor = bindFloor(traits);
  return floor && evidence.texts >= floor.texts ? "binds" : "leans";
}

/**
 * How firmly a voice names the figures and names of what it answers — "high"
 * — or refers to them loosely — "low". Firm where the owner set the rate, or
 * where `bindFloor` texts of theirs show it with the smoothed share
 * (`smoothedShare`) still past the line; a lean below that.
 */
export function specificity(
  traits: VoiceTraits | undefined,
): { side: "high" | "low"; level: "binds" | "leans" } | null {
  const rate = traits?.specificityRate;
  if (rate === undefined) return null;
  const side = rate >= SPECIFIC_HIGH ? "high" : rate < SPECIFIC_LOW ? "low" : null;
  if (side === null) return null;
  const evidence = traits?.evidence;
  if (!evidence?.learned.includes("specificityRate")) return { side, level: "binds" };
  const floor = bindFloor(traits);
  const n = evidence.texts;
  const smoothed = smoothedShare(rate, n);
  const past = side === "high" ? smoothed >= SPECIFIC_HIGH : smoothed < SPECIFIC_LOW;
  return { side, level: floor && n >= floor.texts && past ? "binds" : "leans" };
}

/** How firmly a voice sets its asides off its own way: firm where the owner
 *  set it, or on `bindFloor` asides of theirs. */
export function asideLevel(traits: VoiceTraits | undefined): "binds" | "leans" | null {
  if (!traits?.asideStyle) return null;
  const evidence = traits.evidence;
  if (!evidence?.learned.includes("asideStyle")) return "binds";
  const floor = bindFloor(traits);
  return floor && (evidence.asides ?? 0) >= floor.asides ? "binds" : "leans";
}

/** An aside's way, as the writer is told it and as the judge names it. */
export const ASIDE_WAYS: Record<AsideStyle, { use: string; not: string }> = {
  spaced_hyphen: { use: `a spaced hyphen ("this - that")`, not: "a colon or an em dash" },
  em_dash: { use: "an em dash (—)", not: "a colon or a spaced hyphen" },
  parentheses: { use: "parentheses", not: "a dash or a colon" },
  comma: { use: "commas", not: "a dash, a colon or parentheses" },
};

const percent = (rate: number) => `${Math.round(rate * 100)}%`;

/**
 * The traits as lines for a writer — every value is the voice's own. A trait
 * the voice does not have renders nothing, so a voice with none keeps a
 * byte-identical prompt. What the voice never does reads firm where it binds
 * and as a lean where the evidence is still thin; what it does rarely reads at
 * its rate, and a habit with a share at that share.
 */
export function renderVoiceTraits(traits: VoiceTraits | undefined): string[] {
  if (!traits) return [];
  const lines: string[] = [];
  const say = (key: AvoidKey, firm: string, soft: string, rare: (share: string) => string) => {
    const level = avoidance(traits, key);
    if (level === "rationed") lines.push(rare(percent(shareOf(traits, key)!)));
    else if (level) lines.push(level === "binds" ? firm : soft);
    return level !== null;
  };
  const quoted = (phrases: string[]) =>
    phrases
      .map((phrase) => {
        const rate = signatureRate(traits, phrase);
        return rate === undefined ? `"${phrase}"` : `"${phrase}" (about ${percent(rate)} of what you write)`;
      })
      .join(", ");
  if (traits.register === "casual") {
    lines.push("You write casually: plain words, short sentences, contractions; polished, tidy phrasing is not how you sound.");
  } else if (traits.register === "formal") {
    lines.push("You write in complete, considered sentences; no slang.");
  }
  if (traits.lengthWords) {
    lines.push(`What you write usually runs ${traits.lengthWords.min}-${traits.lengthWords.max} words.`);
  }
  if (traits.openers?.length) {
    lines.push(`Openers you actually use: ${quoted(traits.openers)}. Reach for one only where it fits.`);
  }
  if (traits.closers?.length) {
    lines.push(`How you tend to end: ${quoted(traits.closers)}.`);
  }
  const q = traits.questionRate;
  const askingLine = (rate: number) =>
    rate < 0.4
      ? `You ask a question in about ${percent(rate)} of what you write; most of it ends on a statement.`
      : rate > 0.7
        ? "You usually ask one question, about their specific situation."
        : `You ask a question about ${percent(rate)} of the time, only when you want to know.`;
  if (
    q !== undefined &&
    !say(
      "questionRate",
      "You almost never ask a question: end on a statement.",
      "From what you have written so far, you seldom ask a question; a statement usually does it.",
      () => askingLine(q),
    )
  ) {
    lines.push(askingLine(q));
  }
  say(
    "eitherOrRate",
    "When you ask, you ask one thing: never two options to pick from.",
    "So far, when you ask, you ask one thing rather than offering two options.",
    (share) => `Once in a while (about ${share} of your questions) you hand over two options; mostly you ask one thing.`,
  );
  const advice = traits.adviceRate;
  if (
    !say(
      "adviceRate",
      `You don't volunteer advice ("I would…", "I'd…"): react or ask instead.`,
      "So far you seldom volunteer advice; reacting or asking is more like you.",
      (share) => `Now and then (about ${share} of what you write) you say what you would do; reacting or asking is more like you.`,
    ) &&
    advice !== undefined &&
    advice >= ADVICE_HABIT
  ) {
    lines.push("You often say what you would do in their place.");
  }
  say(
    "movesPerComment",
    "One move at a time: a reaction, a question or a point, never advice and a question together.",
    "You tend to make one move at a time.",
    (share) => `You mostly make one move at a time; advice and a question together are rare for you (about ${share}).`,
  );
  say(
    "tagPhraseRate",
    `You never react with a short tag, whether it opens a sentence, closes one or stands as one ("Kudos on…", "…, love it.", "Hats off.").`,
    `You seldom react with a short tag opening or closing a sentence ("Kudos on…", "…, love it.").`,
    (share) => `Now and then (about ${share} of what you write) you react with a short tag opening or closing a sentence; most of what you write does without one.`,
  );
  const named = specificity(traits);
  if (named?.side === "high") {
    lines.push(
      named.level === "binds"
        ? `Name the exact numbers and product names from the post, never a stand-in like "the tool" or "your growth".`
        : "So far you tend to name the post's exact numbers and product names.",
    );
  } else if (named?.side === "low") {
    lines.push(
      named.level === "binds"
        ? `Refer to the post's numbers and product names loosely ("that growth", "this approach") and don't quote them back; a number of yours comes only from your own experience.`
        : "So far you refer to the post's numbers and product names loosely rather than quoting them back.",
    );
  }
  if (
    !say(
      "colonRate",
      "You don't set a clause off with a colon mid-sentence.",
      "So far you seldom use a colon mid-sentence.",
      (share) => `A colon mid-sentence is rare for you (about ${share} of what you write).`,
    ) &&
    traits.colonRate !== undefined &&
    traits.colonRate >= COLON_HABIT
  ) {
    lines.push("Colons are part of how you write: keep one where it sets up what follows.");
  }
  const aside = traits.asideStyle;
  const asideFirmness = asideLevel(traits);
  if (aside && asideFirmness) {
    const way = ASIDE_WAYS[aside];
    lines.push(
      asideFirmness === "binds"
        ? `Set an aside off with ${way.use}, not ${way.not}.`
        : `So far you set an aside off with ${way.use} rather than ${way.not}.`,
    );
  }
  if (traits.exclamationRate !== undefined) {
    if (traits.exclamationRate < EXCLAMATION_RARE) lines.push("Exclamation marks are rare for you.");
    else if (traits.exclamationRate >= EXCLAMATION_FREE) lines.push("You use exclamation marks freely.");
  }
  if (traits.bareEndingRate !== undefined && traits.bareEndingRate >= BARE_ENDING_HABIT) {
    lines.push("You often leave the last sentence without a full stop.");
  }
  return lines;
}

export type TraitStrength = "firm" | "guides" | "free";

/** The traits whose "does not" can bind, by the evidence each is counted
 *  in. */
const AVOID_KEYS: readonly AvoidKey[] = [
  "questionRate",
  "eitherOrRate",
  "adviceRate",
  "movesPerComment",
  "tagPhraseRate",
  "colonRate",
];

/**
 * How firmly one resolved trait holds a draft, in the owner's three words —
 * the one answer the Voice page shows, built from the same rules the writer's
 * lines (`renderVoiceTraits`) and the judge's tells (`voiceTraitTells`) are:
 *
 * - "firm": the judge and the gate hold a draft to it — it binds
 *   (`avoidance`, `specificity`, `asideLevel`, `registerLevel`);
 * - "guides": the writer is told, and nothing is blocked — a lean, a rare
 *   habit dealt to drafts at its rate, or a habit the writer gets a line for;
 * - "free": the writer is told nothing, so drafts may do it or not.
 *
 * Null when the voice has no value for the trait. Adds no threshold of its
 * own: each one here is the renderer's. A voice's `signatures` are free: the
 * writer gets no line for them as a habit — each is dealt to drafts at the
 * owner's own rate (`draft.ts`), so drafts carry it about as often as they
 * do, and only a run of drafts that overuses one is the judge's (`slop.ts`).
 */
export function traitStrength(
  traits: VoiceTraits | undefined,
  key: TraitKey,
): TraitStrength | null {
  const value = traits?.[key];
  if (value === undefined) return null;
  const level = (binds: Avoidance | null): TraitStrength | null =>
    binds === "binds" ? "firm" : binds === "leans" || binds === "rationed" ? "guides" : null;
  if ((AVOID_KEYS as readonly string[]).includes(key)) {
    const avoided = level(avoidance(traits, key as AvoidKey));
    if (avoided) return avoided;
  }
  switch (key) {
    case "specificityRate":
      return level(specificity(traits)?.level ?? null) ?? "free";
    case "asideStyle":
      return level(asideLevel(traits));
    case "register":
      return level(registerLevel(traits)) ?? "free";
    case "questionRate":
    case "lengthWords":
      return "guides";
    case "openers":
    case "closers":
      return (value as string[]).length > 0 ? "guides" : "free";
    case "adviceRate":
      return (value as number) >= ADVICE_HABIT ? "guides" : "free";
    case "colonRate":
      return (value as number) >= COLON_HABIT ? "guides" : "free";
    case "exclamationRate":
      return (value as number) < EXCLAMATION_RARE || (value as number) >= EXCLAMATION_FREE
        ? "guides"
        : "free";
    case "bareEndingRate":
      return (value as number) >= BARE_ENDING_HABIT ? "guides" : "free";
    default:
      return "free";
  }
}

/** The traits as tells for the judge: only what this voice binds itself not
 *  to do, and a register that is not its own. */
export function voiceTraitTells(traits: VoiceTraits | undefined): string[] {
  const binds = (key: AvoidKey) => avoidance(traits, key) === "binds";
  const tells: string[] = [];
  if (registerLevel(traits) === "binds") {
    tells.push(
      traits?.register === "casual"
        ? "polished, tidy or analytic phrasing — this person writes casually: plain words, short sentences, contractions"
        : "slang, shorthand or a throwaway fragment — this person writes in complete, considered sentences",
    );
  }
  if (binds("questionRate")) tells.push("a question (this person almost never asks one)");
  if (binds("eitherOrRate")) tells.push(`a question that hands over two options ("…, A or B?"), however it ends — this person asks one thing`);
  if (binds("adviceRate")) tells.push(`volunteered advice ("I would…", "I'd…") — this person doesn't give it unasked`);
  if (binds("movesPerComment")) tells.push("advice AND a question stacked in one comment — this person makes one move at a time");
  if (binds("tagPhraseRate")) tells.push(`a short tag as the reaction, opening, closing or standing as a sentence ("Kudos on…", "…, love it.", "Hats off.") — this person never does that`);
  if (binds("colonRate")) tells.push("a clause set off with a colon mid-sentence — this person doesn't write them");
  if (traits?.asideStyle && asideLevel(traits) === "binds") {
    const way = ASIDE_WAYS[traits.asideStyle];
    tells.push(`an aside set off with ${way.not} — this person uses ${way.use}`);
  }
  const named = specificity(traits);
  if (named?.level === "binds") {
    tells.push(
      named.side === "high"
        ? `a generic stand-in ("the tool", "your growth") for a number or name the post gives — this person names the exact ones`
        : "the post's exact numbers or product names quoted back — this person refers to them loosely",
    );
  }
  return tells;
}

export type TraitViolation = { rule: string; detail: string };

/**
 * Deterministic: what a draft does that this voice binds itself not to do.
 * Regex-only, so the LLM-free intake gate can run it. `ownerStory` says the
 * draft tells one of the owner's documented stories, which is what makes
 * advice a point from experience rather than a tip nobody asked for. For a
 * voice that does not write in English only a question mark is read here;
 * the judge holds the rest of what it binds.
 */
export function voiceTraitViolations(
  text: string,
  traits: VoiceTraits | undefined,
  opts: { ownerStory?: boolean } = {},
): TraitViolation[] {
  const binds = (key: AvoidKey) => avoidance(traits, key) === "binds";
  const english = readsEnglish(traits?.language);
  const v: TraitViolation[] = [];
  if (binds("questionRate") && asksQuestion(text, english)) {
    v.push({ rule: "voice_question", detail: "asks a question — this voice almost never does" });
  }
  if (!english) return v;
  const choice = binds("eitherOrRate") ? eitherOrQuestion(text) : null;
  if (choice) {
    v.push({ rule: "voice_either_or", detail: `"${choice}" hands over two options — this voice asks one thing` });
  }
  const advice = binds("adviceRate") && opts.ownerStory !== true ? volunteeredAdvice(text) : null;
  if (advice) {
    v.push({ rule: "voice_advice", detail: `"${advice}…" volunteers advice — this voice doesn't` });
  }
  if (binds("movesPerComment") && movesIn(text) > 1) {
    v.push({ rule: "voice_stacked_moves", detail: "advice and a question together — this voice makes one move at a time" });
  }
  const tag = binds("tagPhraseRate") ? tagPhrase(text) : null;
  if (tag) {
    v.push({ rule: "voice_tag_phrase", detail: `"${tag}" is a tag set off as the reaction — this voice doesn't do that` });
  }
  return v;
}
