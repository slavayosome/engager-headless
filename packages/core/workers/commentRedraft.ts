import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import {
  campaigns,
  discoveredPosts,
  messages,
  systemState,
  type Campaign,
  type DiscoveredPost,
  type Message,
} from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { campaignStops, lockPauses } from "../actions/pause";
import { lockEngagementSafety } from "../ratelimit/killswitch";
import { lockRoomEvidence } from "../rooms/eligibility";
import { readRoomForDrafting } from "../operations/researchReads";
import { contextHash } from "../tasks/hash";
import type { LLM } from "../ai/client";
import { modelFor } from "../ai/modelFor";
import { assertNotRecoveryOnly } from "../jobs/recoveryScope";
import { trackDraftDelivered } from "../telemetry/emit";
import {
  getCommentDraftingContext,
  submitCommentDraftBatch,
  type DurableDraftRequest,
} from "../operations/clientDrafting";
import { compiledRulesAtHand } from "../dispatcher/compile";
import { dispatchedWithheldNote, saveAttempts, type DispatchedDraft, type DispatchOutcome } from "../dispatcher/draftFromPlans";
import { judgeLanded, type Landed } from "../dispatcher/landedJudge";
import { savePlans } from "../dispatcher/planner";
import { currentRulesRevision, dispatchPosts, readDispatchInputs, type DispatchedPosts } from "../dispatcher/phase";
import type { DraftPlan } from "../dispatcher/types";
import type { DraftEvidence } from "./evidenceReview";
import { draftEvidence, type CommentDraftingContext } from "./phases";

/**
 * A COMMENT THE OWNER ASKED TO HAVE REDONE, on a campaign that runs on its
 * strategy, is the Ambassador's to write again. Redraft files the ask on the
 * row (`requestMessageRedraft`) and queues `redraft_comments` for its
 * campaign; the Ambassador's write step picks up any ask that job left.
 *
 * - Planned and written in one call by the draft dispatcher on the comment
 *   surface, as every comment the owner asks for is: the owner's note and the
 *   words it replaces go in as the ask. Code judges the words before they
 *   land, and the model's judge before this pass ends (`landedJudge.ts`); a
 *   claim it finds the post does not support is the attempt's note, and the
 *   owner's yes on those words is refused. Any other miss is a note.
 * - Taken in by the intake that completes a redraft (`submitCommentDraftBatch`,
 *   the ask as its durable authority): the same slop gate, the new words as
 *   the proposal, the revision log keeping the old ones, the ask cleared. It
 *   lands proposed whatever the worker's publish switch says: an ask returns
 *   to Review and waits for a yes.
 * - Compare-and-swap on the ask as it was read — its id, version and status.
 *   While it stands nothing but its own completion rewrites the words, so an
 *   owner who edited, decided or asked again meanwhile moved the row, and it
 *   is left as they left it.
 * - A rewrite that comes to nothing — the model, the review, the intake —
 *   leaves the ask standing with the reason on the row (`error`), and it is
 *   not tried again until the owner asks again, which clears it.
 *
 * A comment the owner wrote, and a campaign that does not run on its
 * strategy, are not this file's: their asks stay with the owner's own agent
 * (`clientDrafting.ts`).
 */

export type CommentRedraftPayload = { campaignId: number };

/** What one pass over a campaign's asks did, by message id. */
export type CommentRedraft = {
  /** Written again, waiting for the owner's yes. */
  redrafted: number[];
  /** Still asked for, with the reason on the row. */
  notWritten: number[];
};

const NOT_WRITTEN = "the redraft you asked for was not written";

/** The comments the owner asked to have written again, the ask still open
 *  and no rewrite of it failed yet. An agent's words only: a comment the owner
 *  wrote is theirs to redo, and the Ambassador's words in its place would go
 *  out under the spacing an owner's own comment gets, past the caps. */
