import { repeatedRun } from "../ai/intakeGate";
import { containsRawUrl } from "../ai/slop";
import { bannedOpenerIn, wholeWord } from "../ai/styleRules";
import {
  colonIn,
  eitherOrQuestion,
  questionsIn,
  signatureIn,
  tagPhrase,
  usesSignature,
  volunteeredAdvice,
  wordCount,
} from "../ai/voiceTraits";
import { endsWithQuestion } from "../learning/styleVariety";
import { attributeOwnerStory, type OwnerStory } from "../operations/ownerStories";
import { normalize } from "../workers/evidenceReview";
import { PLAN_HABITS, type DraftPlan, type PlanHabit, type PlanVerdict } from "./types";

/**
 * The judge's code layer (spec "Draft Dispatcher" v0.3): every plan item code
 * can decide exactly, checked before a model is asked about the rest. Each
 * check is the detector the owner's own texts are measured or rationed by, so
 * a draft is held to a mark, a habit or a length the way the owner sets it.
 * What code can repair without touching meaning — a face, an emoji or a
 * trailing "..." the plan leaves out, a forbidden dash — it repairs
 * (`fixByCode`); every other miss is left for a rewrite.
 */

/** What the checks need that a plan does not carry. */
export type CodeJudgeContext = {
  /** What the account sent, or approved, lately (`sentTexts`). */
  sent: readonly string[];
  /** The owner's stories, to tell which one a draft tells. */
  stories: readonly Pick<OwnerStory, "id" | "title" | "content">[];
  /** The owner's product names. */
  productNames: readonly string[];
  /** All they wrote that an opener answers: the fifty-people test finds a run
   *  of their words anywhere in it, not only in the lines its plan quotes. */
  theirWords?: string;
};

/** How each rated habit is found in a draft, the way the voice measures it. */
const HABITS: Record<PlanHabit, { label: string; find: (text: string) => string | null }> = {
  eitherOrRate: { label: "a question that hands over two options", find: eitherOrQuestion },
  adviceRate: {
    label: "volunteered advice",
    find: (text) => {
      const advice = volunteeredAdvice(text);
      return advice ? `${advice}…` : null;
    },
  },
  tagPhraseRate: { label: "a short tag as the reaction", find: tagPhrase },
  colonRate: {
    label: "a clause set off with a colon",
    find: (text) => {
      const colon = colonIn(text);
      return colon ? inContext(text, colon) : null;
    },
  },
  // Any "!" at all, as `measureVoiceTraits` counts the owner's.
  exclamationRate: { label: "an exclamation mark", find: (text) => quoteOf(text, /!/u) },
};

