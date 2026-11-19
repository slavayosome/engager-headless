import { eq } from "drizzle-orm";
import { campaigns, type Campaign } from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import type { LLM } from "../ai/client";
import type { KnowledgeRetrievalSnapshot } from "../brain/knowledge";
import type { WritingStep } from "../ai/writingInstructions";
import { readWritingStep } from "../strategy/writingInstructions";
import { getGuidance } from "../learning/guidance";
import { recentAgentDrafts } from "../draft";
import type { Rationing } from "../learning/styleVariety";
import { sentTexts } from "../operations/sentTexts";
import { loadCampaignProductContext } from "../products/queries";
import { productEvidenceFacts, type DraftEvidence } from "../workers/evidenceReview";
import type { CommentDraftingContext } from "../workers/phases";
import { budgetFor } from "./budgets";
import { campaignRulesFor } from "./campaignRules";
import { compiledRulesFor, compileRules, writingRulesRevision, type CompiledWritingRules } from "./compile";
import { planOrCompose } from "./compose";
import { draftFromPlans, type DispatchItem, type DispatchOutcome, type DraftAttempt } from "./draftFromPlans";
import { planningInputsFor, type PlannedPost, type PlanningFacts } from "./planner";
import { conversationId, VOICE_CHANNELS, type CampaignRule, type DraftPlan, type DraftSurface, type OwnerAsk, type VoiceRule } from "./types";
import { voiceRulesForCampaign } from "./voiceRules";
import { renderPlan, type WriterVoice } from "./writer";

/**
 * What the draft dispatcher reads for a campaign's drafts (spec "Draft
 * Dispatcher" v0.3), and previews a post's dispatch from. The openers a run
 * writes plan, write and judge in `leads/scout/openerDrafts.ts`.
 */

export type DispatchSnapshot = {
  voiceRules: VoiceRule[];
  campaignRules: CampaignRule[];
  recentDrafts: string[];
  rationing: Rationing;
  facts: PlanningFacts;
  /** What the campaign's objective — in lead mode, the author's intent — lets
   *  a comment on each post carry. */
  gates: Map<number, CommentDraftingContext["gate"]>;
  sent: string[];
  productNames: string[];
  /** How the owner describes their writing, for the writer's texture. */
  voice: WriterVoice;
};

/** The rules a draft on this campaign is planned by, as they stand: the
 *  comment step's, or the step of the surface it is written on — a room
 *  reply, a note, a reply, a DM. `step` is the step a caller already holds,
 *  in place of the one the saved strategy names for the surface. */
export async function rulesInputs(
  tx: Tx,
  campaign: Pick<Campaign, "id" | "voiceId" | "objective" | "prompts" | "tone">,
  surface: DraftSurface = "comment",
  knowledge?: KnowledgeRetrievalSnapshot,
  step?: WritingStep | null,
) {
  const voice = await voiceRulesForCampaign(tx, campaign, knowledge);
  const writing = step === undefined ? await readWritingStep(tx, campaign.id, surface === "followup" ? "dm" : surface) : step;
  return { voiceRules: voice.rules, campaignRules: campaignRulesFor(campaign, writing, await getGuidance(tx, campaign.id), surface) };
}

/** What the dispatcher reads for these posts: the phase's snapshot, and the
 *  preview's. `contexts` are the drafting contexts the caller already read. */
export async function readDispatchInputs(
  tx: Tx,
  campaign: Campaign,
  posts: readonly PlannedPost[],
  contexts: ReadonlyMap<number, CommentDraftingContext>,
  now: number,
  products?: Awaited<ReturnType<typeof loadCampaignProductContext>>,
): Promise<DispatchSnapshot> {
  const [first] = contexts.values();
  const facts = await planningInputsFor(tx, campaign, posts, now);
  for (const item of facts.items) {
    const context = contexts.get(conversationId(item.conversation));
    if (context) item.ownerFacts = [context.brain.knowledge, ...productEvidenceFacts(context.products)].filter((fact): fact is string => !!fact);
  }
  return {
    ...(await rulesInputs(tx, campaign)),
    recentDrafts: await recentAgentDrafts(tx, campaign.id),
    rationing: first?.voice.styleRules.knobs?.rationing ?? "strict",
    facts,
    gates: new Map([...contexts].map(([id, context]) => [id, context.gate])),
    sent: (await sentTexts(tx, now)).map((row) => row.text),
    productNames: (products ?? await loadCampaignProductContext(tx, campaign.id)).map((product) => product.name),
    voice: { persona: first?.voice.persona ?? null, houseStyle: first?.voice.houseStyle ?? null },
  };
}

/**
 * Compile a campaign's writing rules where they changed, before its next draft
 * needs them: one compile per channel, from the step that writes on it —
 * Comment, Reply, DM. A draft the owner waits on reads the newest compile of
 * its channel while its own revision compiles (`compiledRulesAtHand`).
 */
export async function warmCompiledRules(organizationId: string, llm: LLM, campaignId: number): Promise<void> {
  const inputs = await withOrg(organizationId, async (tx) => {
    const [campaign] = await tx.select().from(campaigns).where(eq(campaigns.id, campaignId));
    if (!campaign) return [];
    const each = [];
    for (const channel of VOICE_CHANNELS) each.push({ campaignId, channel, ...(await rulesInputs(tx, campaign, channel)) });
    return each;
  });
  for (const input of inputs) await compiledRulesFor(organizationId, llm, input);
}

/** The revision the campaign's rules compile to now, for the apply phase to
 *  compare with the one the drafts were planned from. */