const askedToRedo = (campaignId: number) =>
  and(
    eq(messages.campaignId, campaignId),
    eq(messages.kind, "comment"),
    eq(messages.publishOrigin, "worker"),
    eq(messages.status, "proposed"),
    isNotNull(messages.redraftRequestId),
    isNotNull(messages.discoveredPostId),
    isNull(messages.error),
  );

/** How many comments the owner asked this campaign's Ambassador to write
 *  again. */
export async function commentsAskedToRedo(tx: Tx, campaign: Campaign): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(messages)
    .where(askedToRedo(campaign.id));
  return row?.n ?? 0;
}

type Ask = {
  message: Message;
  post: DiscoveredPost;
  /** The ask as read: what its completion is swapped against. */
  request: DurableDraftRequest;
  evidence: DraftEvidence;
};

/** A new comment, and the saved plan it was written from. */
type Rewrite = { text: string; plan: DraftPlan; planId: number | null };

export async function redraftAskedComments(
  ctx: { organizationId: string; llm: LLM; runId?: number },
  campaignId: number,
  opts: { now?: number; continueRun?: () => Promise<boolean> } = {},
): Promise<CommentRedraft> {
  assertNotRecoveryOnly("draft");
  const now = opts.now ?? Date.now();
  const out: CommentRedraft = { redrafted: [], notWritten: [] };

  // ---- read (short tx) ----------------------------------------------------
  const read = await withOrg(ctx.organizationId, async (tx) => {
    // The account's stop, or an install that handed it off, writes nothing, as
    // a fresh draft does not: the asks wait, untouched.
    const [safety] = await tx.select().from(systemState);
    if (safety?.killSwitch || safety?.transferPaused || safety?.cloudPaused) return null;
    const [campaign] = await tx.select().from(campaigns).where(eq(campaigns.id, campaignId));
    if (!campaign) return null;
    // Nor does a Stop on the campaign or its account: an ask filed before it
    // waits for the Resume, and the Ambassador's next run after it picks the
    // ask up.
    if ((await campaignStops(tx, campaign)).length > 0) return null;
    const asks: Ask[] = [];
    const contexts = new Map<number, CommentDraftingContext>();
    const asked = await tx.select().from(messages).where(askedToRedo(campaignId)).orderBy(asc(messages.id));
    for (const message of asked) {
      const [post] = await tx
        .select()
        .from(discoveredPosts)
        .where(eq(discoveredPosts.id, message.discoveredPostId!));
      const context = post
        ? await getCommentDraftingContext(tx, campaign, { discoveredPostId: post.id, llm: null })
        : null;
      const request: DurableDraftRequest = {
        target: "message",
        targetId: message.id,
        requestId: message.redraftRequestId!,
        requestVersion: message.redraftRequestVersion,
        status: message.status,
      };
      if (!post || post.campaignId !== campaignId || !context?.ok) {
        const reason = context?.ok === false ? context.error : post ? "its post is on another campaign" : "its post is gone";
        if (await leaveAsked(tx, { message, request }, reason)) out.notWritten.push(message.id);
        continue;
      }
      contexts.set(post.id, context.data);
      asks.push({ message, request, post, evidence: draftEvidence(post, context.data) });
    }
    const snapshot = asks.length === 0 ? null : await readDispatchInputs(tx, campaign, asks.map((ask) => ask.post), contexts, now);
    return { campaign, asks, snapshot };
  });
  if (!read?.snapshot) return out;

  // ---- model calls, NO connection held --------------------------------------
  const { snapshot } = read;
  const compiled = await compiledRulesAtHand(ctx.organizationId, ctx.llm, {
    campaignId,
    channel: "comment",
    voiceRules: snapshot.voiceRules,
    campaignRules: snapshot.campaignRules,
  }).catch(() => null);
  const dispatched = compiled
    ? await dispatchPosts(ctx.llm, snapshot, new Map(read.asks.map((ask) => [ask.post.id, ask.evidence])), now, {
        compiled,
        ownerRequested: true,
        asks: new Map(read.asks.map((ask) => [ask.post.id, { note: ask.message.redraftRequestNote, replacing: ask.message.proposedText }])),
        ...(opts.continueRun ? { continueRun: opts.continueRun } : {}),
      }).catch((error: unknown) => `the model call failed: ${error instanceof Error ? error.message : String(error)}`)
    : "the writing rules could not be compiled";
  // A stopped run keeps nothing, and the asks stay as they were.
  if (typeof dispatched === "object" && dispatched.outcome === null) return out;

  // ---- apply (short tx) -----------------------------------------------------
  const landed = await withOrg(ctx.organizationId, (tx) =>
    complete(tx, read.campaign, read.asks, dispatched, compiled?.revision ?? "", { runId: ctx.runId ?? null }, out),
  );
  // The words wait for the owner's yes, and the yes waits for the model's
  // judge of them: kept on the attempts before this pass ends.
  await judgeLanded(ctx.organizationId, ctx.llm, landed);
  return out;
}

