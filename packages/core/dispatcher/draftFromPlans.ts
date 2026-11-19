import { draftAttempts } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import type { LLM } from "../ai/client";
import type { DraftEvidence } from "../workers/evidenceReview";
import { COULD_GO_TO_FIFTY, judgeAndFix, type CodeJudgeContext } from "./judgeCode";
import { combineVerdicts, firstMiss, judgeByModel, type ModelJudgement } from "./judgeModel";
import { conversationId, type DraftConversation, type DraftPlan, type OwnerAsk, type PlanVerdict } from "./types";
import { writeFromPlans, type DraftRewrite, type WriterVoice, type WrittenDraft } from "./writer";

/**
 * From saved plans to drafts the judge passed (spec "Draft Dispatcher" v0.3,
 * "Rewrite once"): write each from its plan, judge it with code, which also
 * repairs what changes no meaning, then with a model. A draft that misses a
 * fact, specificity, or what the plan leaves out of it (a story, a repeat, a
 * product or a link) is written once more with its misses named, and judged
 * again; a second miss withholds it. A miss no rewrite of the same plan can
 * fix (`planAgainOn`) is withheld after its one attempt instead, for the
 * caller to plan anew. A miss of style only is no reason to
 * write again: the draft goes on with the miss kept as its note. A comment the
 * owner asked for blocks on a fact alone (`OWNER_BLOCKING_ITEMS`). Every text
 * and what the judge said of it is kept as an attempt, so a withheld draft
 * can be shown with the plan item it missed rather than as a count.
 */

export type DispatchItem = { plan: DraftPlan; conversation: DraftConversation; evidence: DraftEvidence; ask?: OwnerAsk };

export type DraftAttempt = {
  attempt: 1 | 2;
  text: string;
  verdicts: PlanVerdict[];
  outcome: "admitted" | "rewrite" | "withheld" | "held" | "discarded";
  /** The first miss, in the owner's words, including an admitted style note. */
  reason: string | null;
};

export type DispatchedDraft = {
  /** The id its batch knows it by (`conversationId`): its post's, or an
   *  opener's lead. */
  id: number;
  plan: DraftPlan;
  attempts: DraftAttempt[];
};

export type DispatchOutcome = {
  /** Passed on its first or second text: `attempts.at(-1).text` goes on. */
  admitted: DispatchedDraft[];
  /** Missed twice; `miss` is the second text's first miss. */
  withheld: (DispatchedDraft & { miss: PlanVerdict })[];
  /** Planned, but the writer returned nothing for it, on either pass. */
  unwritten: number[];
};

type Judged = { item: DispatchItem; text: string; verdicts: PlanVerdict[]; miss: PlanVerdict | null };

/** The items whose miss is a reason to write again or to withhold. The rest
 *  are style, and noted. Story, repeat, product and link are not style: an
 *  owner story or a product claim is a facts-type miss, a repeat is generic,
 *  and a link is an invariant. */
const BLOCKING_ITEMS: ReadonlySet<string> = new Set(["facts", "specific", "story", "repeat", "content.product", "content.link"]);

/** What blocks a comment the owner asked for: a claim the evidence does not
 *  support, a product claim being one. Their ask settles the rest, so a
 *  repeat, a story or any other miss goes on as a note. */
const OWNER_BLOCKING_ITEMS: ReadonlySet<string> = new Set(["facts", "content.product"]);

/** A draft past a hard character limit (an invitation's note) cannot be sent,
 *  so that length miss blocks under both policies; a miss of the soft word
 *  range is a note. */
const blocks = (verdict: PlanVerdict, plan: DraftPlan, text: string, ownerRequested: boolean) =>
  !verdict.pass &&
  ((verdict.item === "length" && plan.length.maxChars !== undefined && text.length > plan.length.maxChars) ||
    (ownerRequested ? OWNER_BLOCKING_ITEMS : BLOCKING_ITEMS).has(verdict.item));

/** Code first, repairing the mechanical misses, then — unless the model's
 *  judge reads the words after they land — the model on what code left; one
 *  verdict per item. */