/** An em dash, or an en dash set off by spaces as one; never a range ("2–3"). */
const DASH = /\s*—\s*|\s+–\s+/u;
/** A semicolon that closes a clause; never the one in a wink. */
const SEMICOLON = /(?<=[\p{L}\p{N}"'’)\]]);(?=\s|$)/u;
const EMOJI = /\p{Extended_Pictographic}/gu;
/** Words of a story named by its opening, where it has no title. */
const STORY_NAME_WORDS = 6;

/** A verdict on one plan item, citing the rules behind it. */
function verdict(plan: DraftPlan, item: string, pass: boolean, detail: string): PlanVerdict {
  const ruleIds = plan.sources[item];
  return { item, pass, by: "code", detail, ...(ruleIds ? { ruleIds } : {}) };
}

/** `text.slice(at, at + length)` with the word either side of it. */
function around(text: string, at: number, length: number): string {
  const before = /\S*\s*$/u.exec(text.slice(0, at))?.[0] ?? "";
  const after = /^\s*\S*/u.exec(text.slice(at + length))?.[0] ?? "";
  return `${before}${text.slice(at, at + length)}${after}`.trim();
}

/** The first match of `pattern` with the word either side of it, or null. */
function quoteOf(text: string, pattern: RegExp): string | null {
  const match = pattern.exec(text);
  return match ? around(text, match.index, match[0].length) : null;
}

/** `found`, a part of the text, with the word either side of it. */
function inContext(text: string, found: string): string {
  const at = text.indexOf(found);
  return at < 0 ? found : around(text, at, found.length);
}

/** Where the draft carries one of the voice's marks, in context, or null:
 *  matched as rationing matches it. */
function markIn(text: string, phrase: string): string | null {
  return usesSignature(text, phrase) ? inContext(text, signatureIn(text, [phrase]) ?? phrase) : null;
}

/** `word` where the text has it as a whole word, as written there. */
function wholeWordIn(text: string, word: string): string | null {
  return word.trim() ? (wholeWord(word).exec(text)?.[0] ?? null) : null;
}

/** A story as the owner knows it: its title, else its opening words. */
function storyName(story: { title?: string | null; content: string }): string {
  if (story.title) return story.title;
  const words = story.content.trim().split(/\s+/u);
  return words.length > STORY_NAME_WORDS
    ? `${words.slice(0, STORY_NAME_WORDS).join(" ")}…`
    : words.join(" ");
}

/** The verdict on something a plan allows or leaves out, `found` quoting it
 *  where the draft has it. */
function presence(
  plan: DraftPlan,
  item: string,
  allowed: boolean,
  label: string,
  found: string | null,
): PlanVerdict {
  if (found == null) {
    return verdict(plan, item, true, `Leaves out ${label}, ${allowed ? "which this draft allows" : "as planned"}`);
  }
  return verdict(plan, item, allowed, `Has ${label} ("${found}"), which this draft ${allowed ? "allows" : "leaves out"}`);
}

/** The verdict on something the plan puts in the draft. */
function carried(plan: DraftPlan, item: string, label: string, found: string | null): PlanVerdict {
  return found == null
    ? verdict(plan, item, false, `Leaves out ${label}, which this draft was planned to carry`)
    : verdict(plan, item, true, `Carries ${label} ("${found}"), as planned`);
}

function lengthVerdict(plan: DraftPlan, text: string): PlanVerdict {
  const { minWords, maxWords, maxChars } = plan.length;
  const words = wordCount(text);
  // A hard limit first: a note past it cannot be sent, whatever its words.
  if (maxChars !== undefined && text.length > maxChars) {
    return verdict(plan, "length", false, `Runs ${text.length} characters, past the ${maxChars} it may take`);
  }
  if (words > maxWords) return verdict(plan, "length", false, `Runs ${words} words, past the planned ${maxWords}`);
  if (words < minWords) return verdict(plan, "length", false, `Runs ${words} words, short of the planned ${minWords}`);
  return verdict(plan, "length", true, `Runs ${words} words, within the planned ${minWords} to ${maxWords}`);
}

/** One question the draft ends on, or none at all: counted the way the
 *  voice's question rate is, so one that trails off with no "?" is asked. */
function questionVerdict(plan: DraftPlan, text: string): PlanVerdict {
  const questions = questionsIn(text);
  const asked = questions.map((question) => `"${question}"`).join(", ");
  if (!plan.question.ask) {
    return questions.length === 0
      ? verdict(plan, "question", true, "Asks no question, as planned")
      : verdict(plan, "question", false, `Asks ${asked}, and this draft was planned to ask nothing`);
  }
  const [question] = questions;
  if (question === undefined) {
    return verdict(plan, "question", false, "Asks no question, and this draft was planned to end on one");
  }
  if (questions.length > 1) {
    return verdict(plan, "question", false, `Asks ${questions.length} questions (${asked}), and this draft asks one`);
  }
  if (endsWithQuestion(text)) {
    return verdict(plan, "question", true, `Ends on its one question ("${question}"), as planned`);
  }
  return verdict(
    plan,
    "question",
    false,
    /[?？؟]/u.test(question)
      ? `Goes on past its question ("${question}"), and this draft was planned to end on it`
      : `Asks "${question}" without a question mark`,
  );
}

function wordVerdicts(plan: DraftPlan, text: string): PlanVerdict[] {
  const { bannedOpeners, avoidWords, emojiMax } = plan.words;
  const opener = bannedOpenerIn(text, bannedOpeners);
  const avoided = avoidWords.flatMap((word) => {
    const found = wholeWordIn(text, word);
    return found ? [`"${found}"`] : [];
  });
  const emoji = text.match(EMOJI) ?? [];
  const emojiLine =
    emoji.length > emojiMax
      ? `Has ${emoji.length} emoji (${emoji.join(" ")}), past the ${emojiMax} this draft allows`
      : emoji.length === 0
        ? "Has no emoji"
        : `Has ${emoji.length} emoji, within the ${emojiMax} allowed`;
  return [
    opener
      ? verdict(plan, "words.bannedOpeners", false, `Opens with "${opener}", an opener this draft never uses`)
      : verdict(plan, "words.bannedOpeners", true, "Opens on none of the banned openers"),
    avoided.length > 0
      ? verdict(
          plan,
          "words.avoidWords",
          false,
          `Has ${avoided.join(", ")}, ${avoided.length === 1 ? "a word" : "words"} this draft avoids`,
        )
      : verdict(plan, "words.avoidWords", true, "Has none of the words to avoid"),
    verdict(plan, "words.emojiMax", emoji.length <= emojiMax, emojiLine),
  ];
}

/** A long run of words already sent, the planned story's earlier tellings
 *  among them. */
function repeatVerdict(plan: DraftPlan, text: string, sent: readonly string[]): PlanVerdict {
  const run = repeatedRun(text, [...sent, ...(plan.story?.avoidWordings ?? [])]);
  if (!run) return verdict(plan, "repeat", true, "Repeats nothing word for word from a comment already sent");
  const quote = run.split(" ").slice(0, 12).join(" ");
  return verdict(plan, "repeat", false, `Repeats "${quote}" word for word from a comment already sent`);
}

/** Words too common to make a run anyone's own: "from the start" is in
 *  every other comment. */
const COMMON_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "so", "of", "to", "in", "on", "at", "for", "with", "from", "by", "about",
  "is", "are", "was", "be", "it", "its", "it's", "this", "that", "i", "i'm", "you", "we", "they", "my", "our",
  "your", "their", "me", "us", "do", "not", "no", "just", "all", "any", "can", "what", "how", "if", "as", "lot",
]);
/** How long a run of a person's own words must be for a draft to carry it,
 *  and how many of its words no one writes as a matter of course. */
