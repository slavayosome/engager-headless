import { AppError } from "@engager/common/errors";
import type { Campaign } from "@engager/database/schema";
import { withOrg } from "@engager/database/tenant";
import type { LLM } from "../ai/client";
import { INVITATION_NOTE_TARGET_CHARS, type ProductContext } from "../ai/writer";
import type { WritingStep } from "../ai/writingInstructions";
import { finalizeBrainForWriter, prepareBrainForWriter, recentAgentDrafts, type BrainWriterPreparation } from "../draft";
import { DEFAULT_DRAFTING_KNOBS } from "../learning/styleVariety";
import { sentTexts } from "../operations/sentTexts";
import { getProfile } from "../profile";
import { readWritingStep, resolveSavedWritingVoice } from "../strategy/writingInstructions";
import { productEvidenceFacts, type DraftEvidence } from "../workers/evidenceReview";
import { budgetFor } from "./budgets";
import { compileRules, compiledRulesAtHand, compiledRulesFor, writingRulesRevision } from "./compile";
import { planOrCompose } from "./compose";
import { dispatchedWithheldNote, draftFromPlans, saveAttempts, type DraftAttempt } from "./draftFromPlans";
import { judgeLanded } from "./landedJudge";
import type { PlanningItem } from "./planCheck";
import { rulesInputs } from "./phase";
import { ownerPlanningFacts, savePlans } from "./planner";
import {
  conversationText,
  type DraftConversation,
  type DraftPlan,
  type DraftSurface,
  type OwnerAsk,
  type VoiceChannel,
} from "./types";
import { WRITE_FROM_PLAN_SYSTEM } from "./writer";

/**
 * WORDS TO A PERSON, written by the dispatcher (spec "Draft Dispatcher" v0.3):
 * a public reply under the owner's comment or post, a DM, a follow-up, the
 * note of a connection invitation, a reply in a room. Each is planned for the
 * conversation it speaks into, written from the plan and judged against it,
 * through the same planner, writer and judge a comment takes, so the owner's
 * voice is judged one way on every surface and no second checker re-reads the
 * writer's prompt.
 *
 * The caller owns what the words are for: which row they answer, which step's
 * instructions rule them, what a claim may rest on. Nothing here saves, queues
 * or sends; what comes back is the admitted text, for the caller's mode to
 * place. The exchange and the person's words reach every prompt fenced as
 * untrusted data. Where the owner asked for the words (`ownerRequested`) only
 * a claim the evidence does not support holds them back; any other miss goes
 * on as a note. Under a campaign they are planned and written in one call and
 * judged by code (`compose.ts`), and the model's judge reads them after they
 * land (`landedJudge.ts`): a press of them untouched waits for it.
 */

export type SpokenSurface = Exclude<DraftSurface, "comment" | "angle">;

/** The voice channel each surface is written in: a note and a follow-up are
 *  DMs' voice, a reply in a room the reply voice. */
const CHANNELS: Record<SpokenSurface, VoiceChannel> = {
  reply: "reply",
  room_reply: "reply",
  dm: "dm",
  followup: "dm",
  invitation: "dm",
};

/** The surfaces whose step says what a message does, where a comment's moves
 *  only say how it joins in: a connection note, a DM and a follow-up. */
const STEP_LED: ReadonlySet<SpokenSurface> = new Set(["invitation", "dm", "followup"]);

/** What words with no campaign behind them are written under: the owner's
 *  voice and Brain alone, with no step, guidance or tone of a campaign's. */
const NO_CAMPAIGN: Pick<Campaign, "id" | "voiceId" | "objective" | "prompts" | "tone" | "compiledBrief"> = {
  id: 0,
  voiceId: null,
  objective: "visibility",
  prompts: null,
  tone: null,
  compiledBrief: null,
};

