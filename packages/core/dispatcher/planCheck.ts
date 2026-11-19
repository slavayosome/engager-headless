import { z } from "zod";
import { DEFAULT_STYLE_TAXONOMY } from "../ai/promptDefaults";
import { usesSignature } from "../ai/voiceTraits";
import type { EngagementPlay } from "../ai/writer";
import { canAnswerRoom, type RoomDraftingContext } from "../operations/researchReads";
import { normalize } from "../workers/evidenceReview";
import { HABIT_READS } from "./budgets";
import {
  conversationId,
  PLAN_HABITS,
  PLAN_MOVES,
  type Budget,
  type CompiledRules,
  type DraftConversation,
  type OpenerPlan,
  type OwnerAsk,
  type PlanHabit,
  type PlanMove,
} from "./types";

/**
 * The planner's CODE CHECK: what a model's plan for one batch must hold
 * before anything is written from it, and the safe value code sets where a
 * plan still breaks it after one re-ask. Code judges here only what it can
 * decide exactly: a quote is in its source word for word, an id names
 * something given, a range sits inside the compiled one, a choice does not
 * contradict another, and the batch stays within its budget. Whether a story
 * fits a post, or a mark suits it, is the model's call, and nothing here
 * second-guesses it.
 */

/** What a verify read of the post found, where one did. */
export type PlanningResearch = {
  play: EngagementPlay;
  playGuidance: string;
  alreadySaid: string[];
  authorReplyRate: number | null;
  /** Who in the room voiced what, where a current read holds it
   *  (`readRoomForDrafting`). */
  room: RoomDraftingContext | null;
};

/** One post a batch plans a draft for, with what code knows about it. */
export type PlanningItem = {
  conversation: DraftConversation;
  ownerFacts?: string[];
  research: PlanningResearch | null;
  /** Who the author is, as their profile read says, else the post. */
  authorHeadline: string | null;
  /** Nothing has passed between the account and the author yet. */
  firstTouch: boolean;
  /** Set on an opener to a lead: what their intent lets it do, and the way in
   *  it writes out. */
  opener?: OpenerPlan;
  /** Set on a message its step writes: the step's instructions, which say
   *  what it does. */
  step?: string;
  /** The most characters the draft may take, where its surface has a hard
   *  limit: a connection invitation's note (`noteLimitFor`). */
  maxChars?: number;
  /** Set where the owner asked for this comment in words of their own. */
  ask?: OwnerAsk;
  /** Set where an earlier plan's draft for it was withheld for a miss no
   *  rewrite of that plan can fix: what it said, and why. */
  withheld?: { text: string; reason: string };
};

/** One of the owner's stories, with the texts the account already sent
 *  telling it, newest first. */
export type PlanningStory = { id: number; title: string | null; content: string; told: string[] };

export type PlanningInput = {
  rules: CompiledRules;
  rulesRevision: string;
  /** This batch's ceilings (`budgetFor`), sized to its items. */
  budget: Budget;
  items: readonly PlanningItem[];
  stories: readonly PlanningStory[];
  /** The owner's example texts for this channel, as a draft is shown them. */
  examples: readonly string[];
  /** How many of them one plan may show the writer: the voice's
   *  `exemplarCount`. */
  examplesMax: number;
};

/** What a word costs in characters, with the space after it: an English word
 *  runs nearer five, and a plan keeps to the longer, so the range it plans
 *  fits a character limit more often than not. The judge counts the
 *  characters themselves. */
const CHARS_PER_WORD = 6;

/** The most words a draft with a character limit is planned to run to. */
export const wordsWithin = (maxChars: number) => Math.max(1, Math.floor(maxChars / CHARS_PER_WORD));

/** The plan schema's own bound on a reason. */
const WHY_MAX = 240;
/** What code decides for a move that needs what the post or plan lacks. */
const FALLBACK_MOVE = "agree_plus";
const STORY_SHAPE = "mini_story";
/** The opening that asks, and the one shape it takes: a comment that opens on
 *  its question ends on it too, so the question is the whole comment. */
