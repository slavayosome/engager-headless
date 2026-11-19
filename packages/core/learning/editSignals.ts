import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import {
  voiceSamples,
  voices,
  type EditSignals,
  type LearnedChannelEdits,
  type LearnedDirective,
  type LearnedDirectives,
  type LearnedEdit,
  type LearnedEditKind,
  type LearnedMove,
  type Voice,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { tagPhrase, volunteeredAdvice } from "../ai/voiceTraits";
import { ensureDefaultVoice, sampleBelongsToVoice, writtenIn, type WritingChannel } from "../voice";
import { learnedEditsIn } from "../voice/habits";

/**
 * LEARNING FROM OWNER EDITS (spec 7).
 *
 * Every save of an offered draft is measured against that draft, by dimension:
 * where the question sits, what the owner added at the start of a sentence,
 * the marks they added, how they write contractions, the slips they leave, how
 * much longer or shorter they made it, and whether a story they were offered
 * stayed, and which of the draft's moves they cut: its closing question, the
 * advice it volunteered, a tag set off at the end of a sentence, its opener.
 * The dimensions are code; every VALUE is read off that voice's own saves. No
 * phrase, mark or slip ships here or in the writer's prompt, and a voice with
 * no measured saves has no directives at all.
 *
 * A directive applies once it shows in at least three of the voice's last ten
 * measured saves, carrying values and rates from its last thirty — so a habit
 * the owner stops showing decays out as newer saves push it past the window.
 */

/** Saves a rollup reads, newest first. */
export const DIRECTIVE_WINDOW = 30;
/** Of which the most recent this many decide what applies. */
export const DIRECTIVE_RECENT = 10;
/** Seen in at least this many of the recent saves to apply. */
export const DIRECTIVE_MIN_SEEN = 3;
/** A length change smaller than this is not a habit. */
const LENGTH_HABIT = 0.15;
/** At most this many of a voice's own phrases or marks go to the writer. */
const MAX_VALUES = 4;

/** A mark, not a word: ":-)", ";)", ":D", "<3", or an emoji (with its skin
 *  tone or joined parts). Read after the punctuation around it is stripped. */
const EMOTICON =
  /^(?:[:;=8][-^'o]?[)(\]\[DPpOo3*|\\/]+|<3|\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|️|‍\p{Extended_Pictographic})*)$/u;
/** An emoji glued to a word is split off it before the words are read. */
const GLUED_EMOJI =
  /(\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|️|‍\p{Extended_Pictographic})*)/gu;
/** A sentence that opens on the writer saying who they are. */
const SELF_SUBJECT = new Set(["i", "i'm", "i've", "i'd", "i'll", "my"]);
/** A contraction, not a possessive: "don't", "I'm", "we've" — never "Ada's". */
const CONTRACTION = /^[a-z]+'(?:t|m|re|ve|ll|d)$/i;
/** Words of a saved sentence's head kept for spotting an opener it repeats. */
const HEAD_WORDS = 4;
/** Two sentences this alike are one sentence, edited. */
const SAME_SENTENCE = 0.4;

type Token = { raw: string; norm: string; mark: boolean };

function tokenize(text: string): Token[] {
  return text
    .replace(GLUED_EMOJI, " $1 ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((raw) => {
      const bare = raw.replace(/^[.,!?;"'(]+|[.,!?;"']+$/g, "");
      const mark = EMOTICON.test(bare);
      return {
        raw: mark ? bare : raw,
        mark,
        norm: mark
          ? bare
          : raw
              .toLowerCase()
              .replace(/’/g, "'")
              .replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, ""),
      };
    })
    // Punctuation left standing alone, as a split-off emoji leaves its stop.
    .filter((token) => token.mark || token.norm !== "");
}

/**
 * A sentence ends at a stop, a mark, or a line break: a LinkedIn comment often
 * puts each thought on its own line with no stop, and "Love it :-) How did you
 * decide?" is two sentences, not a question.
 */
function sentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\n+/)) {
    let current: string[] = [];
    for (const token of tokenize(line)) {
      current.push(token.raw);
      if (token.mark || /[.!?]["')\]]*$/.test(token.raw)) {
        out.push(current.join(" "));
        current = [];
      }
    }
    if (current.length > 0) out.push(current.join(" "));
  }
  return out;
}