export type ConversationWordsInput = {
  organizationId: string;
  /** The campaign whose voice, steps and rules rule the words; null for a
   *  lead whose campaign is gone, written under the owner's voice alone. */
  campaign: Campaign | null;
  llm: LLM;
  surface: SpokenSurface;
  /** Their words, and the exchange before them. */
  conversation: Pick<DraftConversation, "post" | "turns">;
  /** The Brain as the caller read it, else read here; queried by `query`. */
  brain?: BrainWriterPreparation;
  query: string;
  /** The campaign's attached products: facts a claim may rest on. */
  products: readonly ProductContext[];
  /** Further facts a claim may rest on: a step's bound facts, an approved
   *  offer's words. */
  facts?: readonly string[];
  /** The step whose instructions rule the words, else the saved strategy's
   *  step for the surface. */
  step?: WritingStep | null;
  /** The row the words answer, which names their saved plan (`draft:<id>`). */
  draftKey?: number;
  /** Who they are, as their profile says. */
  headline?: string | null;
  /** The room the words are said in, for the judge to read claims against. */
  room?: DraftEvidence["room"];
  /** Instructions of the caller's own, at the step's authority: the last reply
   *  of a thread closes it, an approved offer is made in its words. */
  rules?: readonly string[];
  /** Nothing has passed between the owner and this person yet. */
  firstTouch: boolean;
  /** The most characters the words may take, where their surface has a hard
   *  limit: a connection invitation's note. */
  maxChars?: number;
  /** The words make an approved offer: a product, a link and a pitch may
   *  come up in them. */
  offer?: boolean;
  /** The owner's own words about these words. */
  ask?: OwnerAsk;
  /** The owner asked for them: only a fact blocks. */
  ownerRequested?: boolean;
  /** Stop at the plan: nothing is written or judged. */
  planOnly?: boolean;
  /** Asked before each model call; false stops the work. */
  continueRun?: () => Promise<boolean>;
};

/** The id a batch of one knows its words by, where the caller names no row. */
const KEY = 1;

export type ConversationWords = {
  text: string;
  /** The first miss, in the owner's words, where the judge noted one and let
   *  the words go on. */
  note: string | null;
  plan: DraftPlan;
  attempts: DraftAttempt[];
  /** The plan saved before a word was written, and kept with every attempt;
   *  null for an ask that stopped at the plan. */
  planId: number | null;
  /** The brief the Brain's facts were read under, for the row to carry. */
  brief: { sourceHash: string | null; anchorIds: number[] | null };
  /** The writer's system prompt, which the draft is recorded against. */
  promptTemplate: string;
};

/**
 * Plan, write and judge the words to one person. Null where the run stopped
 * before they were judged. A draft the judge withholds throws
 * `draft_withheld` with why, in the owner's words; a provider or schema
 * failure throws, so nothing unjudged moves on.
 */
