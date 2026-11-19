import {
  asksQuestion,
  eitherOrQuestion,
  tagPhrase,
  usesColon,
  usesSignature,
  volunteeredAdvice,
} from "../ai/voiceTraits";
import { endsWithQuestion, type Rationing } from "../learning/styleVariety";
import { PLAN_HABITS, type Budget, type CompiledRules, type PlanHabit } from "./types";

/** How a draft carries each rated habit, by the detectors the owner's rates
 *  are measured with (`measureVoiceTraits`), and the drafts a rate is a share
 *  of where that is not every draft: those that ask, for how they ask. */
export const HABIT_READS: Record<PlanHabit, { carries: (text: string) => boolean; among?: (text: string) => boolean }> = {
  eitherOrRate: { carries: (text) => eitherOrQuestion(text) != null, among: (text) => asksQuestion(text) },
  adviceRate: { carries: (text) => volunteeredAdvice(text) != null },
  tagPhraseRate: { carries: (text) => tagPhrase(text) != null },
  colonRate: { carries: usesColon },
  exclamationRate: { carries: (text) => text.includes("!") },
};

/**
 * How many plans of one batch of `size` may carry each rated mark, habit and
 * the question: the owner's rate of the recent drafts plus this batch,
 * rounded, less what the recent drafts already carry. It is dealt at the rate
 * itself, never at the binomial reach the judge tolerates a run of drafts to
 * (`reachOf`): with that slack a batch of one always had room, and an opener
 * planned one at a time asked nearly every time at a rate of a half. Anything
 * forbidden or at a rate of nothing gets none, a question the campaign
 * requires gets every plan, and with rationing off nothing rated is held
 * below the batch. A ceiling the planner stays within, never a quota.
 */
export function budgetFor(
  rules: CompiledRules,
  recentDrafts: readonly string[],
  size: number,
  rationing: Rationing,
): Budget {
  /** The most of `most` plans that may carry it, after the `pool` of recent
   *  drafts its rate is a share of. */
  const ceiling = (rate: number, pool: readonly string[], carries: (text: string) => boolean, most: number) => {
    if (rate === 0 || most === 0) return 0;
    if (rationing === "off") return most;
    const used = pool.filter(carries).length;
    return Math.max(0, Math.min(most, Math.round(rate * (pool.length + most)) - used));
  };

  const question =
    rules.question.must === "never" ? 0
      : rules.question.must === "ask" ? size
        : ceiling(rules.question.rate, recentDrafts, endsWithQuestion, size);
  const marks = Object.fromEntries(
    Object.entries(rules.marks).map(([mark, rated]) => [
      mark,
      rated.allowed ? ceiling(rated.rate, recentDrafts, (text) => usesSignature(text, mark), size) : 0,
    ]),
  );
  const habits: Budget["habits"] = {};
  for (const habit of PLAN_HABITS) {
    const rated = rules.habits[habit];
    if (!rated) continue;
    const read = HABIT_READS[habit];
    // How a voice asks is a share of its questions, so a batch can carry it
    // no more often than its plans may ask.
    habits[habit] = rated.allowed
      ? ceiling(
          rated.rate,
          read.among ? recentDrafts.filter(read.among) : recentDrafts,
          read.carries,
          read.among ? question : size,
        )
      : 0;
  }
  return { size, marks, habits, question };
}