const OWN_RUN = 3;
const OWN_RUN_WORDS = 2;

/** A text's words as the fifty-people test compares them. */
function wordsOf(text: string): string[] {
  return normalize(text).match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) ?? [];
}

/** What their words name that a draft can name back: a number of two digits
 *  or more ("40", "2026", "3.5": a bare "2" is in every other text), or a word
 *  with a capital inside it or a capital past a sentence's first word — a
 *  tool, a place, a company ("HubSpot", "CRM", "Berlin"). "I" names nothing. */
function namedIn(text: string): string[] {
  const numbers = (text.match(/\p{N}+(?:[.,]\p{N}+)*%?/gu) ?? []).filter((number) => (number.match(/\p{N}/gu) ?? []).length >= 2);
  const names = text.split(/(?<=[.!?…])\s+|\n+/u).flatMap((sentence) =>
    (sentence.match(/[\p{L}\p{N}]+(?:['’]\p{L}+)?/gu) ?? []).filter(
      (word, at) => /^.+\p{Lu}/u.test(word) || (at > 0 && /^\p{Lu}/u.test(word) && !/^I(?:['’]\p{L}+)?$/u.test(word)),
    ),
  );
  return [...numbers, ...names];
}

/**
 * THE FIFTY-PEOPLE TEST'S CODE HALF: what of a person's own words a draft
 * carries — a run of three of them, two at least not words anyone writes, or
 * something they named — or null where it carries none, so it could have been
 * written to anyone. `quotes` are their words, as the plan quotes them; a run
 * counts from `whole`, all they wrote, too, while a name counts only from the
 * quotes, since a whole post capitalizes words that name nothing.
 */
export function theirWordsIn(text: string, quotes: readonly string[], whole?: string): string | null {
  const draft = wordsOf(text);
  for (const quote of whole ? [...quotes, whole] : quotes) {
    const theirs = wordsOf(quote);
    const runs = new Set<string>();
    for (let at = 0; at + OWN_RUN <= theirs.length; at++) runs.add(theirs.slice(at, at + OWN_RUN).join(" "));
    for (let at = 0; at + OWN_RUN <= draft.length; at++) {
      const run = draft.slice(at, at + OWN_RUN);
      const own = run.filter((word) => !COMMON_WORDS.has(word)).length >= OWN_RUN_WORDS;
      if (own && runs.has(run.join(" "))) return run.join(" ");
    }
  }
  for (const name of new Set(quotes.flatMap(namedIn))) {
    const found = wholeWordIn(text, name);
    if (found) return found;
  }
  return null;
}

/** The owner's words for a draft that fails the fifty-people test. */
export const COULD_GO_TO_FIFTY = "Could go to 50 other people";

/** The fifty-people test as the writer is told it: what `theirWordsIn` finds. */
export const THEIR_WORDS_LINE = `Carry at least ${OWN_RUN} of their words in a row exactly as they wrote them, from the words it builds on, inside your own sentence and never in quotation marks; or name something they named.`;

/** An opener carries their words, or could go to anyone. */
function specificVerdict(plan: DraftPlan, text: string, theirWords: string | undefined): PlanVerdict {
  const quotes = plan.point.quotes.filter((quote) => quote.source === "post").map((quote) => quote.text);
  const found = theirWordsIn(text, quotes, theirWords);
  return found === null
    ? verdict(plan, "specific", false, `${COULD_GO_TO_FIFTY}: it carries none of their words and names nothing they named`)
    : verdict(plan, "specific", true, `Carries their words ("${found}")`);
}

/** A draft as a story is found in it: the product's name says which product,
 *  never which story, and every introduction of it carries the name. */
function withoutProductNames(text: string, names: readonly string[]): string {
  return names
    .filter((name) => name.trim())
    .reduce((rest, name) => rest.replace(new RegExp(wholeWord(name).source, "giu"), " "), text);
}

/** No story where the plan tells none, and no other where it tells one.
 *  Whether the planned story is told well is the model's to judge. */
function storyVerdict(plan: DraftPlan, text: string, ctx: Pick<CodeJudgeContext, "stories" | "productNames">): PlanVerdict {
  const { stories } = ctx;
  const toldId = attributeOwnerStory(withoutProductNames(text, ctx.productNames), stories);
  const told = stories.find((story) => story.id === toldId);
  if (!plan.story) {
    return told
      ? verdict(plan, "story", false, `Tells your story "${storyName(told)}", and this draft was planned without one`)
      : verdict(plan, "story", true, "Tells no story of yours, as planned");
  }
  const planned = storyName(plan.story);
  if (!told) return verdict(plan, "story", true, `Tells no story of yours but the planned one ("${planned}")`);
  return told.id === plan.story.id
    ? verdict(plan, "story", true, `Tells the planned story ("${planned}")`)
    : verdict(plan, "story", false, `Tells your story "${storyName(told)}", not the planned one ("${planned}")`);
}

/**
 * The plan items code checks exactly, one verdict each, all `by: "code"`:
 * every mark and rated habit the plan decides, the forbidden punctuation,
 * the length, the question, the banned openers, the words to avoid and the
 * emoji cap, a repeat of what was sent, the story, a product or link the
 * plan leaves out, and — for an opener to a lead — the fifty-people test. A
 * mark the plan `use`s is owed, as the plan chose it for this post; a habit
 * it `use`s is allowed, never owed.
 */
export function judgeByCode(plan: DraftPlan, text: string, ctx: CodeJudgeContext): PlanVerdict[] {
  const marks = Object.entries(plan.marks).map(([phrase, choice]) =>
    choice === "use"
      ? carried(plan, `marks.${phrase}`, `"${phrase}"`, markIn(text, phrase))
      : presence(plan, `marks.${phrase}`, false, `"${phrase}"`, markIn(text, phrase)),
  );
  const habits = PLAN_HABITS.flatMap((key) => {
    const choice = plan.habits[key];
    if (!choice) return [];
    const { label, find } = HABITS[key];
    return [presence(plan, `habits.${key}`, choice === "use", label, find(text))];
  });
  const { emDash, semicolon } = plan.punctuation;
  const product = ctx.productNames.map((name) => wholeWordIn(text, name)).find((found) => found != null);
  const link = text.split(/\s+/u).find(containsRawUrl);
  return [
    ...marks,
    ...habits,
    presence(plan, "punctuation.emDash", emDash === "allow", "an em dash", quoteOf(text, DASH)),
    presence(plan, "punctuation.semicolon", semicolon === "allow", "a semicolon", quoteOf(text, SEMICOLON)),
    lengthVerdict(plan, text),
    questionVerdict(plan, text),
    ...wordVerdicts(plan, text),
    repeatVerdict(plan, text, ctx.sent),
    storyVerdict(plan, text, ctx),
    presence(plan, "content.product", plan.content.product, "a product name", product ?? null),
    presence(plan, "content.link", plan.content.link, "a link", link ?? null),
    ...(plan.opener ? [specificVerdict(plan, text, ctx.theirWords)] : []),
  ];
}

/**
 * The text with one mark taken out at `at`, tidied: the space either side
 * closes up, and a full stop takes its place where it stood between two
 * sentences on one line, the next starting on a capital. A doubled "!!" or
 * "?!" keeps one, so a question stays asked.
 */
function withoutMarkAt(text: string, at: number, mark: string): string {
  if (/^[!?]+$/u.test(mark)) {
    return `${text.slice(0, at)}${mark.includes("?") ? "?" : "!"}${text.slice(at + mark.length)}`;
  }
  const before = text.slice(0, at).trimEnd();
  const after = text.slice(at + mark.length).trimStart();
  if (!after) return before.replace(/[\s,;:]+$/u, "");
  if (!before) return after;
  const gap = text.slice(before.length, at) + text.slice(at + mark.length, text.length - after.length);
  if (gap.includes("\n")) return `${before}${gap.replace(/[^\n]/gu, "")}${after}`;
  if (/^[.,!?;)\]]/u.test(after)) return `${before}${after}`;
  if (/^\p{Lu}/u.test(after) && !/[.!?…]["')\]]*$/u.test(before)) {
    return `${before.replace(/[,;:]+$/u, "")}. ${after}`;
  }
  return `${before} ${after}`;
}

/**
 * The repairs that change no meaning, and the plan items they repair: each
 * face, emoji or punctuation mark the plan leaves out comes out (a trailing
 * "..." among them), and a forbidden dash becomes the plan's aside — a spaced
 * hyphen where that is the voice's, else a comma. A mark of words, and every
 * other miss, is left for a rewrite.
 */
export function fixByCode(plan: DraftPlan, text: string): { text: string; fixed: string[] } {
  let out = text;
  const fixed: string[] = [];
  for (const [phrase, choice] of Object.entries(plan.marks)) {
    if (choice !== "omit" || /[\p{L}\p{N}]/u.test(phrase) || !usesSignature(out, phrase)) continue;
    for (let found = signatureIn(out, [phrase]); found; found = signatureIn(out, [phrase])) {
      const next = withoutMarkAt(out, out.indexOf(found), found);
      // A lone "!" or "?" is kept, not removed, so it can never come out.
      if (next === out) break;
      out = next;
    }
    if (usesSignature(out, phrase)) continue;
    fixed.push(`marks.${phrase}`);
  }
  if (plan.punctuation.emDash === "forbid" && DASH.test(out)) {
    out = out.replace(new RegExp(DASH.source, "gu"), plan.punctuation.aside === "spaced_hyphen" ? " - " : ", ");
    fixed.push("punctuation.emDash");
  }
  return { text: out.replace(/[ \t]{2,}/gu, " ").trim(), fixed };
}

/**
 * The code layer end to end: judge, repair what `fixByCode` can, judge the
 * repaired text again. An item the repair settled comes back passing and
 * `fixed`, saying what was found; the text is the original where nothing
 * was repaired.
 */
export function judgeAndFix(
  plan: DraftPlan,
  text: string,
  ctx: CodeJudgeContext,
): { text: string; verdicts: PlanVerdict[] } {
  const verdicts = judgeByCode(plan, text, ctx);
  if (verdicts.every((v) => v.pass)) return { text, verdicts };
  const repair = fixByCode(plan, text);
  if (repair.fixed.length === 0) return { text, verdicts };
  const missed = new Map(verdicts.filter((v) => !v.pass).map((v) => [v.item, v]));
  return {
    text: repair.text,
    verdicts: judgeByCode(plan, repair.text, ctx).map((v) => {
      const miss = missed.get(v.item);
      return v.pass && miss && repair.fixed.includes(v.item)
        ? { ...v, fixed: true, detail: `${miss.detail}; fixed without a rewrite` }
        : v;
    }),
  };
}