async function judge(
  llm: LLM,
  written: readonly { item: DispatchItem; text: string }[],
  ctx: CodeJudgeContext,
  ownerRequested: boolean,
  modelLater: boolean,
): Promise<Judged[]> {
  const coded = written.map(({ item, text }) => ({ item, ...judgeAndFix(item.plan, text, { ...ctx, theirWords: item.evidence.post }) }));
  const byModel = modelLater
    ? new Map<number, ModelJudgement>()
    : await judgeByModel(llm, coded.map(({ item, text }) => ({ plan: item.plan, text, evidence: item.evidence })));
  return coded.map(({ item, text, verdicts }) => {
    const model = byModel.get(conversationId(item.conversation))?.verdicts ?? [];
    const all = combineVerdicts(verdicts, model);
    return { item, text, verdicts: all, miss: firstMiss(all.filter((verdict) => blocks(verdict, item.plan, text, ownerRequested))) };
  });
}

/** Each written draft beside the item it was planned for, in the items' order. */
function matched(items: readonly DispatchItem[], written: readonly Pick<WrittenDraft, "discoveredPostId" | "text">[]) {
  const byId = new Map(written.map((draft) => [draft.discoveredPostId, draft.text]));
  return items.flatMap((item) => {
    const text = byId.get(conversationId(item.conversation));
    return text === undefined ? [] : [{ item, text }];
  });
}

function attemptOf(judged: Judged, attempt: 1 | 2): DraftAttempt {
  return {
    attempt,
    text: judged.text,
    verdicts: judged.verdicts,
    outcome: judged.miss === null ? "admitted" : attempt === 1 ? "rewrite" : "withheld",
    reason: (judged.miss ?? firstMiss(judged.verdicts))?.detail ?? null,
  };
}

/**
 * Write, judge and rewrite once. `continueRun` is asked before each model
 * call, as the stage asks it; a stopped run returns null and keeps nothing.
 * A provider or schema failure throws, so no unjudged draft moves on.
 *
 * Words already written with their plans (`composed`, an owner's ask) are the
 * first attempts, and code alone judges them and any rewrite: the model's
 * judge reads what lands after it lands (`landedJudge.ts`), and every press
 * that sends it waits for that.
 */
export async function draftFromPlans(
  llm: LLM,
  items: readonly DispatchItem[],
  ctx: CodeJudgeContext,
  opts: {
    now: number;
    voice?: WriterVoice;
    continueRun?: () => Promise<boolean>;
    ownerRequested?: boolean;
    /** The plan items whose miss names the plan, not its wording: a draft
     *  missing one is not written again from the same plan but withheld, that
     *  item its `miss`. */
    planAgainOn?: ReadonlySet<string>;
    /** Each item's words, written in the call that planned it. */
    composed?: ReadonlyMap<number, string>;
  },
): Promise<DispatchOutcome | null> {
  const go = async () => !opts.continueRun || (await opts.continueRun());
  const outcome: DispatchOutcome = { admitted: [], withheld: [], unwritten: [] };
  if (items.length === 0) return outcome;
  const owner = opts.ownerRequested === true;
  const later = opts.composed !== undefined;
  const write = { now: opts.now, ...(opts.voice ? { voice: opts.voice } : {}) };

  if (!(await go())) return null;
  const first = matched(
    items,
    opts.composed
      ? [...opts.composed].map(([discoveredPostId, text]) => ({ discoveredPostId, text }))
      : await writeFromPlans(llm, items, write),
  );
  if (!(await go())) return null;
  const judgedFirst = await judge(llm, first, ctx, owner, later);

  const firstById = new Map(judgedFirst.map((judged) => [conversationId(judged.item.conversation), judged]));
  const planAgain = (judged: Judged) =>
    judged.verdicts.find((verdict) => opts.planAgainOn?.has(verdict.item) && blocks(verdict, judged.item.plan, judged.text, owner));
  const retry = judgedFirst.filter((judged) => judged.miss !== null && !planAgain(judged));
  const rewrites = new Map<number, DraftRewrite>(
    retry.map((judged) => [
      conversationId(judged.item.conversation),
      { text: judged.text, missed: judged.verdicts.filter((verdict) => blocks(verdict, judged.item.plan, judged.text, owner)) },
    ]),
  );

  let judgedSecond: Judged[] = [];
  if (retry.length > 0) {
    if (!(await go())) return null;
    const second = matched(
      retry.map((judged) => judged.item),
      await writeFromPlans(llm, retry.map((judged) => judged.item), { ...write, rewrites }),
    );
    if (!(await go())) return null;
    judgedSecond = await judge(llm, second, ctx, owner, later);
  }
  const secondById = new Map(judgedSecond.map((judged) => [conversationId(judged.item.conversation), judged]));

  for (const item of items) {
    const id = conversationId(item.conversation);
    const once = firstById.get(id);
    if (!once) {
      outcome.unwritten.push(id);
      continue;
    }
    if (once.miss === null) {
      outcome.admitted.push({ id, plan: item.plan, attempts: [attemptOf(once, 1)] });
      continue;
    }
    const twice = secondById.get(id);
    if (!twice) {
      // Its plan is to be made anew, or the rewrite came back empty: the first
      // miss is all there is to say.
      const attempts = [{ ...attemptOf(once, 1), outcome: "withheld" as const }];
      outcome.withheld.push({ id, plan: item.plan, attempts, miss: planAgain(once) ?? once.miss });
      continue;
    }
    const attempts = [attemptOf(once, 1), attemptOf(twice, 2)];
    if (twice.miss === null) outcome.admitted.push({ id, plan: item.plan, attempts });
    else outcome.withheld.push({ id, plan: item.plan, attempts, miss: twice.miss });
  }
  return outcome;
}