export const QUESTION_OPENING = "question_open";
const QUESTION_SHAPE = "one_liner";
export const STYLE_AXES = ["opening", "shape", "stance"] as const;
type Axis = (typeof STYLE_AXES)[number];

/** A reason as a plan keeps it: trimmed, and cut with a mark where the model
 *  ran past the bound, rather than failing the batch over a long sentence.
 *  One left empty is filled when the plan is made. */
const why = z.string().transform((value) => {
  const trimmed = value.trim();
  return trimmed.length <= WHY_MAX ? trimmed : `${trimmed.slice(0, WHY_MAX - 1).replace(/[\uD800-\uDBFF]$/, "")}…`;
});
const Choice = z.enum(["use", "omit"]);
type Choice = z.infer<typeof Choice>;

/** What the planner's model decides for one post. Bounds are loose where code
 *  checks them, so one stray value is a fault to re-ask about rather than a
 *  batch that fails to parse. */
export const PlanChoicesSchema = z.object({
  /** The id the plan was asked for (`conversationId`): a post's, or an
   *  opener's lead. */
  discoveredPostId: z.number().int(),
  point: z.object({
    buildOn: z.string().trim(),
    quotes: z.array(z.object({ source: z.enum(["post", "story", "owner_facts"]), text: z.string() })),
    why,
  }),
  move: z.object({ value: z.enum(PLAN_MOVES), why }),
  name: z.string().trim(),
  story: z.object({ id: z.number().int().nullable(), why }),
  question: z.object({ ask: z.boolean(), why }),
  length: z.object({ minWords: z.number().int(), maxWords: z.number().int() }),
  style: z.object({ opening: z.string(), shape: z.string(), stance: z.string() }),
  marks: z.array(z.object({ mark: z.string(), choice: Choice })),
  habits: z.array(z.object({ habit: z.enum(PLAN_HABITS), choice: Choice })),
  examples: z.array(z.number().int()),
});
export type PlanChoices = z.infer<typeof PlanChoicesSchema>;

type Rated = CompiledRules["marks"][string];
type Lookup = {
  input: PlanningInput;
  items: Map<number, PlanningItem>;
  stories: Map<number, PlanningStory>;
};

const lookupOf = (input: PlanningInput): Lookup => ({
  input,
  items: new Map(input.items.map((item) => [conversationId(item.conversation), item])),
  stories: new Map(input.stories.map((story) => [story.id, story])),
});

/** What a plan says of each mark or habit: the first word it gives on each. */
function decided<K extends string>(pairs: readonly (readonly [K, Choice])[]): Map<K, Choice> {
  const out = new Map<K, Choice>();
  for (const [key, choice] of pairs) if (!out.has(key)) out.set(key, choice);
  return out;
}
const marksOf = (plan: PlanChoices) => decided(plan.marks.map(({ mark, choice }) => [mark, choice] as const));
const habitsOf = (plan: PlanChoices) => decided(plan.habits.map(({ habit, choice }) => [habit, choice] as const));

/** A batch's size in words: "1 comment", "5 comments". */
export const commentsIn = (size: number) => `${size} ${size === 1 ? "comment" : "comments"}`;

/** Rated at all, and not forbidden: what a budget may deal. */
const usable = (rated: Rated | undefined) => rated != null && rated.allowed && rated.rate > 0;

const storyOf = (plan: PlanChoices, lookup: Lookup) =>
  plan.story.id == null ? null : (lookup.stories.get(plan.story.id) ?? null);

/** The styles a plan picks from on one axis, weighted: the compile's, else
 *  the taxonomy's evenly, as the compile itself falls back. */