/** What the dispatcher made of each ask's post: its new comment, or why it
 *  has none, in the owner's words. */
function rewritten(
  asks: readonly Ask[],
  { plans, unplanned, outcome }: { plans: Map<number, DraftPlan>; unplanned: Map<number, string>; outcome: DispatchOutcome },
  planIds: ReadonlyMap<number, number>,
): Map<Ask, Rewrite | string> {
  const results = new Map<Ask, Rewrite | string>();
  for (const ask of asks) {
    const id = ask.post.id;
    const draft = outcome.admitted.find((one) => one.id === id);
    const kept = outcome.withheld.find((one) => one.id === id);
    const missing = unplanned.get(id);
    results.set(
      ask,
      draft
        ? { text: draft.attempts.at(-1)!.text, plan: draft.plan, planId: planIds.get(id) ?? null }
        : kept
          ? withheldReason(kept)
          : missing
            ? `the dispatcher could not plan it (${missing})`
            : plans.has(id)
              ? "the writer returned no draft"
              : "the dispatcher planned nothing for it",
    );
  }
  return results;
}

/** Why a comment the dispatcher judged was not kept, as the run note says it
 *  for a whole batch. */
const withheldReason = (draft: DispatchedDraft & { miss: DispatchOutcome["withheld"][number]["miss"] }) =>
  dispatchedWithheldNote({ admitted: [], withheld: [draft], unwritten: [] }, new Map(), ["comment", "comments"]);

/** Complete each ask whose rewrite came back, and leave the rest asked for,
 *  each with its reason. `dispatched` is one reason for the whole pass where
 *  its model calls failed. What landed comes back for the model's judge. */
