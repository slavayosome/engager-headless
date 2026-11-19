import { z } from "zod";
import type { LLM } from "../ai/client";
import { modelFor } from "../ai/modelFor";
import { THEIR_WORDS_LINE } from "./judgeCode";
import { PlanChoicesSchema, type PlanningInput, type PlanningItem } from "./planCheck";
import { compiledFields, planDrafts, planInBatches, planPrompt, plansAsked, planSystemFor, planTokens } from "./planner";
import { conversationId, type DraftPlan } from "./types";
import { renderCompiled, voiceBlock, WRITING_RULES, type WriterVoice } from "./writer";

/**
 * WORDS THE OWNER IS WAITING ON, IN ONE CALL (spec "Draft Dispatcher" v0.3,
 * an owner's ask): each comment planned as the planner plans it and written as
 * the writer writes it, from that plan, in one model call — the planner's and
 * the writer's own prompts, fenced as they fence them. A worker run keeps
 * planner, writer and judge apart; an owner who pressed Draft is waiting.
 *
 * Nothing is asked twice. The choices are settled by code (`settlePlans`)
 * rather than re-asked, and the words are judged by code alone before they
 * land (`draftFromPlans` with `composed`); the model's judge reads them after
 * (`landedJudge.ts`), and no press sends them before it has.
 */

/** Bumped with any change to what the call is told or how it is read. */
const COMPOSE_PROMPT = "dispatcher.compose@3";
/** As many comments as one call plans and writes, as the planner and the
 *  writer batch them. */
const COMPOSE_BATCH_SIZE = 5;
/** Output for one comment's words, as the writer budgets them. */
const WORDS_TOKENS = 2000;

const ComposedSchema = z.object({
  drafts: z.array(PlanChoicesSchema.extend({ text: z.string().min(1).max(3000) })),
});

const COMPOSE_RULES = [
  "You plan and then write LinkedIn comments the owner will post, in one answer: for each id, its plan's choices and then `text`, the comment written to that plan.",
  "Plan each one as the planning rules below say. Then write it as the writing rules after them say, holding its words to the plan you made line by line, as a writer handed that plan would.",
  "",
];

const WRITE_RULES = [
  "",
  "WRITING: each `text` is the comment its plan describes, and adds nothing the plan does not ask for:",
  "- it builds on the point, leaning on the words quoted for it, and makes the move;",
  "- it tells the story the plan names, in the first person and in fresh words, or claims no experience of the owner's;",
  "- where the plan asks, it ends on exactly one open question that asks one thing, or is that question from its first word under the question_open opening; where it does not, it asks nothing;",
  "- it runs within the length range, and within `maxChars` characters where an id has them;",
  "- it opens, takes the shape and the stance its style ids say, carries every mark the plan uses and none it omits, and makes no habit it omits;",
  "- it sounds the way the examples the plan picks do, and copies none of their content, phrases or openers;",
  "- it keeps every line of its id's RULES.",
];

const OPENER_WORDS = `- an opener: ${THEIR_WORDS_LINE}`;
const ASK_WORDS = "- an ask: on how the comment sounds, the OWNER NOTE outranks HOW YOU SOUND and the examples.";
const STEP_WORDS = "- a message with a `step` line: it does what the step asks, which outranks its point and style ids, and keeps to its length, question and RULES.";

/** What a batch is told: the planner's rules for its ids, then how their
 *  words are written. */
function composeSystem(items: readonly PlanningItem[]): string {
  return [
    ...COMPOSE_RULES,
    planSystemFor(items),
    ...WRITE_RULES,
    ...(items.some((item) => item.opener) ? [OPENER_WORDS] : []),
    ...(items.some((item) => item.step) ? [STEP_WORDS] : []),
    ...(items.some((item) => item.ask) ? [ASK_WORDS] : []),
    ...WRITING_RULES,
  ].join("\n");
}

/** The planner's prompt for the batch, with what the compile settles for each
 *  id's words whatever its plan chooses. */
function composePrompt(input: PlanningInput, now: number, voice: WriterVoice | undefined): string {
  return [
    `draftingAsOf: ${new Date(now).toISOString()}`,
    voiceBlock(voice),
    planPrompt(input),
    ...input.items.map((item) =>
      `RULES FOR ${conversationId(item.conversation)} (binding on its words):\n${renderCompiled(compiledFields(input.rules, item))}`),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Plans the code check settled, and the words written to each. */
export type Composed = {
  plans: Map<number, DraftPlan>;
  texts: Map<number, string>;
  unplanned: Map<number, string>;
};

/**
 * Plan and write a comment for each item, one call per batch of five, each
 * batch within what the budget leaves after the batches before it. Every plan
 * returned passed the code check, with code's safe values where the model's
 * choice did not; its words were written to the model's own, which the code
 * judge holds to the settled plan. A call that fails leaves its whole batch
 * unplanned, as the planner's does.
 */
export async function composeDrafts(
  llm: LLM,
  input: PlanningInput,
  opts: { now: number; voice?: WriterVoice },
): Promise<Composed> {
  const texts = new Map<number, string>();
  const { plans, unplanned } = await planInBatches(input, COMPOSE_BATCH_SIZE, async (batch) => {
    const result = await llm.json({
      // The tier of the writer and the planner it stands in for.
      model: modelFor("writer"),
      stage: "dispatcher_compose",
      promptRef: COMPOSE_PROMPT,
      schema: ComposedSchema,
      strict: true,
      system: composeSystem(batch.items),
      user: composePrompt(batch, opts.now, opts.voice),
      maxTokens: 512 + planTokens(batch) + batch.items.length * WORDS_TOKENS,
    });
    return [...plansAsked(batch, result.drafts).values()].map(({ text, ...choices }) => {
      // Trimmed, as the writer's are, and nothing more: what the plan leaves
      // out is the judge's to find.
      texts.set(choices.discoveredPostId, text.trim());
      return choices;
    });
  });
  return { plans, texts: new Map([...texts].filter(([id]) => plans.has(id))), unplanned };
}

/** Plans, and the words already written to them where they were composed. */
export type Planned = Omit<Composed, "texts"> & Partial<Pick<Composed, "texts">>;

/** The plans for a batch: composed with their words where `composing` says
 *  how — an owner's ask, waiting on them — else planned alone, for a writer
 *  and a judge after. */
export function planOrCompose(
  llm: LLM,
  input: PlanningInput,
  composing: { now: number; voice?: WriterVoice } | null,
): Promise<Planned> {
  return composing ? composeDrafts(llm, input, composing) : planDrafts(llm, input);
}