export function stylesOf(rules: CompiledRules, axis: Axis): CompiledRules["structure"][Axis] {
  const compiled = rules.structure[axis];
  return compiled.length > 0 ? compiled : DEFAULT_STYLE_TAXONOMY[axis].map((style) => ({ id: style.id, weight: 1 }));
}

/** Where a quote is not its source's own words, or null where it is. A post
 *  quote may come from the post or the text on its media; a story quote only
 *  from the story the plan tells. */
function quoteFault(quote: PlanChoices["point"]["quotes"][number], item: PlanningItem, story: PlanningStory | null): string | null {
  const words = normalize(quote.text);
  if (!words) return "a quote is empty";
  if (quote.source === "story") {
    if (!story) return `the quote "${quote.text}" cites a story, and the plan tells none`;
    return normalize(story.content).includes(words) ? null : `the quote "${quote.text}" is not word for word in story ${story.id}`;
  }
  if (quote.source === "owner_facts") {
    return (item.ownerFacts ?? []).some((fact) => normalize(fact).includes(words))
      ? null : `the quote "${quote.text}" is not word for word in the owner's facts`;
  }
  const { text, mediaText } = item.conversation.post;
  return [text, mediaText ?? ""].some((source) => normalize(source).includes(words))
    ? null
    : `the quote "${quote.text}" is not word for word in the post`;
}

/** Where a move needs what the post or the plan lacks, in words, or null. */
function moveFault(move: PlanMove, item: PlanningItem, story: PlanningStory | null, asks: boolean): string | null {
  if (move === "answer_room" && !canAnswerRoom(item.research?.room)) {
    return "answer_room needs a pain or an open question in the room, and this post's room holds none";
  }
  if (move === "your_story" && !story) return "your_story needs one of the owner's stories, and the plan tells none";
  if (move === "question" && !asks) return "the question move needs the comment to ask, and the plan asks nothing";
  if (move === "react" && asks) return "a reaction stands on its own, and the plan asks a question";
  if (move === "step" && !item.step) return "the step move needs a step that says what the message does, and this one has none";
  if (move !== "step" && item.step) return "a message its step writes does what the step asks, so its move is step";
  return null;
}

/** Where a question-first opening breaks the plan around it, in words, or
 *  null: it asks, and the question is the whole comment. */
function questionOpeningFault(plan: Pick<PlanChoices, "question" | "style">): string | null {
  if (plan.style.opening !== QUESTION_OPENING) return null;
  if (!plan.question.ask) return `the ${QUESTION_OPENING} opening needs the comment to ask, and the plan asks nothing`;
  return plan.style.shape === QUESTION_SHAPE
    ? null
    : `the ${QUESTION_OPENING} opening makes the question the whole comment, so its shape is ${QUESTION_SHAPE}`;
}

/** The first mark or habit an example carries that the plan omits, in words. */
/** What an example carries that the plan leaves out, or null where it
 *  agrees with the plan. */
export function omittedIn(example: string, plan: PlanChoices): string | null {
  for (const [mark, choice] of marksOf(plan)) {
    if (choice === "omit" && usesSignature(example, mark)) return `"${mark}"`;
  }
  for (const [habit, choice] of habitsOf(plan)) {
    if (choice === "omit" && HABIT_READS[habit].carries(example)) return `the habit ${habit}`;
  }
  return null;
}

/** Where one rated family (marks or habits) breaks the compile: a key it does
 *  not decide, one it was not given, or a use of one the compile leaves out. */
function ratedFaults(
  noun: "mark" | "habit",
  said: Map<string, Choice>,
  compiled: Record<string, Rated>,
): string[] {
  const name = (key: string) => (noun === "mark" ? `the mark "${key}"` : `the habit ${key}`);
  const faults: string[] = [];
  for (const [key, rated] of Object.entries(compiled)) {
    const choice = said.get(key);
    if (choice === undefined) faults.push(`the plan says nothing of ${name(key)}; say use or omit`);
    else if (choice === "use" && !rated.allowed) faults.push(`uses ${name(key)}, which this campaign's rules leave out`);
    else if (choice === "use" && rated.rate === 0) faults.push(`uses ${name(key)}, which the owner never writes`);
  }
  for (const key of said.keys()) {
    if (!(key in compiled)) faults.push(`${name(key)} is not one of the ${noun}s given`);
  }
  return faults;
}