/** Keep every attempt of each planned draft, under its saved plan. */
export async function saveAttempts(
  tx: Tx,
  planIds: ReadonlyMap<number, number>,
  drafts: readonly DispatchedDraft[],
): Promise<void> {
  const rows = drafts.flatMap((draft) => {
    const planId = planIds.get(draft.id);
    return planId === undefined
      ? []
      : draft.attempts.map((attempt) => ({ planId, ...attempt }));
  });
  if (rows.length > 0) await tx.insert(draftAttempts).values(rows);
}

/** Which kind of miss withheld a draft, for the run's note. */
function missKind(miss: PlanVerdict): "facts" | "story" | "repeat" | "specific" | "plan" {
  if (miss.item === "facts") return "facts";
  if (miss.item === "story") return "story";
  if (miss.item === "repeat") return "repeat";
  if (miss.item === "specific") return "specific";
  return "plan";
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Why the dispatcher wrote nothing that went on, each cause with its count,
 * in the owner's words: the plan item a style miss names, the claim a fact
 * miss names. "A claim the post does not support" is said of a claim alone.
 * `of` names what was drafted for: matched posts, or leads.
 */
export function dispatchedWithheldNote(
  outcome: DispatchOutcome,
  unplanned: ReadonlyMap<number, string>,
  of: readonly [one: string, many: string] = ["match", "matches"],
): string {
  const causes: string[] = [];
  const byKind = new Map<string, PlanVerdict[]>();
  for (const { miss } of outcome.withheld) byKind.set(missKind(miss), [...(byKind.get(missKind(miss)) ?? []), miss]);
  const plan = byKind.get("plan") ?? [];
  if (plan.length > 0) {
    const items = [...new Set(plan.map((miss) => miss.item))].join(", ");
    causes.push(`${plural(plan.length, ...of)}: missed the plan (${items})`);
  }
  const facts = byKind.get("facts") ?? [];
  if (facts.length > 0) {
    causes.push(`${plural(facts.length, ...of)}: a claim the post does not support ("${facts[0]!.detail}")`);
  }
  const story = byKind.get("story") ?? [];
  if (story.length > 0) causes.push(`${plural(story.length, ...of)}: told a story the plan did not give it`);
  const repeat = byKind.get("repeat") ?? [];
  if (repeat.length > 0) causes.push(`${plural(repeat.length, ...of)}: repeats a comment already sent`);
  const generic = byKind.get("specific") ?? [];
  if (generic.length > 0) causes.push(`${plural(generic.length, ...of)}: ${COULD_GO_TO_FIFTY.toLowerCase()}`);
  if (outcome.unwritten.length > 0) {
    causes.push(`${plural(outcome.unwritten.length, ...of)}: the writer returned no draft`);
  }
  const said = causes.length > 0 ? [`withheld ${causes.join("; ")}`] : [];
  if (unplanned.size > 0) {
    const [reason] = unplanned.values();
    said.push(`the dispatcher could not plan ${plural(unplanned.size, ...of)} (${reason})`);
  }
  return said.length > 0 ? said.join("; ") : "nothing it wrote could be saved";
}
