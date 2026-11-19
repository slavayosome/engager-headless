import { and, eq, notInArray } from "drizzle-orm";
import { z } from "zod";
import { campaigns, discoveredPosts, messages, type Campaign, type DiscoveredPost, type Message } from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import type { LLM } from "../ai/client";
import { getCommentDraftingContext } from "../operations/clientDrafting";
import { COMMENT_LENGTH_LIMIT } from "../commentLength";
import { compiledRulesAtHand } from "../dispatcher/compile";
import { dispatchedWithheldNote, saveAttempts } from "../dispatcher/draftFromPlans";
import { judgeLanded } from "../dispatcher/landedJudge";
import { dispatchPosts, readDispatchInputs } from "../dispatcher/phase";
import { savePlans } from "../dispatcher/planner";
import type { OwnerAsk } from "../dispatcher/types";
import type { RoomDraftingContext } from "../operations/researchReads";
import { draftEvidence, type CommentDraftingContext } from "../workers/phases";
import {
  boxWords,
  boxWordsSchema,
  commentMoves,
  ownerAskOf,
  planAngle,
  type BoxWords,
  type ComposerAsk,
  type RequestedCommentWords,
} from "./requestedDraft";

/**
 * WORDS FOR A COMMENT THE OWNER IS WRITING — the thread's Draft for me, in
 * the box under a person's post. The draft dispatcher plans and writes one
 * comment on the comment surface in one call, judges it by code, and the
 * words go back to the box as the turn's last text: raw material, written
 * nowhere. No draft, request, stage or candidate status records them; only
 * the dispatcher's plan and attempt do. What goes out is only what the owner
 * presses Save on (`saveOwnerComment`), measured there for how much of these
 * words it kept.
 *
 * The model calls are the chat agent's own (`judgeLLM`), so the dock shows
 * what the owner's agent did. The model's judge reads the words after they
 * land (`landedJudge.ts`): a claim the post and the owner's facts do not
 * support is noted on the attempt, and Save refuses those words untouched;
 * any other miss is a note, never a dead end.
 */

export const RequestedCommentText = z.object({ text: z.string().trim().min(1).max(COMMENT_LENGTH_LIMIT) }).strict();

/** One judgment of the chat turn: the agent answers a system prompt and its
 *  source data in the schema asked for. */
export type Judge = (input: { system: string; context: unknown; schema: z.ZodTypeAny }) => Promise<unknown>;

/** The chat agent as the dispatcher's model: every call it makes is a
 *  structured judgment, answered by the owner's own agent. */
export function judgeLLM(judge: Judge): LLM {
  return {
    text: async () => {
      throw new Error("the chat agent answers structured judgments only");
    },
    json: async <T>(opts: { system?: string; user: string; schema: z.ZodType<T> }) =>
      (await judge({ system: opts.system ?? "", context: opts.user, schema: opts.schema })) as T,
  };
}

/** The post to word a comment on, for the owner's own box; refused once the
 *  box would take no words — the post gone, or a comment of ours on it already
 *  (a draft turned down is none) — and where no campaign can be named for it.
 *  An angle the composer asks for (`composer`) is one more beside a draft of
 *  ours still waiting for a yes, which the owner may choose it into
 *  (`useComposerAngle`); only one past waiting closes its box. Nothing is
 *  filed. */
export async function prepareCommentWords(
  tx: Tx,
  request: RequestedCommentWords,
): Promise<{ campaign: Campaign; post: DiscoveredPost; context: CommentDraftingContext }> {
  const [post] = await tx.select().from(discoveredPosts).where(eq(discoveredPosts.id, request.postId));
  const open: Message["status"][] = request.composer ? ["rejected", "proposed"] : ["rejected"];
  const [commented] = post
    ? await tx
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.kind, "comment"), eq(messages.discoveredPostId, post.id), notInArray(messages.status, open)))
    : [];
  if (!post || commented) throw new Error("comment_request_closed");
  const [campaign] = post.campaignId === null ? [] : await tx.select().from(campaigns).where(eq(campaigns.id, post.campaignId));
  if (!campaign) throw new Error("comment_campaign_missing");
  const drafting = await getCommentDraftingContext(tx, campaign, { discoveredPostId: post.id, llm: null });
  if (!drafting.ok) throw new Error("comment_context_unavailable");
  return { campaign, post, context: drafting.data };
}