/** The word range a plan may take: the compile's, and no wider than a
 *  character limit holds, where the draft has one. */
function lengthBounds({ length }: CompiledRules, { maxChars }: PlanningItem): { minWords: number; maxWords: number } {
  const maxWords = maxChars === undefined ? length.maxWords : Math.min(length.maxWords, wordsWithin(maxChars));
  return { minWords: Math.min(length.minWords, maxWords), maxWords };
}

/** Everything one plan breaks on its own. */
function planFaults(plan: PlanChoices, item: PlanningItem, lookup: Lookup): string[] {
  const { rules, examples } = lookup.input;
  const story = storyOf(plan, lookup);
  const faults: string[] = [];

  if (!plan.point.buildOn) faults.push("names no point to build on");
  if (!plan.point.quotes.some((quote) => quote.source === "post")) faults.push("the point quotes no words of the post");
  for (const quote of plan.point.quotes) {
    const fault = quoteFault(quote, item, story);
    if (fault) faults.push(fault);
  }
  if (plan.story.id != null && !story) faults.push(`story ${plan.story.id} is not one of the owner's stories`);
  const move = moveFault(plan.move.value, item, story, plan.question.ask);
  if (move) faults.push(move);

  for (const axis of STYLE_AXES) {
    if (!stylesOf(rules, axis).some((style) => style.id === plan.style[axis])) {
      faults.push(`the ${axis} "${plan.style[axis]}" is not one of the ${axis}s given`);
    }
  }
  if (plan.style.shape === STORY_SHAPE && !story) faults.push(`the ${STORY_SHAPE} shape needs a story, and the plan tells none`);
  const opening = questionOpeningFault(plan);
  if (opening) faults.push(opening);

  const { minWords, maxWords } = lengthBounds(rules, item);
  if (plan.length.minWords > plan.length.maxWords) {
    faults.push(`the length runs from ${plan.length.minWords} down to ${plan.length.maxWords} words`);
  } else if (plan.length.minWords < minWords || plan.length.maxWords > maxWords) {
    const limit = item.maxChars === undefined ? "" : ` (at most ${item.maxChars} characters)`;
    faults.push(`${plan.length.minWords} to ${plan.length.maxWords} words is outside the ${minWords} to ${maxWords} allowed${limit}`);
  }

  // The owner's own words about this comment outrank the campaign's rule.
  const must = item.ask ? null : rules.question.must;
  if (plan.question.ask && must === "never") faults.push("asks a question, and this campaign's comments never ask one");
  if (!plan.question.ask && must === "ask") faults.push("asks no question, and every comment on this campaign asks one");

  const habits = habitsOf(plan);
  faults.push(...ratedFaults("mark", marksOf(plan), rules.marks));
  faults.push(...ratedFaults("habit", habits, rules.habits));
  // How a voice asks is a share of its questions: with none, there is no way
  // of asking to permit.
  if (!plan.question.ask && habits.get("eitherOrRate") === "use") {
    faults.push("uses the habit eitherOrRate, a way of asking, and the plan asks no question");
  }

  if (plan.examples.length > lookup.input.examplesMax) {
    faults.push(`shows ${plan.examples.length} examples, and a plan shows at most ${lookup.input.examplesMax}`);
  }
  for (const index of new Set(plan.examples)) {
    const example = examples[index];
    if (example === undefined) {
      faults.push(`example ${index} is not one of the owner's examples`);
      continue;
    }
    const carried = omittedIn(example, plan);
    if (carried) faults.push(`example ${index} carries ${carried}, which this plan omits`);
  }
  return faults;
}

