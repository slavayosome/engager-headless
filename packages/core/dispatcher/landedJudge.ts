import { and, desc, eq, sql, type SQLWrapper } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import { draftAttempts } from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import type { LLM } from "../ai/client";
import type { DraftEvidence } from "../workers/evidenceReview";
import type { DispatchedDraft } from "./draftFromPlans";
import { combineVerdicts, judgeByModel } from "./judgeModel";
import { PlanVerdictSchema } from "./types";

/**
 * THE MODEL'S JUDGE OF WORDS THE OWNER ASKED FOR, read after they land (spec
 * "Draft Dispatcher" v0.3). An owner's ask is planned and written in one call
 * and judged by code before its words reach the box (`compose.ts`); the
 * model's judge — the facts, and the plan items only a reader can judge —
 * reads the landed attempt in the background, and its verdicts join code's on
 * the attempt row. A claim the evidence does not support becomes the
 * attempt's reason, the note the box shows under those words.
 *
 * No unjudged agent words go out: every press that queues, sends or approves
 * words the owner left untouched asks {@link assertJudgedWords} first, which
 * refuses words the model has not judged yet or found a claim in that their
 * sources do not support. Before its transaction a press waits for a judge
 * still at work in this process ({@link landedJudged}), so a quick press is
 * not refused for being early. Words the owner changed are theirs, and pass
 * as they always did. The box shows the same check under the words before
 * any press ({@link wordsCheck}).
 */

/** An attempt that landed, under its saved plan, with what a claim in it may
 *  rest on. */
export type Landed = { planId: number; draft: DispatchedDraft; evidence: DraftEvidence };

/** The judges at work, by organization and the words each reads: one map per
 *  process, whichever bundle loads this module, since the dashboard bundles
 *  its chat route apart from the actions whose presses wait on them. */
const JUDGING = Symbol.for("engager.dispatcher.landedJudges");
const judging: Map<string, Promise<void>> = ((globalThis as { [JUDGING]?: Map<string, Promise<void>> })[JUDGING] ??=
  new Map());

/** Words as a press compares them with what was offered: whitespace folded. */
const keyOf = (organizationId: string, text: string) => `${organizationId}\n${text.trim().replace(/\s+/gu, " ")}`;

async function judgeAndMerge(organizationId: string, llm: LLM, landed: readonly Landed[]): Promise<void> {
  const judged = await judgeByModel(
    llm,
    landed.map(({ draft, evidence }) => ({ plan: draft.plan, text: draft.attempts.at(-1)!.text, evidence })),
  );
  await withOrg(organizationId, async (tx) => {
    for (const { planId, draft } of landed) {
      const judgement = judged.get(draft.id);
      // A judge that answered nothing for these words judged nothing: they
      // stay unjudged, as a failed call leaves them, never unsupported.
      if (!judgement || judgement.unanswered) continue;
      const attempt = draft.attempts.at(-1)!;
      const verdicts = combineVerdicts(attempt.verdicts, judgement.verdicts);
      const facts = verdicts.find((verdict) => verdict.item === "facts");
      await tx
        .update(draftAttempts)
        .set({ verdicts, ...(facts && !facts.pass ? { reason: facts.detail } : {}) })
        .where(and(eq(draftAttempts.planId, planId), eq(draftAttempts.attempt, attempt.attempt)));
    }
  });
}

/**
 * Judge each landed draft's last attempt with the model, through the agent
 * that wrote it, and keep its verdicts on the attempt: started at once and
 * left to run, settling — never failing — when they are kept. A failure is
 * logged and leaves the attempt unjudged, which every press of its words
 * refuses.
 */
export function judgeLanded(organizationId: string, llm: LLM, landed: readonly Landed[]): Promise<void> {
  if (landed.length === 0) return Promise.resolve();
  const work = judgeAndMerge(organizationId, llm, landed).catch((error: unknown) => {
    console.error(
      "[dispatcher] the judge of a draft the owner asked for failed; its words are not sent until it is judged:",
      error instanceof Error ? error.message : error,
    );
  });
  for (const { draft } of landed) {
    const key = keyOf(organizationId, draft.attempts.at(-1)!.text);
    const earlier = judging.get(key);
    const entry = earlier ? Promise.all([earlier, work]).then(() => undefined) : work;
    judging.set(key, entry);
    void entry.finally(() => {
      if (judging.get(key) === entry) judging.delete(key);
    });
  }
  return work;
}

/** Wait for a judge this process has at work on these words, if any. Called
 *  before a press's transaction, never inside one. */
export async function landedJudged(organizationId: string, text: string): Promise<void> {
  await judging.get(keyOf(organizationId, text));
}

/** Whitespace folded in the database, alike on both sides of a comparison. */
const folded = (value: SQLWrapper | string) => sql`btrim(regexp_replace(${value}, ${"\\s+"}, ' ', 'g'))`;

/** How long the model's judge may be out on landed words before it is taken
 *  as gone: a judge answers in seconds, so one silent this long died. */
const JUDGE_GONE_MS = 2 * 60_000;

/** What a press of words the owner left untouched meets, before it is made:
 *  the model's judge still out on them (`checking`) or gone without answering
 *  (`unchecked`), or a claim it found their sources do not support
 *  (`unsupported`), its `detail` a clause. Words that pass meet none. */
export type WordsCheck = { state: "checking" } | { state: "unchecked" } | { state: "unsupported"; detail: string };

/**
 * The check a press of these words meets: the facts verdict of the newest
 * attempt whose words these are, untouched. Words no attempt holds are the
 * owner's and pass, as words whose facts the judge passed do. The send gate
 * ({@link assertJudgedWords}) and the box's line under the words both read
 * this one lookup, so the box says what the press will do.
 */
export async function wordsCheck(tx: Tx, text: string, now = Date.now()): Promise<WordsCheck | null> {
  if (!text.trim()) return null;
  const [attempt] = await tx
    .select({ verdicts: draftAttempts.verdicts, createdAt: draftAttempts.createdAt })
    .from(draftAttempts)
    .where(sql`${folded(draftAttempts.text)} = ${folded(text)}`)
    .orderBy(desc(draftAttempts.id))
    .limit(1);
  if (!attempt) return null;
  const facts = PlanVerdictSchema.array().parse(attempt.verdicts).find((verdict) => verdict.item === "facts");
  if (facts?.pass) return null;
  if (facts) return { state: "unsupported", detail: facts.detail.replace(/[.\s]+$/u, "") };
  return now - attempt.createdAt > JUDGE_GONE_MS ? { state: "unchecked" } : { state: "checking" };
}

/**
 * Refuse a press of agent words the model has not judged, or whose claim it
 * found unsupported ({@link wordsCheck}). Words no attempt holds are the
 * owner's, and pass.
 */
export async function assertJudgedWords(tx: Tx, text: string): Promise<void> {
  const check = await wordsCheck(tx, text);
  if (check === null) return;
  if (check.state === "unsupported") {
    throw new AppError(
      "draft_unsupported",
      `This draft claims something its sources do not support: ${check.detail}. Edit it into your own words, or ask for another draft.`,
      409,
    );
  }
  throw new AppError(
    "draft_unjudged",
    "This draft has not been checked against what it answers yet. Try again in a moment; if it stays unchecked, ask for another draft or edit it into your own words.",
    409,
  );
}