/**
 * A word swapped for one a slip away — a typo — as against the same word
 * inflected ("customer" for "customers", "built" for "build"), which is
 * grammar and teaches nothing about slips. A doubled letter dropped or added
 * is a slip wherever it falls.
 */
function isSlip(was: string, now: string): boolean {
  if (was.length < 4 || was === now) return false;
  if (editDistance(was, now, 2) > (was.length >= 8 ? 2 : 1)) return false;
  const [shorter, longer] = was.length <= now.length ? [was, now] : [now, was];
  if (longer.startsWith(shorter)) {
    const tail = longer.slice(shorter.length);
    return tail.length === 1 && tail === shorter[shorter.length - 1];
  }
  const sameButLast =
    was.length === now.length && was.slice(0, -1) === now.slice(0, -1);
  return !sameButLast;
}

/** Damerau–Levenshtein, capped: anything past `max` is `max + 1`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
      }
    }
  }
  return Math.min(d[a.length]![b.length]!, max + 1);
}

/**
 * Word-level alignment of one draft sentence and the saved sentence it became:
 * the LCS, then the runs between matched words. `matchedBefore` is how many
 * words matched ahead of a run, and `savedAt` where the saved run begins.
 */
function align(draft: Token[], saved: Token[]) {
  const n = draft.length;
  const m = saved.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        draft[i]!.norm === saved[j]!.norm
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const gaps: { removed: Token[]; added: Token[]; matchedBefore: number; savedAt: number }[] = [];
  let i = 0;
  let j = 0;
  let matched = 0;
  let gap = { removed: [] as Token[], added: [] as Token[], matchedBefore: 0, savedAt: 0 };
  const close = () => {
    if (gap.removed.length > 0 || gap.added.length > 0) gaps.push(gap);
    gap = { removed: [], added: [], matchedBefore: matched, savedAt: j };
  };
  while (i < n || j < m) {
    if (i < n && j < m && draft[i]!.norm === saved[j]!.norm) {
      close();
      i += 1;
      j += 1;
      matched += 1;
      gap.matchedBefore = matched;
      gap.savedAt = j;
    } else if (j < m && (i === n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      gap.added.push(saved[j]!);
      j += 1;
    } else {
      gap.removed.push(draft[i]!);
      i += 1;
    }
  }
  close();
  return gaps;
}

/** Shared words over all the words of the two, so a short sentence inside a
 *  long one is not taken for it. */
function overlap(a: string, b: string): number {
  const words = (text: string) =>
    new Set(tokenize(text).filter((t) => !t.mark).map((t) => t.norm).filter(Boolean));
  const left = words(a);
  const right = words(b);
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  const union = left.size + right.size - shared;
  return union === 0 ? 0 : shared / union;
}

const opener = (tokens: Token[]) =>
  tokens
    .map((t) => t.raw)
    .join(" ")
    .replace(/[,;:—–-]+$/, "")
    .trim();

/**
 * How one save changed the draft it kept. Pure: the same pair always measures
 * the same, and nothing here knows which owner wrote it.
 *
 * Openers and slips are read sentence by sentence, against the draft sentence
 * each saved one came from: a question moved to the front is a whole sentence
 * out of place, and read against the whole draft it would swallow the opener
 * and the slips written into it.
 */
export function extractEditSignals(
  draft: string,
  saved: string,
  opts: { storyRemoved?: boolean } = {},
): EditSignals {
  const draftSentences = sentences(draft);
  const savedSentences = sentences(saved);

  // Kept as well as moved: a draft written to open on its question and saved
  // that way still shows the habit, or a habit the writer follows would fade
  // out of the window the moment it was learned.
  const questionFirst =
    savedSentences[0]?.endsWith("?") === true &&
    draftSentences.some((sentence) => sentence.endsWith("?"));

  const intro = draftSentences[0] ?? "";
  const introWords = tokenize(intro).filter((t) => !t.mark).map((t) => t.norm);
  const introducesSelf =
    SELF_SUBJECT.has(introWords[0] ?? "") ||
    (introWords[0] === "as" && (introWords[1] === "a" || introWords[1] === "an"));
  const removedSelfIntro =
    draftSentences.length > 1 &&
    introducesSelf &&
    savedSentences.every((sentence) => overlap(intro, sentence) < SAME_SENTENCE);

  const softeners: string[] = [];
  let apostropheDrops = 0;
  let typos = 0;
  for (const sentence of savedSentences) {
    const source = draftSentences
      .map((candidate) => ({ candidate, score: overlap(candidate, sentence) }))
      .sort((a, b) => b.score - a.score)[0];
    // A sentence the owner wrote from nothing has no draft to be measured
    // against; it is theirs, and the voice samples already learn from it.
    if (!source || source.score < SAME_SENTENCE) continue;
    const savedTokens = tokenize(sentence);
    for (const gap of align(tokenize(source.candidate), savedTokens)) {
      const words = gap.added.filter((t) => !t.mark);
      // A few words put ahead of the sentence, or just after its first word
      // ("I" becoming "I personally"), are the owner's opener. Only an
      // insertion: a word swapped for another is a slip or a rewrite.
      const inserted = gap.removed.length === 0 && words.length > 0;
      if (inserted && words.length <= 3 && gap.savedAt === 0 && gap.matchedBefore === 0) {
        softeners.push(opener(words));
      } else if (inserted && words.length <= 2 && gap.matchedBefore === 1 && gap.savedAt === 1) {
        softeners.push(opener([savedTokens[0]!, ...words]));
      }
      // A word swapped for one a slip away: an apostrophe dropped, or a typo.
      if (gap.removed.length === gap.added.length) {
        gap.removed.forEach((was, index) => {
          const now = gap.added[index]!;
          if (CONTRACTION.test(was.norm) && was.norm.replace(/'/g, "") === now.norm) {
            apostropheDrops += 1;
          } else if (isSlip(was.norm, now.norm)) {
            typos += 1;
          }
        });
      }
    }
  }

  const draftTokens = tokenize(draft);
  const savedTokens = tokenize(saved);
  const draftMarks = draftTokens.filter((t) => t.mark).map((t) => t.raw);
  const marks = savedTokens.filter((t) => t.mark).map((t) => t.raw);
  const emoticons = marks.filter((mark) => {
    const at = draftMarks.indexOf(mark);
    if (at === -1) return true;
    draftMarks.splice(at, 1);
    return false;
  });
  const words = savedTokens.filter((t) => !t.mark).length;
  const draftWords = draftTokens.filter((t) => !t.mark).length;
  // The opener the owner put where the draft's was: their first words, when
  // those are not the draft's.
  const headOf = (text: string) =>
    tokenize(text)
      .filter((t) => !t.mark)
      .slice(0, 2);
  const draftHead = headOf(draft).map((t) => t.norm).join(" ");
  const savedHead = headOf(saved);
  const ownOpener =
    savedHead.length > 0 && savedHead.map((t) => t.norm).join(" ") !== draftHead
      ? opener(savedHead)
      : null;
  return {
    v: 1,
    questionFirst,
    removedSelfIntro,
    softeners: softeners.filter(Boolean),
    emoticons,
    marks: marks.length,
    heads: savedSentences.map((sentence) =>
      sentence.split(/\s+/).slice(0, HEAD_WORDS).join(" ").toLowerCase(),
    ),
    contractions: draftTokens.filter((t) => CONTRACTION.test(t.norm)).length,
    apostropheDrops,
    words,
    typos,
    lengthDelta: draftWords === 0 ? 0 : (words - draftWords) / draftWords,
    storyRemoved: opts.storyRemoved === true,
    droppedClosingQuestion:
      draftSentences.at(-1)?.endsWith("?") === true &&
      savedSentences.at(-1)?.endsWith("?") !== true,
    droppedAdvice: volunteeredAdvice(draft) != null && volunteeredAdvice(saved) == null,
    droppedTagPhrase: tagPhrase(draft) != null && tagPhrase(saved) == null,
    ownOpener: ownOpener || null,
  };
}

function mostUsed(values: string[]): string[] {
  const counts = new Map<string, { value: string; n: number }>();
  for (const value of values) {
    const key = value.toLowerCase();
    const entry = counts.get(key) ?? { value, n: 0 };
    entry.n += 1;
    counts.set(key, entry);
  }
  return [...counts.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, MAX_VALUES)
    .map((entry) => entry.value);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * Whether one measured save shows a kind of edit — what the rollups count,
 * and what a rewrite behind a habit is picked by. `openers` are the openers a
 * voice's saves add, so one a later draft carries and the owner keeps counts
 * as theirs too.
 */
export function showsEdit(
  kind: LearnedEditKind,
  save: EditSignals,
  openers: readonly string[] = [],
): boolean {
  switch (kind) {
    case "question_first":
      return save.questionFirst;
    case "no_self_intro":
      return save.removedSelfIntro;
    case "softeners": {
      const lowered = openers.map((value) => value.toLowerCase());
      return (
        save.softeners.length > 0 ||
        save.heads.some((head) => lowered.some((value) => head.startsWith(value)))
      );
    }
    case "emoticons":
      return save.marks > 0;
    case "dropped_apostrophes":
      return save.apostropheDrops > 0;
    case "typos":
      return save.typos > 0;
    case "shorter":
      return save.lengthDelta <= -LENGTH_HABIT;
    case "longer":
      return save.lengthDelta >= LENGTH_HABIT;
    case "no_owner_story":
      return save.storyRemoved;
    case "no_closing_question":
      return save.droppedClosingQuestion === true;
    case "no_advice":
      return save.droppedAdvice === true;
    case "no_tag_phrase":
      return save.droppedTagPhrase === true;
    case "own_opener":
      return save.ownOpener != null;
  }
}

/**
 * What a voice's measured saves, newest first, say about how it edits. Pure.
 */
export function rollupDirectives(saves: readonly EditSignals[]): LearnedDirective[] {
  const window = saves.slice(0, DIRECTIVE_WINDOW);
  const recent = window.slice(0, DIRECTIVE_RECENT);
  // An opener or a mark the owner added once is still theirs when a later
  // draft carries it and they keep it, so a kept one counts as seen too.
  const openers = mostUsed(window.flatMap((s) => s.softeners));
  const seen = (kind: LearnedDirective["kind"]) =>
    recent.filter((save) => showsEdit(kind, save, openers)).length;
  const out: LearnedDirective[] = [];
  const add = (directive: LearnedDirective) => {
    if (directive.seen >= DIRECTIVE_MIN_SEEN) out.push(directive);
  };

  add({ kind: "question_first", seen: seen("question_first") });
  add({ kind: "no_self_intro", seen: seen("no_self_intro") });
  add({ kind: "softeners", seen: seen("softeners"), values: openers });
  add({
    kind: "emoticons",
    seen: seen("emoticons"),
    values: mostUsed(window.flatMap((s) => s.emoticons)),
  });
  const contractions = window.reduce((sum, s) => sum + s.contractions, 0);
  add({
    kind: "dropped_apostrophes",
    seen: seen("dropped_apostrophes"),
    rate: contractions === 0 ? 0 : round(window.reduce((sum, s) => sum + s.apostropheDrops, 0) / contractions),
  });
  const words = window.reduce((sum, s) => sum + s.words, 0);
  add({
    kind: "typos",
    seen: seen("typos"),
    rate: words === 0 ? 0 : round((100 * window.reduce((sum, s) => sum + s.typos, 0)) / words),
  });
  const shrinks = window.map((s) => s.lengthDelta).filter((d) => d <= -LENGTH_HABIT);
  const grows = window.map((s) => s.lengthDelta).filter((d) => d >= LENGTH_HABIT);
  add({
    kind: "shorter",
    seen: seen("shorter"),
    rate: shrinks.length === 0 ? 0 : round(-median(shrinks)),
  });
  add({
    kind: "longer",
    seen: seen("longer"),
    rate: grows.length === 0 ? 0 : round(median(grows)),
  });
  add({ kind: "no_owner_story", seen: seen("no_owner_story") });
  // A voice that both shortens and lengthens has no length habit to follow.
  const length = out.filter((d) => d.kind === "shorter" || d.kind === "longer");
  return length.length === 2 ? out.filter((d) => !length.includes(d)) : out;
}

/**
 * Which of the drafts' moves a voice's measured saves, newest first, keep
 * cutting or replacing: the closing question, volunteered advice, a tag set off
 * at the end of a sentence, the opener. Pure, and held to the same window and
 * floor as the directives, so a habit the owner drops ages out.
 */
export function rollupMoves(saves: readonly EditSignals[]): LearnedMove[] {
  const window = saves.slice(0, DIRECTIVE_WINDOW);
  const recent = window.slice(0, DIRECTIVE_RECENT);
  const out: LearnedMove[] = [];
  const add = (kind: LearnedMove["kind"], values?: string[]) => {
    const seen = recent.filter((save) => showsEdit(kind, save)).length;
    if (seen < DIRECTIVE_MIN_SEEN) return;
    out.push({ kind, seen, rate: round(seen / recent.length), ...(values ? { values } : {}) });
  };
  add("no_closing_question");
  add("no_advice");
  add("no_tag_phrase");
  add("own_opener", mostUsed(window.flatMap((s) => (s.ownOpener ? [s.ownOpener] : []))));
  return out;
}

/**
 * Re-read a voice's measured saves and store what they say on the voice,
 * channel by channel: each of comments, replies and DMs is rolled up from the
 * rewrites of its own drafts alone, under the same window and floor, so a
 * habit of one never reaches another's drafts. A sample captured with no voice
 * belongs to the default one, as everywhere a corpus is read.
 */
export async function refreshLearnedDirectives(
  tx: Tx,
  voice: Pick<Voice, "id" | "isDefault">,
  now: number = Date.now(),
): Promise<LearnedDirectives> {
  // Held so two saves landing together each read the other's sample, rather
  // than the last write keeping a rollup that missed one.
  const [held] = await tx
    .select({ learned: voices.learnedDirectives })
    .from(voices)
    .where(eq(voices.id, voice.id))
    .for("update");
  const before = held?.learned ?? null;
  const rollup = async (channel: WritingChannel): Promise<LearnedChannelEdits> => {
    const rows = await tx
      .select({ signals: voiceSamples.editSignals })
      .from(voiceSamples)
      .where(
        and(
          isNotNull(voiceSamples.editSignals),
          isNull(voiceSamples.disownedAt),
          sampleBelongsToVoice(voice),
          writtenIn(channel),
        ),
      )
      .orderBy(desc(voiceSamples.capturedAt), desc(voiceSamples.id))
      .limit(DIRECTIVE_WINDOW);
    const saves = rows.flatMap((row) => (row.signals ? [row.signals] : []));
    const prior = learnedEditsIn(before, channel);
    return {
      directives: rollupDirectives(saves).map((edit) => sinceApplied(edit, prior, now)),
      moves: rollupMoves(saves).map((edit) => sinceApplied(edit, prior, now)),
      saves: saves.length,
      updatedAt: now,
    };
  };
  const learned: LearnedDirectives = {
    ...(await rollup("comment")),
    byChannel: { reply: await rollup("reply"), dm: await rollup("dm") },
  };
  await tx.update(voices).set({ learnedDirectives: learned }).where(eq(voices.id, voice.id));
  return learned;
}

/**
 * A habit as it applies now, with when it started to: carried over while it
 * keeps applying, `now` when this rollup is the first it passes the floor in
 * — again after it faded out. A habit that applied before the date was kept
 * has none, rather than one this rollup made up.
 */
function sinceApplied<E extends LearnedEdit>(
  edit: E,
  before: LearnedChannelEdits | null,
  now: number,
): E {
  if (!before) return { ...edit, firstAppliedAt: now };
  const was = [...before.directives, ...(before.moves ?? [])].find((prior) => prior.kind === edit.kind);
  if (!was) return { ...edit, firstAppliedAt: now };
  return was.firstAppliedAt == null ? edit : { ...edit, firstAppliedAt: was.firstAppliedAt };
}

/**
 * After a measured save: refresh the voice it was captured for — the one named,
 * or the org default when none was (a write may create it).
 */
export async function learnFromSave(tx: Tx, voiceId: number | null): Promise<void> {
  const [named] =
    voiceId == null ? [] : await tx.select().from(voices).where(eq(voices.id, voiceId));
  await refreshLearnedDirectives(tx, named ?? (await ensureDefaultVoice(tx)));
}