export async function currentRulesRevision(tx: Tx, campaign: Campaign, knowledge?: KnowledgeRetrievalSnapshot): Promise<string> {
  return writingRulesRevision({ channel: "comment", ...(await rulesInputs(tx, campaign, "comment", knowledge)) });
}

/** A plan held to what the campaign's objective lets a comment carry — in
 *  lead mode, the person's intent (`intentGate`): the compile says when a
 *  product may come up, the gate whether one may at all. */
export function withinGate(plan: DraftPlan, gate: CommentDraftingContext["gate"] | undefined): DraftPlan {
  const product = !!gate?.canMentionProduct;
  return {
    ...plan,
    content: {
      product: plan.content.product && product,
      pitch: plan.content.pitch && product,
      link: plan.content.link && !!gate?.allowCta,
    },
  };
}

/** What the dispatcher would make of one post: its plan, or why it has none,
 *  and every text written from the plan with what the judge said of it. */
export type DispatchPreview = {
  plan: DraftPlan | null;
  /** The plan as the writer follows it, line by line. */
  planLines: string | null;
  unplanned: string | null;
  attempts: DraftAttempt[];
  outcome: "admitted" | "withheld" | "unwritten" | "unplanned";
};

/** The dispatcher's plans and drafts for these posts, with nothing kept. */
export type DispatchedPosts = {
  plans: Map<number, DraftPlan>;
  unplanned: Map<number, string>;
  /** Null where the run stopped before its drafts were judged. */
  outcome: DispatchOutcome | null;
};

/**
 * Plan, write and judge a comment on each post of the snapshot named in
 * `evidence`, under rules the caller compiled: the same calls the phase
 * makes, in one place for a preview, a redraft and a chat turn to share.
 * `asks` are the owner's own words about a post, a plan input and the
 * writer's. Comments the owner asked for are planned and written in one call
 * and judged by code (`compose.ts`): the caller keeps them and hands what
 * landed to the model's judge (`judgeLanded`).
 */
export async function dispatchPosts(
  llm: LLM,
  snap: DispatchSnapshot,
  evidence: ReadonlyMap<number, DraftEvidence>,
  now: number,
  opts: {
    compiled: CompiledWritingRules & { revision: string };
    asks?: ReadonlyMap<number, OwnerAsk>;
    /** Stop at the plans: nothing is written or judged. */
    planOnly?: boolean;
    /** The owner asked for these comments: only a fact blocks them. */
    ownerRequested?: boolean;
    continueRun?: () => Promise<boolean>;
  },
): Promise<DispatchedPosts> {
  const { rules, revision } = opts.compiled;
  const items = snap.facts.items
    .filter((item) => evidence.has(conversationId(item.conversation)))
    .map((item) => {
      const ask = opts.asks?.get(conversationId(item.conversation));
      return ask ? { ...item, ask } : item;
    });
  const input = {
    ...snap.facts,
    items,
    rules,
    rulesRevision: revision,
    budget: budgetFor(rules, snap.recentDrafts, items.length, snap.rationing),
  };
  const planned = await planOrCompose(llm, input, opts.ownerRequested && !opts.planOnly ? { now, voice: snap.voice } : null);
  const plans = new Map([...planned.plans].map(([id, plan]) => [id, withinGate(plan, snap.gates.get(id))] as const));
  const work: DispatchItem[] = items.flatMap((item) => {
    const id = conversationId(item.conversation);
    const plan = plans.get(id);
    return plan ? [{ plan, conversation: item.conversation, evidence: evidence.get(id)!, ...(item.ask ? { ask: item.ask } : {}) }] : [];
  });
  const outcome = opts.planOnly
    ? { admitted: [], withheld: [], unwritten: [] }
    : await draftFromPlans(
        llm,
        work,
        { sent: snap.sent, stories: snap.facts.stories, productNames: snap.productNames },
        {
          now,
          voice: snap.voice,
          ownerRequested: opts.ownerRequested === true,
          ...(planned.texts ? { composed: planned.texts } : {}),
          ...(opts.continueRun ? { continueRun: opts.continueRun } : {}),
        },
      );
  return { plans, unplanned: planned.unplanned, outcome };
}

/**
 * The dispatcher's path for one post with nothing kept: the rules compiled
 * without storing the compile, the plan never saved, no attempt written. The
 * same calls the phase makes, so a preview shows what a run would do.
 */
export async function previewDispatch(
  llm: LLM,
  snap: DispatchSnapshot,
  post: { id: number },
  evidence: DraftEvidence,
  now: number,
  /** Rules already compiled for this preview, reused where their revision
   *  matches this snapshot's inputs so candidates compile once between them. */
  precompiled?: CompiledWritingRules & { revision: string },
): Promise<DispatchPreview> {
  const input = { channel: "comment" as const, voiceRules: snap.voiceRules, campaignRules: snap.campaignRules };
  const compiled = precompiled && precompiled.revision === writingRulesRevision(input)
    ? precompiled
    : { ...(await compileRules(llm, input)), revision: writingRulesRevision(input) };
  const { plans, unplanned, outcome } = await dispatchPosts(llm, snap, new Map([[post.id, evidence]]), now, { compiled });
  const plan = plans.get(post.id) ?? null;
  if (!plan) {
    return { plan: null, planLines: null, unplanned: unplanned.get(post.id) ?? "the planner returned no plan for this post", attempts: [], outcome: "unplanned" };
  }
  const drafted = [...(outcome?.admitted ?? []), ...(outcome?.withheld ?? [])][0];
  return {
    plan,
    planLines: renderPlan(plan),
    unplanned: null,
    attempts: drafted?.attempts ?? [],
    outcome: outcome?.admitted.length ? "admitted" : outcome?.withheld.length ? "withheld" : "unwritten",
  };
}