export async function writeConversationWords(input: ConversationWordsInput & { planOnly: true }): Promise<Pick<ConversationWords, "plan"> | null>;
export async function writeConversationWords(input: ConversationWordsInput): Promise<ConversationWords | null>;
export async function writeConversationWords(input: ConversationWordsInput): Promise<ConversationWords | Pick<ConversationWords, "plan"> | null> {
  const { organizationId, llm, surface } = input;
  const campaign = input.campaign ?? NO_CAMPAIGN;
  const channel = CHANNELS[surface];
  const key = input.draftKey ?? KEY;
  const now = Date.now();
  const go = async () => !input.continueRun || (await input.continueRun());

  const read = await withOrg(organizationId, async (tx) => {
    const voice = await resolveSavedWritingVoice(tx, campaign, await getProfile(tx), channel);
    const brain = input.brain ?? (await prepareBrainForWriter(tx, campaign));
    const step = input.step === undefined ? await readWritingStep(tx, campaign.id, surface === "followup" ? "dm" : surface) : input.step;
    return {
      brain,
      step: step ?? null,
      ...(await rulesInputs(tx, campaign, surface, brain.knowledge, step ?? null)),
      recentDrafts: await recentAgentDrafts(tx, campaign.id),
      owner: await ownerPlanningFacts(tx, campaign, now, brain.knowledge, channel),
      sent: (await sentTexts(tx, now)).map((row) => row.text),
      voice: { persona: voice.persona, houseStyle: voice.houseStyle },
      rationing: { ...DEFAULT_DRAFTING_KNOBS, ...voice.styleRules.knobs }.rationing,
    };
  });
  const compileInput = {
    channel,
    voiceRules: read.voiceRules,
    campaignRules: [
      ...read.campaignRules,
      ...(input.rules ?? []).map((text, n) => ({ id: `campaign.step.extra.${n}`, source: "step" as const, text })),
    ],
  };
  // No campaign, no stored compile: the rules are compiled for this draft
  // alone. Words the owner waits on take the compile at hand.
  const compiled = input.campaign
    ? await (input.ownerRequested ? compiledRulesAtHand : compiledRulesFor)(organizationId, llm, { ...compileInput, campaignId: campaign.id })
    : { ...(await compileRules(llm, compileInput)), revision: writingRulesRevision(compileInput) };
  if (!(await go())) return null;

  const brain = await finalizeBrainForWriter(read.brain, { queryText: input.query, llm: null });
  const conversation: DraftConversation = { surface, draftKey: key, ...input.conversation };
  const productFacts = [...productEvidenceFacts(input.products), ...(input.facts ?? [])];
  const evidence: DraftEvidence = {
    post: conversationText(conversation),
    postedAt: conversation.post.postedAt,
    authorName: conversation.post.authorName,
    authorHeadline: input.headline ?? null,
    knowledge: brain.knowledge || null,
    constraints: brain.constraints ?? null,
    productFacts,
    ...(input.room ? { room: input.room } : {}),
    // A note or a DM follows what passed between them: that exchange is their
    // history, which a claim about what they said cites.
    ...(STEP_LED.has(surface) ? { history: [conversationText(conversation)] } : {}),
  };
  // A connection invitation's note never runs past the 300 characters it may carry.
  const maxChars = surface === "invitation" ? Math.min(input.maxChars ?? INVITATION_NOTE_TARGET_CHARS, INVITATION_NOTE_TARGET_CHARS) : input.maxChars;
  const item: PlanningItem = {
    conversation,
    ownerFacts: [evidence.knowledge, ...productFacts].filter((fact): fact is string => !!fact),
    research: null,
    authorHeadline: evidence.authorHeadline ?? null,
    firstTouch: input.firstTouch,
    ...(STEP_LED.has(surface) && read.step?.instructions.trim() ? { step: read.step.instructions.trim() } : {}),
    ...(maxChars === undefined ? {} : { maxChars }),
    ...(input.ask ? { ask: input.ask } : {}),
  };
  const planning = {
    ...read.owner,
    items: [item],
    rules: compiled.rules,
    rulesRevision: compiled.revision,
    budget: budgetFor(compiled.rules, read.recentDrafts, 1, read.rationing),
  };
  // Words the owner waits on are planned and written in one call, where their
  // attempt can be kept for the model's judge to read after they land: under
  // a campaign. With none, they take the full chain.
  const planned = await planOrCompose(llm, planning, input.ownerRequested && input.campaign && !input.planOnly ? { now, voice: read.voice } : null);
  const plan = planned.plans.get(key);
  if (!plan) {
    throw new AppError("draft_withheld", `the dispatcher could not plan these words (${planned.unplanned.get(key) ?? "no plan came back"})`, 409);
  }
  // What may come up in the words is the plan's, held to what there is to
  // name: no product where none is attached, and an approved offer's own.
  const held: DraftPlan = {
    ...plan,
    content: input.offer
      ? { product: true, link: true, pitch: true }
      : { ...plan.content, product: plan.content.product && input.products.length > 0 },
  };
  if (input.planOnly) return { plan: held };
  // Saved before a word is written from it, and every attempt after it is judged.
  const planIds = input.campaign
    ? await withOrg(organizationId, (tx) => savePlans(tx, { campaignId: campaign.id, runId: null }, new Map([[key, held]])))
    : new Map<number, number>();
  const outcome = await draftFromPlans(
    llm,
    [{ plan: held, conversation, evidence, ...(input.ask ? { ask: input.ask } : {}) }],
    { sent: read.sent, stories: read.owner.stories, productNames: input.products.map((product) => product.name) },
    {
      now,
      voice: read.voice,
      ownerRequested: input.ownerRequested === true,
      ...(planned.texts ? { composed: planned.texts } : {}),
      ...(input.continueRun ? { continueRun: input.continueRun } : {}),
    },
  );
  if (outcome === null) return null;
  if (planIds.size > 0) await withOrg(organizationId, (tx) => saveAttempts(tx, planIds, [...outcome.admitted, ...outcome.withheld]));
  if (planned.texts) void judgeLanded(organizationId, llm, outcome.admitted.map((draft) => ({ planId: planIds.get(key)!, draft, evidence })));
  const admitted = outcome.admitted[0];
  if (!admitted) {
    throw new AppError("draft_withheld", dispatchedWithheldNote(outcome, new Map(), ["draft", "drafts"]), 409);
  }
  const last = admitted.attempts.at(-1)!;
  return {
    text: last.text,
    note: last.reason,
    plan: held,
    planId: planIds.get(key) ?? null,
    attempts: admitted.attempts,
    brief: { sourceHash: brain.briefSourceHash, anchorIds: brain.briefAnchorIds },
    promptTemplate: WRITE_FROM_PLAN_SYSTEM,
  };
}
