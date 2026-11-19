import { and, eq } from "drizzle-orm";
import {
  voiceQuestions,
  voices,
  type StyleRules,
  type Voice,
  type VoiceQuestionAnswer,
  type VoiceQuestionKey,
  type VoiceTraits,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import {
  addVoiceExample,
  exampleKey,
  getVoice,
  removeVoiceExample,
  updateVoice,
  VOICE_EXAMPLE_CAP,
} from "../operations/voices";
import { exampleTexts } from "./examples";
import { VOICE_EXAMPLE_MAX_CHARS } from "../ai/styleRules";
import { voiceTraitView, type LearnedTraitKey } from "./traitView";

/**
 * HOW THE OWNER WANTS TO SOUND, AS EIGHT QUESTIONS.
 *
 * Each answer IS a value the owner sets — the same value How you write shows
 * and every writer reads — so an answer beats what Engager learns, trait by
 * trait, until it is handed back. The value lives where it always did, in the
 * voice's `styleRules` (or, for the comment they are proud of, its examples);
 * `voice_questions` records only who answered, where and when. A list reads
 * every answer back off the value, so the page, the agent and How you write
 * cannot disagree: a value changed under How you write reads as set there, and
 * one handed back reads as not answered.
 *
 * The page's action and the agent's tool both answer through
 * `answerVoiceQuestion`. Nothing here makes a sample, calls a model or moves a
 * habit learned from edits.
 */

export type VoiceQuestionKind = "choice" | "text" | "long";

export type VoiceQuestion = {
  key: VoiceQuestionKey;
  prompt: string;
  kind: VoiceQuestionKind;
  /** A choice question's answers, by key; none for a text one. */
  choices: readonly { key: string; label: string }[];
  /** What an answer sets, in the words How you write names it by. */
  sets: readonly string[];
};

/** One answer of a choice question, and the value it sets. */
type Choice<V> = { key: string; label: string; value: V };

/** Where an answer's value lives: how to read it off the voice (null when
 *  the owner set none), and the patch that sets it — or, given null, hands it
 *  back. */
type Target = {
  read: (rules: StyleRules | null) => unknown;
  write: (value: unknown) => Partial<StyleRules>;
};

type Strategy =
  | (Omit<VoiceQuestion, "choices"> & {
      kind: "choice";
      choices: readonly Choice<unknown>[];
      target: Target;
    })
  | (Omit<VoiceQuestion, "choices"> & {
      kind: "text";
      /** The most characters a text answer holds — or, for a list answer,
       *  at most `max` words or phrases of `each` characters. */
      limit: number | { max: number; each: number };
      target: Target;
    })
  | (Omit<VoiceQuestion, "choices"> & { kind: "long"; limit: number });

/** A null in a traits patch hands that trait back to the writing
 *  (`mergeTraits`); the type only knows set values. */
const traitsPatch = (patch: Record<string, unknown>): Partial<StyleRules> => ({
  traits: patch as VoiceTraits,
});

const trait = (key: keyof VoiceTraits): Target => ({
  read: (rules) => rules?.traits?.[key] ?? null,
  write: (value) => traitsPatch({ [key]: value }),
});

const STRATEGIES: readonly Strategy[] = [
  {
    key: "who",
    prompt: "Who do you write to?",
    kind: "text",
    limit: 200,
    sets: ["Who you write to"],
    target: {
      read: (rules) => rules?.writesTo?.trim() || null,
      write: (value) => ({ writesTo: value as string | null }),
    },
  },
  {
    key: "register",
    prompt: "How formal do you want to sound?",
    kind: "choice",
    choices: [
      { key: "casual", label: "Casual", value: "casual" },
      { key: "neutral", label: "In between", value: "neutral" },
      { key: "formal", label: "Formal", value: "formal" },
    ],
    sets: ["How formal you sound"],
    target: trait("register"),
  },
  {
    key: "length",
    prompt: "How long should a comment usually be?",
    kind: "choice",
    choices: [
      { key: "short", label: "Under 20 words", value: { min: 5, max: 20 } },
      { key: "mid", label: "15–35 words", value: { min: 15, max: 35 } },
      { key: "long", label: "30–60 words", value: { min: 30, max: 60 } },
    ],
    sets: ["How long you write"],
    target: trait("lengthWords"),
  },
  {
    key: "questions",
    prompt: "Do you ask questions back?",
    kind: "choice",
    choices: [
      { key: "never", label: "Never", value: 0 },
      { key: "some", label: "Sometimes", value: 0.33 },
      { key: "often", label: "Often", value: 0.75 },
    ],
    sets: ["How often you ask a question"],
    target: trait("questionRate"),
  },
  {
    key: "like",
    prompt: "Words or phrases you like to start with",
    kind: "text",
    limit: { max: 8, each: 40 },
    sets: ["How you open"],
    target: {
      read: (rules) => (rules?.traits?.openers?.length ? rules.traits.openers : null),
      write: (value) => traitsPatch({ openers: value }),
    },
  },
  {
    key: "never",
    prompt: "Words you never use",
    kind: "text",
    limit: { max: 30, each: 40 },
    sets: ["Words you never use"],
    target: {
      read: (rules) => (rules?.avoidWords?.length ? rules.avoidWords : null),
      write: (value) => ({ avoidWords: value as string[] | null }),
    },
  },
  {
    key: "emoji",
    prompt: "Emojis and exclamation marks?",
    kind: "choice",
    choices: [
      { key: "neither", label: "Neither", value: { emojiMax: 0, exclamationRate: 0.02 } },
      { key: "excl", label: "Exclamation marks only", value: { emojiMax: 0, exclamationRate: 0.25 } },
      { key: "emoji", label: "An emoji now and then", value: { emojiMax: 1, exclamationRate: 0.02 } },
      { key: "both", label: "Both, freely", value: { emojiMax: 2, exclamationRate: 0.6 } },
    ],
    sets: ["Emoji", "Exclamation marks"],
    target: {
      read: (rules) =>
        rules?.emojiMax == null && rules?.traits?.exclamationRate == null
          ? null
          : { emojiMax: rules?.emojiMax ?? null, exclamationRate: rules?.traits?.exclamationRate ?? null },
      write: (value) => {
        const set = value as { emojiMax: number; exclamationRate: number } | null;
        return {
          emojiMax: set?.emojiMax ?? null,
          ...traitsPatch({ exclamationRate: set?.exclamationRate ?? null }),
        };
      },
    },
  },
  {
    key: "proud",
    prompt: "One comment you wrote that you are proud of",
    kind: "long",
    limit: VOICE_EXAMPLE_MAX_CHARS,
    sets: ["An example"],
  },
];

/** The eight questions, in the order the Voice page asks them. */
export const VOICE_QUESTIONS: readonly VoiceQuestion[] = STRATEGIES.map((def) => ({
  key: def.key,
  prompt: def.prompt,
  kind: def.kind,
  choices: def.kind === "choice" ? def.choices.map(({ key, label }) => ({ key, label })) : [],
  sets: def.sets,
}));

/** A choice question's answer when its value was set apart from every
 *  choice — under How you write, or one half of it alone. */
export const SET_ELSEWHERE = "set_elsewhere";

export type VoiceQuestionStatus = "pending" | "answered" | "skipped";

/** Where an answer came from: the Voice page, the owner's agent, or a value
 *  set under How you write that the question reads back. */
export type VoiceAnsweredVia = "dashboard" | "agent" | "how_you_write";

export type VoiceQuestionRow = VoiceQuestion & {
  status: VoiceQuestionStatus;
  /** A choice's key (or `set_elsewhere`), a text, or a list of words. */
  answer: VoiceQuestionAnswer | null;
  answeredVia: VoiceAnsweredVia | null;
  answeredAt: number | null;
};

export type VoiceQuestionList = {
  /** Null: the org's default voice, which no row holds yet. */
  voiceId: number | null;
  ownWords: string | null;
  questions: VoiceQuestionRow[];
};

type StoredRow = typeof voiceQuestions.$inferSelect;
type AnsweredVoice = Pick<Voice, "id" | "styleRules">;

/** Two values as equal as a voice holds them: a jsonb object comes back with
 *  its keys in its own order. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
  );
}

/** What a question's answer is on the voice now, read off its value. */
function currentAnswer(
  def: Strategy,
  voice: AnsweredVoice | null,
  row: StoredRow | undefined,
): VoiceQuestionAnswer | null {
  const rules = voice?.styleRules ?? null;
  if (def.kind === "long") {
    // The comment they are proud of is answered while it is still one of the
    // voice's examples; removed from them, the question is open again.
    const text = row?.status === "answered" && typeof row.answer === "string" ? row.answer : null;
    const kept = exampleTexts(rules, "comment");
    return text && kept.some((example) => exampleKey(example) === exampleKey(text)) ? text : null;
  }
  const value = def.target.read(rules);
  if (value == null) return null;
  if (def.kind === "text") return value as VoiceQuestionAnswer;
  return def.choices.find((choice) => same(choice.value, value))?.key ?? SET_ELSEWHERE;
}

function questionRow(
  def: Strategy,
  voice: AnsweredVoice | null,
  row: StoredRow | undefined,
): VoiceQuestionRow {
  const question = VOICE_QUESTIONS.find((q) => q.key === def.key)!;
  const answer = currentAnswer(def, voice, row);
  if (answer == null) {
    const skipped = row?.status === "skipped";
    return {
      ...question,
      status: skipped ? "skipped" : "pending",
      answer: null,
      answeredVia: skipped ? (row.answeredVia ?? null) : null,
      answeredAt: skipped ? (row.answeredAt ?? null) : null,
    };
  }
  // The answer the row recorded is the one the voice holds: it was answered
  // there. Any other value was set somewhere else.
  const recorded = row?.status === "answered" && same(row.answer, answer);
  return {
    ...question,
    status: "answered",
    answer,
    answeredVia: recorded ? (row.answeredVia ?? null) : "how_you_write",
    answeredAt: recorded ? (row.answeredAt ?? null) : null,
  };
}

/** The voice asked for, else the org's default — read, never created; null
 *  for an org with no default yet. */
async function voiceFor(tx: Tx, voiceId: number | null | undefined): Promise<AnsweredVoice | null> {
  const [voice] = await tx
    .select({ id: voices.id, styleRules: voices.styleRules })
    .from(voices)
    .where(voiceId != null ? eq(voices.id, voiceId) : eq(voices.isDefault, true));
  if (!voice && voiceId != null) throw new Error(`voice ${voiceId} not found`);
  return voice ?? null;
}

/**
 * The eight questions for one voice, each with its answer as the voice holds
 * it now. No `voiceId` reads the org's default voice — and an org that has
 * none yet reads every question open, since a read creates nothing.
 */
export async function listVoiceQuestions(
  tx: Tx,
  input: { voiceId?: number | null },
): Promise<VoiceQuestionList> {
  const voice = await voiceFor(tx, input.voiceId);
  const rows = voice
    ? await tx.select().from(voiceQuestions).where(eq(voiceQuestions.voiceId, voice.id))
    : [];
  return {
    voiceId: voice?.id ?? null,
    ownWords: voice?.styleRules?.ownWords?.trim() || null,
    questions: STRATEGIES.map((def) =>
      questionRow(def, voice, rows.find((row) => row.key === def.key)),
    ),
  };
}

export type VoiceQuestionRefusal =
  | "voice_question_not_found"
  | "voice_not_found"
  | "invalid_choice"
  | "invalid_answer"
  | "too_long"
  | "already_kept"
  | "examples_full";

export type VoiceAnswerOutcome =
  | {
      ok: true;
      key: VoiceQuestionKey;
      status: VoiceQuestionStatus;
      sets: readonly string[];
      answer: VoiceQuestionAnswer | null;
      /** The answer in the words the question offered it in. */
      value: string | string[] | null;
    }
  | { ok: false; code: VoiceQuestionRefusal; detail: string };

export type VoiceAnswerInput = {
  voiceId: number;
  key: string;
  via: "dashboard" | "agent";
} & ({ answer: VoiceQuestionAnswer | null; skip?: never } | { skip: true; answer?: never });

type Refusal = Extract<VoiceAnswerOutcome, { ok: false }>;

const refuse = (code: VoiceQuestionRefusal, detail: string): Refusal => ({
  ok: false,
  code,
  detail,
});

/** A list answer's words, from a comma- or line-separated text or a list:
 *  trimmed, and the same words in any case once. */
function wordsOf(answer: VoiceQuestionAnswer): string[] {
  const seen = new Set<string>();
  return (typeof answer === "string" ? answer.split(/[,\n]/) : answer)
    .map((word) => word.trim())
    .filter((word) => {
      const key = word.toLocaleLowerCase();
      if (!word || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** The answer in the shape its value takes, or why it cannot be one. */
function normalize(
  def: Strategy,
  answer: VoiceQuestionAnswer,
): { value: unknown; stored: VoiceQuestionAnswer; label: string | string[] } | Refusal {
  if (def.kind === "choice") {
    const choice = def.choices.find((c) => c.key === answer);
    if (!choice) {
      return refuse(
        "invalid_choice",
        `"${String(answer)}" is not an answer to this question: one of ${def.choices.map((c) => c.key).join(", ")}`,
      );
    }
    return { value: choice.value, stored: choice.key, label: choice.label };
  }
  const { limit } = def;
  if (typeof limit !== "number") {
    const words = wordsOf(answer);
    if (words.length === 0) return refuse("invalid_answer", "the answer has no words");
    if (words.length > limit.max || words.some((word) => word.length > limit.each)) {
      return refuse("too_long", `at most ${limit.max} words or phrases, each up to ${limit.each} characters`);
    }
    return { value: words, stored: words, label: words };
  }
  if (typeof answer !== "string" || !answer.trim()) {
    return refuse("invalid_answer", "the answer is one text, and it is empty");
  }
  const text = answer.trim();
  if (text.length > limit) return refuse("too_long", `at most ${limit} characters`);
  return { value: text, stored: text, label: text };
}

/** An answer in the words the question offers it in: a choice's label, the
 *  text, or the words, one after another. */
export function voiceAnswerWords(key: VoiceQuestionKey, answer: VoiceQuestionAnswer): string {
  if (Array.isArray(answer)) return answer.join(", ");
  const def = STRATEGIES.find((d) => d.key === key)!;
  if (def.kind !== "choice") return answer;
  if (answer === SET_ELSEWHERE) return "set under How you write";
  return def.choices.find((choice) => choice.key === answer)?.label ?? answer;
}

/**
 * An answer as the question would take it — in the words it would be saved
 * in — or the refusal saving it would meet, with nothing written: what a
 * chat proposal checks before it draws a card.
 */
export function checkVoiceAnswer(
  key: VoiceQuestionKey,
  answer: VoiceQuestionAnswer,
): { ok: true; words: string } | Refusal {
  const given = normalize(STRATEGIES.find((d) => d.key === key)!, answer);
  if ("ok" in given) return given;
  return { ok: true, words: voiceAnswerWords(key, given.stored) };
}

/** A value an answer sets, by the How you write row that reads it — or the
 *  words the owner never uses, which no row holds. */
export type AnswerSetKey = LearnedTraitKey | "emojiMax" | "avoidWords";

/**
 * The values one answer would set, each by the row that reads it, with
 * nothing written: what the New voice form says an answer does before
 * Create. Empty for an answer the question would refuse, and for one that
 * sets no such value — who they write to, a comment they are proud of.
 */
export function answerSets(
  key: VoiceQuestionKey,
  answer: VoiceQuestionAnswer,
): Partial<Record<AnswerSetKey, unknown>> {
  const def = STRATEGIES.find((d) => d.key === key);
  if (!def || def.kind === "long" || key === "who") return {};
  const given = normalize(def, answer);
  if ("ok" in given) return {};
  const patch = def.target.write(given.value);
  return {
    ...(patch.emojiMax != null ? { emojiMax: patch.emojiMax } : {}),
    ...(patch.traits ?? {}),
    ...(patch.avoidWords != null ? { avoidWords: patch.avoidWords } : {}),
  };
}

/** Upsert the provenance row of one question. */
async function record(
  tx: Tx,
  voiceId: number,
  key: VoiceQuestionKey,
  row: Pick<StoredRow, "status" | "answer" | "answeredVia" | "answeredAt">,
): Promise<void> {
  await tx
    .insert(voiceQuestions)
    .values({ voiceId, key, ...row })
    .onConflictDoUpdate({
      target: [voiceQuestions.organizationId, voiceQuestions.voiceId, voiceQuestions.key],
      set: row,
    });
}

/** Take one comment example off a voice by its words. */
async function dropExample(tx: Tx, voice: AnsweredVoice, text: string): Promise<void> {
  await removeVoiceExample(tx, voice.id, text, "comment");
}

/**
 * Answer, clear or skip one question of a voice, in the caller's transaction.
 *
 * An answer writes its value — through `updateVoice` for a trait, who they
 * write to and the words they never use, through `addVoiceExample` for the
 * comment they are proud of, which replaces the one an earlier answer kept —
 * then records the question answered, with where and when. A null answer
 * hands the value back (the proud comment comes off the examples) and opens
 * the question again. A skip writes no value and records the skip; a question
 * whose value is already set has nothing to skip and stays answered.
 *
 * A refusal writes nothing.
 */
export async function answerVoiceQuestion(
  tx: Tx,
  input: VoiceAnswerInput,
): Promise<VoiceAnswerOutcome> {
  const def = STRATEGIES.find((d) => d.key === input.key);
  if (!def) {
    return refuse(
      "voice_question_not_found",
      `no voice question "${input.key}": one of ${STRATEGIES.map((d) => d.key).join(", ")}`,
    );
  }
  const voice = await getVoice(tx, input.voiceId);
  if (!voice) return refuse("voice_not_found", `voice ${input.voiceId} not found`);
  const [row] = await tx
    .select()
    .from(voiceQuestions)
    .where(and(eq(voiceQuestions.voiceId, voice.id), eq(voiceQuestions.key, def.key)));
  const done = (status: VoiceQuestionStatus, answer: VoiceQuestionAnswer | null, value: string | string[] | null) =>
    ({ ok: true, key: def.key, status, sets: def.sets, answer, value }) as const;
  const now = Date.now();

  if (input.skip) {
    const current = currentAnswer(def, voice, row);
    if (current != null) return done("answered", current, null);
    await record(tx, voice.id, def.key, {
      status: "skipped",
      answer: null,
      answeredVia: input.via,
      answeredAt: now,
    });
    return done("skipped", null, null);
  }

  if (input.answer == null) {
    if (def.kind === "long") {
      const kept = currentAnswer(def, voice, row);
      if (typeof kept === "string") await dropExample(tx, voice, kept);
    } else {
      await updateVoice(tx, voice.id, { styleRules: def.target.write(null) });
    }
    await record(tx, voice.id, def.key, {
      status: "pending",
      answer: null,
      answeredVia: null,
      answeredAt: null,
    });
    return done("pending", null, null);
  }

  const given = normalize(def, input.answer);
  if ("ok" in given) return given;

  if (def.kind === "long") {
    const text = given.stored as string;
    const previous = currentAnswer(def, voice, row);
    if (typeof previous !== "string" || exampleKey(previous) !== exampleKey(text)) {
      // Checked before anything moves, so a refusal writes nothing.
      const others = exampleTexts(voice.styleRules, "comment").filter(
        (example) => typeof previous !== "string" || exampleKey(example) !== exampleKey(previous),
      );
      if (others.some((example) => exampleKey(example) === exampleKey(text))) {
        return refuse("already_kept", "that comment is already one of the voice's examples");
      }
      if (others.length >= VOICE_EXAMPLE_CAP) {
        return refuse("examples_full", `${VOICE_EXAMPLE_CAP} is the most a voice keeps: remove one first`);
      }
      if (typeof previous === "string") await dropExample(tx, voice, previous);
      await addVoiceExample(tx, voice.id, text, { refuseOverCap: true, from: "answer" });
    }
  } else {
    await updateVoice(tx, voice.id, { styleRules: def.target.write(given.value) });
  }
  await record(tx, voice.id, def.key, {
    status: "answered",
    answer: given.stored,
    answeredVia: input.via,
    answeredAt: now,
  });
  return done("answered", given.stored, given.label);
}

/** The How you write row each trait-backed question sets — the one whose
 *  strength says how much the owner's writing already shows of it. */
const TRAIT_ROW: Partial<Record<VoiceQuestionKey, LearnedTraitKey>> = {
  register: "register",
  length: "lengthWords",
  questions: "questionRate",
  like: "openers",
  emoji: "exclamationRate",
};

/**
 * Open again the questions the owner skipped, and list every open one
 * weakest first: a trait their comments show nothing of, then one whose
 * learned value only guides a draft, then what only the owner can say — who
 * they write to, the words they never use, a comment they are proud of — then
 * the traits their writing already holds. No model is asked, and the one
 * write is skipped → pending.
 */
export async function reopenVoiceQuestions(
  tx: Tx,
  input: { voiceId?: number | null },
): Promise<VoiceQuestionList> {
  const voice = await voiceFor(tx, input.voiceId);
  if (voice) {
    await tx
      .update(voiceQuestions)
      .set({ status: "pending", answeredVia: null, answeredAt: null })
      .where(and(eq(voiceQuestions.voiceId, voice.id), eq(voiceQuestions.status, "skipped")));
  }
  const listed = await listVoiceQuestions(tx, input);
  const view = await voiceTraitView(tx, { voiceId: listed.voiceId, channel: "comment" });
  const weakness = (question: VoiceQuestionRow): number => {
    const key = TRAIT_ROW[question.key];
    if (!key) return 2;
    const row = view.rows.find((r) => r.key === key);
    if (!row || row.source === "none") return 0;
    return row.strength === "guides" ? 1 : 3;
  };
  return {
    ...listed,
    questions: listed.questions
      .filter((question) => question.status === "pending")
      .sort((a, b) => weakness(a) - weakness(b)),
  };
}