/**
 * The owner's-box workflow for a comment: read the post, have the dispatcher
 * plan, write and judge one comment through the chat agent, and hand the words
 * back as the turn's last text. Nothing is delivered; the plan and its
 * attempts are kept, and the model's judge starts on what landed. An angle the
 * composer asked for (`ask`) goes to the planner as the owner's own words; a
 * new angle is its plan's move and reason, with the words, or, for an idea,
 * without them.
 */
export async function runCommentWords(deps: {
  organizationId: string;
  request: RequestedCommentWords;
  llm: LLM;
  progress: (text: string) => void;
  ask?: ComposerAsk;
  /** Asked before each phase, as the broker asks it of every step. */
  active?: () => Promise<void>;
}): Promise<BoxWords> {
  const { organizationId, llm, ask } = deps;
  const now = Date.now();
  deps.progress("Reading the post and your voice…");
  await deps.active?.();
  const read = await withOrg(organizationId, async (tx) => {
    const { campaign, post, context } = await prepareCommentWords(tx, deps.request);
    return { campaign, post, context, snapshot: await readDispatchInputs(tx, campaign, [post], new Map([[post.id, context]]), now) };
  });
  const { post, snapshot } = read;
  // A new angle is a different way in from the post's own.
  const postAngle = ask?.kind === "more" || ask?.kind === "idea" ? undefined : (read.context.post as { agentAngle?: unknown } | null)?.agentAngle;
  const owner: OwnerAsk | undefined = ownerAskOf(ask) ?? (typeof postAngle === "string" ? { note: `Take this angle in: ${postAngle}`, replacing: null } : undefined);
  const compiled = await compiledRulesAtHand(organizationId, llm, {
    campaignId: read.campaign.id,
    channel: "comment",
    voiceRules: snapshot.voiceRules,
    campaignRules: snapshot.campaignRules,
  });
  await deps.active?.();
  deps.progress(ask?.kind === "idea" ? "Finding a new way in…" : "Writing your comment…");
  const evidence = draftEvidence(post, read.context);
  const { plans, unplanned, outcome } = await dispatchPosts(llm, snapshot, new Map([[post.id, evidence]]), now, {
    compiled,
    planOnly: ask?.kind === "idea",
    ownerRequested: true,
    ...(owner ? { asks: new Map([[post.id, owner]]) } : {}),
  });
  const plan = plans.get(post.id);
  if (!plan) throw new Error(`The dispatcher could not plan a comment for this post (${unplanned.get(post.id) ?? "no plan came back"}). Your words are preserved. Try again, or write your own comment.`);
  const room = (read.context.research as { room?: RoomDraftingContext } | null)?.room;
  const schema = boxWordsSchema(RequestedCommentText, ask, commentMoves(room));
  const named = ask?.kind === "more" || ask?.kind === "idea" ? planAngle(plan, commentMoves(room)) : {};
  if (ask?.kind === "idea") return boxWords(schema.parse(named));
  if (outcome) {
    // Kept as every dispatched draft is, so the model's judge can read the
    // words once they land, and a press of them waits for it.
    const planIds = await withOrg(organizationId, async (tx) => {
      const ids = await savePlans(tx, { campaignId: read.campaign.id, runId: null }, plans);
      await saveAttempts(tx, ids, [...outcome.admitted, ...outcome.withheld]);
      return ids;
    });
    void judgeLanded(organizationId, llm, outcome.admitted.map((draft) => ({ planId: planIds.get(draft.id)!, draft, evidence })));
  }
  const draft = outcome?.admitted[0];
  if (!draft) {
    const withheld = outcome?.withheld[0];
    const why = withheld ? dispatchedWithheldNote({ admitted: [], withheld: [withheld], unwritten: [] }, new Map(), ["comment", "comments"]) : "the writer returned no draft";
    throw new Error(`Your agent's draft was held back: ${why}. Your words are preserved. Try again, or write your own comment.`);
  }
  return boxWords(schema.parse({ text: draft.attempts.at(-1)!.text, ...named }));
}