async function complete(
  tx: Tx,
  campaign: Campaign,
  asks: Ask[],
  dispatched: DispatchedPosts | string,
  rulesRevision: string,
  at: { runId: number | null },
  out: CommentRedraft,
): Promise<Landed[]> {
  await lockEngagementSafety(tx);
  await lockPauses(tx);
  await lockRoomEvidence(tx);
  const [currentCampaign] = await tx.select().from(campaigns).where(eq(campaigns.id, campaign.id));
  const reasons = new Map<Ask, string>();
  const ready: Array<{ ask: Ask; draft: Rewrite }> = [];
  let results: Map<Ask, Rewrite | string>;
  let landed: Landed[] = [];
  if (typeof dispatched === "string") {
    results = new Map(asks.map((ask) => [ask, dispatched]));
  } else {
    const outcome = dispatched.outcome!;
    // Keep every attempt under the plan it was written from, so a withheld
    // comment shows the item it missed.
    const planIds = await savePlans(tx, { campaignId: campaign.id, runId: at.runId }, dispatched.plans);
    await saveAttempts(tx, planIds, [...outcome.admitted, ...outcome.withheld]);
    results = rewritten(asks, { ...dispatched, outcome }, planIds);
    landed = outcome.admitted.map((draft) => ({
      planId: planIds.get(draft.id)!,
      draft,
      evidence: asks.find((ask) => ask.post.id === draft.id)!.evidence,
    }));
  }
  const current = currentCampaign ? await currentRulesRevision(tx, currentCampaign) : null;
  for (const ask of asks) {
    const draft = results.get(ask)!;
    if (typeof draft === "string") {
      reasons.set(ask, draft);
    } else if (contextHash(ask.evidence.room ?? null) !== contextHash(await readRoomForDrafting(tx, ask.post.id))) {
      reasons.set(ask, "The room changed while drafting; request another version from its current evidence.");
    } else if (current !== rulesRevision) {
      reasons.set(ask, "Writing instructions changed while drafting; request another version with the current guidance.");
    } else ready.push({ ask, draft });
  }
  if (ready.length > 0) {
    const intake = await submitCommentDraftBatch(
      tx,
      campaign,
      {
        drafts: ready.map(({ ask, draft }) => ({
          discoveredPostId: ask.post.id,
          text: draft.text,
          rationale: draft.plan.point.why,
          ownerStoryId: draft.plan.story?.id ?? null,
        })),
        model: modelFor("writer"),
      },
      {
        forceProposal: true,
        ownerRequested: true,
        worker: { workerAuthored: true, publish: false, runId: at.runId },
        durableRequests: new Map(ready.map(({ ask }) => [ask.post.id, ask.request])),
      },
    );
    // An ask that moved since it was read fails the swap here and again in
    // `leaveAsked`, so the row stays as the owner left it; so does one another
    // completion of the same ask reached first.
    for (const { ask, draft } of ready) {
      const item = intake.ok
        ? intake.data.items.find((entry) => entry.discoveredPostId === ask.post.id)
        : undefined;
      if (item && "redrafted" in item && item.redrafted && !item.alreadyExisted) {
        // The plan travels with the words it wrote.
        if (draft.planId !== null) {
          await tx.update(messages).set({ draftPlanId: draft.planId }).where(eq(messages.id, ask.message.id));
        }
        out.redrafted.push(ask.message.id);
        trackDraftDelivered(
          { kind: "redraft", outcome: "ok", durationMs: Date.now() - (ask.message.redraftRequestedAt ?? Date.now()) },
          tx,
        );
      } else if (!intake.ok) {
        reasons.set(ask, intake.error);
      } else if (item && "error" in item) {
        reasons.set(ask, item.error);
      }
    }
  }
  for (const [ask, reason] of reasons) {
    if (await leaveAsked(tx, ask, reason)) {
      out.notWritten.push(ask.message.id);
      trackDraftDelivered(
        { kind: "redraft", outcome: "failed", durationMs: Date.now() - (ask.message.redraftRequestedAt ?? Date.now()) },
        tx,
      );
    }
  }
  return landed;
}

/** The ask stays open, with why its rewrite came to nothing on the row the
 *  owner reads it from — unless it moved since it was read. */
async function leaveAsked(
  tx: Tx,
  ask: Pick<Ask, "message" | "request">,
  reason: string,
): Promise<boolean> {
  const [left] = await tx
    .update(messages)
    .set({ error: `${NOT_WRITTEN}: ${reason}` })
    .where(
      and(
        eq(messages.id, ask.message.id),
        eq(messages.status, "proposed"),
        eq(messages.redraftRequestId, ask.request.requestId),
        eq(messages.redraftRequestVersion, ask.request.requestVersion),
      ),
    )
    .returning({ id: messages.id });
  return left !== undefined;
}

/** What a pass did, said on the run that made it; null where it did nothing. */
export function commentRedraftNote(done: CommentRedraft): string | null {
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const said = [
    done.redrafted.length > 0
      ? `redrafted ${count(done.redrafted.length, "comment", "comments")} you asked to redo`
      : null,
    done.notWritten.length > 0
      ? `${count(done.notWritten.length, "redraft", "redrafts")} you asked for not written, the reason on each`
      : null,
  ].filter((part): part is string => part !== null);
  return said.length > 0 ? said.join("; ") : null;
}