/** One rated thing's uses across the batch, in priority order: the plans past
 *  the budget, each with why. */
function overBudget(
  plans: readonly PlanChoices[],
  uses: (plan: PlanChoices) => boolean,
  ceiling: number,
  fault: string,
): Map<number, string> {
  const over = new Map<number, string>();
  let used = 0;
  for (const plan of plans) {
    if (!uses(plan)) continue;
    used += 1;
    if (used > ceiling) over.set(plan.discoveredPostId, fault);
  }
  return over;
}

/** The batch's budget faults, by post: past a ceiling, the plans latest in
 *  `plans` are the ones over it. What the compile forbids outright is each
 *  plan's own fault, so it is not counted here again. */
function budgetFaults(plans: readonly PlanChoices[], input: PlanningInput): Map<number, string[]> {
  const { rules, budget } = input;
  const faults = new Map<number, string[]>();
  const add = (over: Map<number, string>) => {
    for (const [id, fault] of over) faults.set(id, [...(faults.get(id) ?? []), fault]);
  };
  const of = (n: number) => `${n} of its ${commentsIn(budget.size)}`;
  for (const [mark, rated] of Object.entries(rules.marks)) {
    if (!usable(rated)) continue;
    const ceiling = budget.marks[mark] ?? 0;
    add(overBudget(plans, (plan) => marksOf(plan).get(mark) === "use", ceiling,
      `uses the mark "${mark}", and this batch may carry it in only ${of(ceiling)}`));
  }
  for (const habit of PLAN_HABITS) {
    const rated = rules.habits[habit];
    if (!usable(rated)) continue;
    const ceiling = budget.habits[habit] ?? 0;
    add(overBudget(plans, (plan) => habitsOf(plan).get(habit) === "use", ceiling,
      `uses the habit ${habit}, and this batch may carry it in only ${of(ceiling)}`));
  }
  if (rules.question.must !== "never") {
    add(overBudget(plans, (plan) => plan.question.ask, budget.question,
      `asks a question, and this batch may ask in only ${of(budget.question)}`));
  }
  return faults;
}

/**
 * The code check of one batch's plans: each post's faults in plain words, for
 * the posts that have any. A plan for a post outside the batch is not checked:
 * it is no plan of this batch. `plans` is in priority order, the first to
 * claim a budgeted mark, habit or question keeping it, so a later plan is the
 * one over budget.
 */
export function checkPlans(input: PlanningInput, plans: readonly PlanChoices[]): Map<number, string[]> {
  const lookup = lookupOf(input);
  const ours = plans.filter((plan) => lookup.items.has(plan.discoveredPostId));
  const faults = new Map<number, string[]>();
  for (const plan of ours) {
    const own = planFaults(plan, lookup.items.get(plan.discoveredPostId)!, lookup);
    if (own.length > 0) faults.set(plan.discoveredPostId, own);
  }
  for (const [id, over] of budgetFaults(ours, input)) faults.set(id, [...(faults.get(id) ?? []), ...over]);
  return faults;
}

/** What is left of a budget after `plans` take their share, for `size` more:
 *  never past `size`, as `budgetFor` deals it. */
export function budgetLeft(input: PlanningInput, plans: readonly PlanChoices[], size: number): Budget {
  const { budget } = input;
  const left = (ceiling: number, uses: (plan: PlanChoices) => boolean) =>
    Math.min(size, Math.max(0, ceiling - plans.filter(uses).length));
  return {
    size,
    marks: Object.fromEntries(Object.entries(budget.marks).map(([mark, ceiling]) =>
      [mark, left(ceiling, (plan) => marksOf(plan).get(mark) === "use")])),
    habits: Object.fromEntries(Object.entries(budget.habits).map(([habit, ceiling]) =>
      [habit, left(ceiling, (plan) => habitsOf(plan).get(habit as PlanHabit) === "use")])),
    question: left(budget.question, (plan) => plan.question.ask),
  };
}

/** The highest-weighted style on an axis, first on a tie, that `fits`. */
function topStyle(rules: CompiledRules, axis: Axis, fits: (id: string) => boolean): string | undefined {
  return [...stylesOf(rules, axis)].filter((style) => fits(style.id)).sort((a, b) => b.weight - a.weight)[0]?.id;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** The highest-weighted opening that does not ask. */
const statedOpening = (rules: CompiledRules) => topStyle(rules, "opening", (id) => id !== QUESTION_OPENING);

/** A plan that asks nothing, with what only a question allows going with it:
 *  the question move, opening on the question, and handing over two options. */
function withoutQuestion(plan: PlanChoices, rules: CompiledRules, why: string): PlanChoices {
  return {
    ...plan,
    question: { ask: false, why },
    move: plan.move.value === "question"
      ? { value: FALLBACK_MOVE, why: "The comment asks nothing, so it agrees and adds a detail instead." }
      : plan.move,
    style: plan.style.opening === QUESTION_OPENING
      ? { ...plan.style, opening: statedOpening(rules) ?? plan.style.opening }
      : plan.style,
    habits: plan.habits.map((h) => (h.habit === "eitherOrRate" ? { ...h, choice: "omit" } : h)),
  };
}

/** One plan with every field it may hold on its own: what breaks a rule set to
 *  the safe value, and the reason rewritten where code changed the choice. */
function settleOne(plan: PlanChoices, item: PlanningItem, lookup: Lookup): PlanChoices {
  const { rules } = lookup.input;
  const must = item.ask ? null : rules.question.must;
  const asked =
    must === "never" && plan.question.ask ? withoutQuestion(plan, rules, "This campaign's comments never ask a question.")
      : must === "ask" && !plan.question.ask ? { ...plan, question: { ask: true, why: "Every comment on this campaign asks a question." } }
        : plan;
  const story = storyOf(asked, lookup);
  const move = moveFault(asked.move.value, item, story, asked.question.ask);
  const style = { ...asked.style };
  for (const axis of STYLE_AXES) {
    const fits = (id: string) => (axis !== "shape" || story != null || id !== STORY_SHAPE)
      && stylesOf(rules, axis).some((s) => s.id === id);
    if (!fits(style[axis])) style[axis] = topStyle(rules, axis, fits) ?? style[axis];
  }
  // A question-first comment is its one question: it asks, in one line.
  if (questionOpeningFault({ question: asked.question, style })) {
    if (asked.question.ask && stylesOf(rules, "shape").some((s) => s.id === QUESTION_SHAPE)) style.shape = QUESTION_SHAPE;
    else style.opening = statedOpening(rules) ?? style.opening;
  }
  const bounds = lengthBounds(rules, item);
  const [lo, hi] = [asked.length.minWords, asked.length.maxWords]
    .map((words) => clamp(words, bounds.minWords, bounds.maxWords))
    .sort((a, b) => a - b) as [number, number];
  const settled = (compiled: Record<string, Rated>, said: Map<string, Choice>, may: (key: string) => boolean) =>
    Object.entries(compiled).map(([key, rated]) =>
      [key, usable(rated) && may(key) ? (said.get(key) ?? "omit") : "omit"] as const);
  return {
    ...asked,
    point: { ...asked.point, quotes: asked.point.quotes.filter((quote) => quoteFault(quote, item, story) === null) },
    move: move ? { value: item.step ? "step" : FALLBACK_MOVE, why: `The planned move could not stand: ${move}.` } : asked.move,
    story: (story || asked.story.id == null)
      ? asked.story
      : { id: null, why: `Story ${asked.story.id} is not one of the owner's stories.` },
    length: { minWords: lo, maxWords: hi },
    style,
    marks: settled(rules.marks, marksOf(asked), () => true).map(([mark, choice]) => ({ mark, choice })),
    habits: settled(rules.habits, habitsOf(asked), (habit) => habit !== "eitherOrRate" || asked.question.ask)
      .map(([habit, choice]) => ({ habit: habit as PlanHabit, choice })),
  };
}

/** Each use past a ceiling, latest in priority order first to go, set to
 *  omit; each ask past the question budget, to none. Questions go first,
 *  since a plan that stops asking stops handing over two options with it. */
function settleBudget(plans: PlanChoices[], input: PlanningInput): PlanChoices[] {
  const over = budgetFaults(plans, input);
  if (over.size === 0) return plans;
  const left = new Map<number, PlanChoices>(plans.map((plan) => [plan.discoveredPostId, plan]));
  const { budget } = input;
  const keep = (uses: (plan: PlanChoices) => boolean, ceiling: number, drop: (plan: PlanChoices) => PlanChoices) => {
    let used = 0;
    for (const plan of plans) {
      const current = left.get(plan.discoveredPostId)!;
      if (!uses(current)) continue;
      used += 1;
      if (used > ceiling) left.set(plan.discoveredPostId, drop(current));
    }
  };
  keep((plan) => plan.question.ask, budget.question, (plan) =>
    withoutQuestion(plan, input.rules, "This batch's questions went to its other posts."));
  for (const mark of Object.keys(input.rules.marks)) {
    keep((plan) => marksOf(plan).get(mark) === "use", budget.marks[mark] ?? 0, (plan) => ({
      ...plan, marks: plan.marks.map((m) => (m.mark === mark ? { ...m, choice: "omit" } : m)),
    }));
  }
  for (const habit of PLAN_HABITS) {
    if (!input.rules.habits[habit]) continue;
    keep((plan) => habitsOf(plan).get(habit) === "use", budget.habits[habit] ?? 0, (plan) => ({
      ...plan, habits: plan.habits.map((h) => (h.habit === habit ? { ...h, choice: "omit" } : h)),
    }));
  }
  return plans.map((plan) => left.get(plan.discoveredPostId)!);
}

/** The words code gives an owner for a post it could not plan. */
export const NO_POINT_REASON = "could not find words in the post to build on";

/**
 * A batch's plans with every fault set to its safe value: a mark or habit
 * omitted, a question not asked where none may be, an unknown story dropped
 * with any shape or move that needed it, a length clamped, a quote that is not
 * its source's words dropped, and an example that disagrees with its plan
 * dropped. A plan left with no point or no quote of the post is no plan; nor
 * is one the check still faults after all that, which code alone cannot have
 * produced. `plans` is in priority order, as `checkPlans` takes it.
 */
export function settlePlans(
  input: PlanningInput,
  plans: readonly PlanChoices[],
): { plans: PlanChoices[]; unplanned: Map<number, string> } {
  const lookup = lookupOf(input);
  const unplanned = new Map<number, string>();
  const own = plans.flatMap((plan) => {
    const item = lookup.items.get(plan.discoveredPostId);
    if (!item) return [];
    const settled = settleOne(plan, item, lookup);
    if (settled.point.buildOn && settled.point.quotes.some((quote) => quote.source === "post")) return [settled];
    unplanned.set(plan.discoveredPostId, NO_POINT_REASON);
    return [];
  });
  const settled = settleBudget(own, input).map((plan) => ({
    ...plan,
    examples: [...new Set(plan.examples)]
      .filter((index) => {
        const example = input.examples[index];
        return example !== undefined && omittedIn(example, plan) === null;
      })
      .slice(0, input.examplesMax),
  }));
  const faults = checkPlans(input, settled);
  for (const [id, [fault]] of faults) unplanned.set(id, fault!);
  return { plans: settled.filter((plan) => !faults.has(plan.discoveredPostId)), unplanned };
}
