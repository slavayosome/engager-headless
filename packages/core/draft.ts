import { readWritingStep, resolveSavedWritingVoice } from "./strategy/writingInstructions";
import { writingStepRevision, type WritingStep } from "./ai/writingInstructions";
import { and, desc, eq, gt, gte, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import {
  campaignGuidance,
  discoveredPosts,
  incomingComments,
  messages,
  type BetBreakdownJson,
  type Campaign,
  type DiscoveredPost,
  type DraftingKnobs,
  type DraftTrace,
  type IncomingComment,
  type Message,
  type Profile,
  type ResolvedStyleRules,
  type StyleDirectives,
  type StyleStructuralRange,
  type VoiceTraits,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import {
  effectivePromoRatio,
  mayMentionProduct,
  mayUseCta,
} from "./campaigns/objectives";
import { draftIntentGate, productsWithin, type IntentGate } from "./campaigns/intentGate";
import { loadCampaignProductContext, type ProductContextOptions } from "./products/queries";
import type { LLM } from "./ai/client";
import { runFilter, type FilterResult } from "./ai/filter";
import { decideCommentType, decideWebFacts } from "./ai/promoSampler";
import { shapeExclusionFor } from "./ai/promptDefaults";
import {
  authorImpactScore,
  computeBetScore,
  scoreMeaningfulness,
  SCOUT_BET_FLOOR,
  type BetBreakdown,
  type ComputeBetScoreOpts,
} from "./ai/rank";
import { recordRankMetric } from "./ai/rankMetrics";
import { rationedHabits } from "./ai/voiceTraits";
import {
  decideLengthTier,
  recentLengthTiers,
  type LengthDecision,
} from "./ai/lengthSampler";
import { decideSlopStrictness, type StrictnessDecision } from "./ai/slop";
import { assembleReplyContext, type ReplyThreadContext } from "./replyContext";
import {
  renderReplyPrompt,
  writeComment,
  type Exemplar,
  type ProductContext,
  type RenderedReplyPrompt,
  type ReplyWriterOptions,
} from "./ai/writer";
import {
  checkDiversity,
  checkDiversityFromSnapshot,
  prepareDiversitySnapshot,
  type DiversityResult,
  type DiversitySnapshot,
} from "./learning/diversity";
import {
  prepareExemplarRetrieval,
  retrieveExemplars,
  retrieveExemplarsFromSnapshot,
  type ExemplarRetrievalSnapshot,
} from "./learning/retrieval";
import {
  blendRanges,
  endsWithQuestion,
  examplesForDraft,
  heldHabits,
  heldSignatures,
  inferOpeningType,
  pickStyleDirectives,
  SIGNATURE_WINDOW,
  type PickedDirectives,
  type Rationing,
} from "./learning/styleVariety";
import {
  prepareKnowledgeRetrieval,
  retrieveKnowledgeFromSnapshot,
  type KnowledgeRetrievalSnapshot,
  type RetrievedKnowledge,
} from "./brain/knowledge";
import { rerankKnowledgeForComment } from "./brain/rerank";
import { getProfile } from "./profile";
import { type ResolvedVoiceV2 } from "./voice";
import { config, envInt } from "./config";
import {
  campaignLedgerScope,
  channelCeilings,
  countSince,
  remainingCommentBudget,
} from "./ratelimit/ledger";

/** Context the draft builders need; structurally satisfied by HandlerCtx and McpCtx. */
export type DraftCtx = { db: Tx; llm?: LLM | null };

const WEEK_MS = 7 * 86_400_000;

/** Writer-facing Brain knowledge cap (was the retrieveKnowledge default of 4). The
 *  retrieval is pure cosine with no rerank, so a tighter base slice keeps off-topic
 *  rows out of the prompt; `avoid` constraints + the preferred-slot quota are added
 *  on top of this and are unaffected. */
const WRITER_KNOWLEDGE_K = 2;

/** Candidate pool the fact reranker chooses from (config.factRerank). Wider than the
 *  final slice so the Haiku rerank has real choice; the `avoid` hard-includes + the
 *  preferred-slot quota are still added on top by retrieveKnowledge. */
const RERANK_CANDIDATES = 8;

/** Drafts admitted per day = budget × OVERPROVISION (the posting ledger ≠ the draft
 *  budget; the slack is absorbed here and tuned empirically via the held-count). */
const OVERPROVISION = (() => {
  const n = envInt("ENGAGER_LEAD_RANKER_OVERPROVISION", 0);
  // envInt preserves an explicit 0; treat <=0 / unset as the 1.5 default.
  return n > 0 ? n : 1.5;
})();

/**
 * Build a short "who this product is for" text for the BetScore ICP signal from the
 * loaded product context (name + one-liner + facts). A loose proxy for the audience
 * facet — bounded, gameable, never the sole driver — that drops gracefully to null
 * when no product is attached.
 */
function audienceTextFromProducts(products: ProductContext[]): string | null {
  const t = products
    .map((p) =>
      [p.name, p.oneLiner ?? "", p.facts.join(". ")].filter(Boolean).join(". "),
    )
    .join(" ")
    .trim();
  return t.length > 0 ? t : null;
}

/**
 * Map slot-typed retrieved knowledge into the writer's blocks: `avoid` rows become
 * hard `constraints`; positions/stories/other become labeled `knowledge` (keeps
 * `r.slot` instead of flattening everything into one bucket).
 */
function formatKnowledgeForWriter(rows: RetrievedKnowledge[]): {
  constraints: string;
  knowledge: string;
} {
  const bul = (rs: RetrievedKnowledge[]) =>
    rs.map((r) => `- ${r.content}`).join("\n");
  const blocks: string[] = [];
  const positions = rows.filter((r) => r.slot === "positions");
  const stories = rows.filter((r) => r.slot === "stories");
  const other = rows.filter(
    (r) => r.slot !== "avoid" && r.slot !== "positions" && r.slot !== "stories",
  );
  if (positions.length) blocks.push(`A stance you hold:\n${bul(positions)}`);
  if (stories.length) blocks.push(`A story you can draw on:\n${bul(stories)}`);
  if (other.length) blocks.push(`Other context:\n${bul(other)}`);
  return {
    constraints: bul(rows.filter((r) => r.slot === "avoid")),
    knowledge: blocks.join("\n\n"),
  };
}

/**
 * Retrieve the Brain material the writer should draw on. `avoid` rows come back as
 * hard `constraints` on EVERY path — brief usable or not — because constraint
 * enforcement must never depend on brief state, the kill switch, or a compile
 * failure. The brief (when usable: present, not coldStart, injection on) adds only
 * the `framing` prose + preferred-slot quotas; without it, retrieval degrades to
 * the flat top-k over non-avoid rows (avoid still hard-included).
 *
 * Exported for the lead-DM assembler (leads/dmContext.ts) — the DM writer must
 * draft from the SAME knowledge the reply writer sees, not a thinner copy.
 */
export type BrainWriterContext = {
  knowledge: string;
  constraints?: string;
  brief?: string;
  /** E1 provenance: the brief version + anchors this draft was generated under
   *  (null on the flat-retrieval path). Persisted on the message row. */
  briefSourceHash: string | null;
  briefAnchorIds: number[] | null;
};

export type BrainWriterPreparation = {
  compiledBrief: Campaign["compiledBrief"];
  knowledge: KnowledgeRetrievalSnapshot;
};

/** DB-only half of writer knowledge assembly. */
export async function prepareBrainForWriter(
  tx: Tx,
  campaign: Pick<Campaign, "compiledBrief">,
  knowledge?: KnowledgeRetrievalSnapshot,
): Promise<BrainWriterPreparation> {
  return {
    compiledBrief: campaign.compiledBrief,
    knowledge: knowledge ?? await prepareKnowledgeRetrieval(tx),
  };
}

/**
 * Provider-capable half of writer knowledge assembly. The preparation is plain
 * detached data, so fact reranking cannot pin a DB connection.
 */
export async function finalizeBrainForWriter(
  prepared: BrainWriterPreparation,
  opts: {
    queryText: string;
    llm?: LLM | null;
  },
): Promise<BrainWriterContext> {
  const cb = prepared.compiledBrief;
  const useBrief = config.briefInjection && cb != null && !cb.coldStart;
  // With the reranker ON we pull a WIDER candidate set (a cheap Haiku pass then picks the
  // few that actually fit this post); OFF, we keep the tight top-k slice. The base cosine
  // top-k over the ORG-WIDE Brain has no rerank on its own, so a wider k WITHOUT the
  // reranker would just inject weak-but-nearby rows the writer has to triage — hence the
  // widening is coupled to the reranker.
  // `llm:null` is an explicit no-server-cognition boundary used by the
  // customer-owned runner context. Undefined retains the managed-writer fallback.
  const rerank = config.factRerank && opts.llm !== null;
  const raw = await retrieveKnowledgeFromSnapshot(prepared.knowledge, {
    queryText: opts.queryText,
    k: rerank ? RERANK_CANDIDATES : WRITER_KNOWLEDGE_K,
    // No usable brief → empty preferred slots: flat top-k, avoid STILL hard-included.
    slotPolicy: { preferredSlots: useBrief ? cb!.preferredSlots : [] },
  });
  // Rerank down to the final writer slice (avoid rows are preserved as hard constraints;
  // best-effort — a rerank failure falls back to the incoming top-k order).
  const k = rerank
    ? await rerankKnowledgeForComment({
        postText: opts.queryText,
        rows: raw,
        finalK: WRITER_KNOWLEDGE_K,
        llm: opts.llm,
      })
    : raw;
  // Slot-typed rendering on EVERY path: avoid → CONSTRAINTS (never flattened into
  // "what you know" material), the rest → labeled knowledge blocks.
  const f = formatKnowledgeForWriter(k);
  return {
    knowledge: f.knowledge,
    constraints: f.constraints || undefined,
    brief: useBrief ? cb!.brief || undefined : undefined,
    briefSourceHash: useBrief ? cb!.sourceHash : null,
    briefAnchorIds: useBrief ? cb!.anchorKnowledgeIds : null,
  };
}

export async function brainForWriter(
  ctx: DraftCtx,
  campaign: Campaign,
  queryText: string,
): Promise<BrainWriterContext> {
  const prepared = await prepareBrainForWriter(ctx.db, campaign);
  return finalizeBrainForWriter(prepared, {
    queryText,
    llm: ctx.llm,
  });
}


// ---------------------------------------------------------------- writer-variety

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const STYLE_WINDOW_STATUSES: Message["status"][] = [
  "posted",
  "approved",
  "proposed",
  "suppressed_dryrun",
];

/** Min recent-window samples before the question-rate cap engages, so a fresh campaign
 *  with 1-2 comments doesn't over-react. */
const QUESTION_CAP_MIN_SAMPLES = 4;

/** Rows consumed by the style-rotation LRU (most recent first). Kept small on purpose:
 *  rotation only needs to avoid the last few structures. */
const STYLE_ROTATION_WINDOW = 8;

/** Rows the question-share is measured over. Wider than the rotation window: 8 samples
 *  quantize the share to 12.5% steps (cap 0.4 ≡ "≥3 of 8"); 30 gives the cap real
 *  resolution without dragging in stale history (still bounded by the 7-day cutoff). */
const QUESTION_SHARE_WINDOW = 30;

/** Drop one class id from a blended style axis, keeping it non-empty (the default
 *  taxonomy guarantees other classes, so this never empties it — guarded anyway). */
function dropAxisClass<T extends { id: string }>(axis: T[], id: string): T[] {
  const filtered = axis.filter((a) => a.id !== id);
  return filtered.length > 0 ? filtered : axis;
}

export type StyleWindowSnapshot = {
  recent: { opening?: string; shape?: string; stance?: string }[];
  questionShare: number;
  windowN: number;
  /** The campaign's newest agent drafts (`recentAgentDrafts`) — what the
   *  owner's signatures are rationed against. */
  recentDrafts?: string[];
};

/**
 * The newest comments a worker wrote on this campaign, newest first —
 * the run of drafts the owner's signatures are held to their rate over. The
 * owner's own comments are the rate, never a draft against it; `excludePostIds`
 * leaves out the drafts a batch is about to replace.
 */
export async function recentAgentDrafts(
  tx: Tx,
  campaignId: number,
  opts: { excludePostIds?: readonly number[] } = {},
): Promise<string[]> {
  const rows = await tx
    .select({ final: messages.finalText, proposed: messages.proposedText })
    .from(messages)
    .where(
      and(
        eq(messages.campaignId, campaignId),
        eq(messages.kind, "comment"),
        eq(messages.publishOrigin, "worker"),
        inArray(messages.status, STYLE_WINDOW_STATUSES),
        opts.excludePostIds?.length
          ? or(
              isNull(messages.discoveredPostId),
              notInArray(messages.discoveredPostId, [...opts.excludePostIds]),
            )
          : undefined,
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(SIGNATURE_WINDOW);
  return rows.map((row) => row.final ?? row.proposed ?? "").filter(Boolean);
}

/** DB-only half of style rotation. `campaignId` reads that campaign's recent
 *  agent drafts along with the org-wide window. */
export async function prepareStyleWindow(
  tx: Tx,
  campaignId?: number,
): Promise<StyleWindowSnapshot> {
  if (!config.styleDirectives) {
    return { recent: [], questionShare: 0, windowN: 0 };
  }
  try {
    const rows = await tx
      .select({
        sd: messages.styleDirectives,
        final: messages.finalText,
        proposed: messages.proposedText,
      })
      .from(messages)
      .where(
        and(
          eq(messages.kind, "comment"),
          inArray(messages.status, STYLE_WINDOW_STATUSES),
          gt(messages.createdAt, Date.now() - SEVEN_DAYS_MS),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(QUESTION_SHARE_WINDOW);
    const recent = rows.slice(0, STYLE_ROTATION_WINDOW).map((row) => {
      if (row.sd) return row.sd;
      return { opening: inferOpeningType(row.final ?? row.proposed ?? "") };
    });
    const questions = rows.filter((row) =>
      endsWithQuestion(row.final ?? row.proposed ?? ""),
    ).length;
    return {
      recent,
      windowN: rows.length,
      questionShare: rows.length > 0 ? questions / rows.length : 0,
      ...(campaignId != null ? { recentDrafts: await recentAgentDrafts(tx, campaignId) } : {}),
    };
  } catch (error) {
    console.warn(
      "[styleVariety] recent-window read failed, picking with no exclusion:",
      error,
    );
    return { recent: [], questionShare: 0, windowN: 0 };
  }
}

/** Pure provider/DB-free half of style rotation. */
export function pickStyleDirectivesFromSnapshot(
  snapshot: StyleWindowSnapshot,
  post: DiscoveredPost,
  structuralRange: StyleStructuralRange | null,
  opts: {
    length?: "ultra_short" | "short" | "medium" | "long";
    commentType: "promo" | "neutral";
    canPromo: boolean;
    /** Effective question-rate cap (0..1) or null when disabled — the global
     *  `config.questionCap` (ENGAGER_QUESTION_CAP). */
    questionCap: number | null;
    /** The voice's resolved closer-question policy: the voice owns register (how
     *  endings feel), the cap owns volume — "never" forbids regardless of cap,
     *  "encouraged" softens the over-cap line to a nudge. */
    closerQuestionPolicy: ResolvedStyleRules["closerQuestionPolicy"];
    /** The voice's traits: each draft is dealt their signatures and rare
     *  habits at the owner's rate against the snapshot's recent drafts, and
     *  keeps their register. */
    traits?: VoiceTraits;
    /** The voice's `DraftingKnobs.rationing`; absent is strict. */
    rationing?: Rationing;
    /** What the deal is seeded by; absent, the post's id, so retries agree. */
    seed?: string;
  },
): PickedDirectives | null {
  if (!config.styleDirectives) return null;

  const blendedRange = blendRanges(structuralRange);

  // Question-ending control = voice policy × question-rate cap. The voice owns
  // register ("never" forbids question closers outright; "encouraged" never gets
  // the hard line); the cap owns volume (question monoculture is a reach-filter
  // tell, so the pool drops apply at over-cap regardless of policy). When binding,
  // (a) drop the question opener + "ask" stance + the question-appending
  // social_react shape from THIS draft's pool, and (b) inject a no-question line
  // into the directive block — the pool filter alone can't close the loop because
  // guidance elsewhere may push toward a question hook. The blended range always
  // carries the default classes, so the drops never empty an axis. Cap null → no change.
  const cap = opts.questionCap;
  const overCap =
    cap != null &&
    snapshot.windowN >= QUESTION_CAP_MIN_SAMPLES &&
    snapshot.questionShare >= cap;
  const policy = opts.closerQuestionPolicy;
  const dropQuestions = policy === "never" || overCap;
  const questionMode: "hard_no" | "soft_no" | undefined =
    policy === "never"
      ? "hard_no"
      : overCap
        ? policy === "encouraged"
          ? "soft_no"
          : "hard_no"
        : undefined;
  let range = blendedRange;
  if (dropQuestions) {
    range = {
      ...blendedRange,
      opening: dropAxisClass(blendedRange.opening, "question_open"),
      stance: dropAxisClass(blendedRange.stance, "ask"),
    };
  }

  // Length-aware: never hand a SHORT campaign a multi-sentence shape, and never hand a
  // PROMO comment a one-liner (it needs room to engage + name the product + URL).
  const excludeShape = shapeExclusionFor({
    length: opts.length,
    commentType: opts.commentType,
    canPromo: opts.canPromo,
  });
  if (dropQuestions) excludeShape.add("social_react");
  const seed = opts.seed ?? String(post.id);
  const recentDrafts = snapshot.recentDrafts ?? [];
  return pickStyleDirectives({
    blendedRange: range,
    recent: snapshot.recent,
    seed,
    excludeShape,
    questionMode,
    heldSignatures: heldSignatures({
      signatures: opts.traits?.signatures,
      recent: recentDrafts,
      seed,
    }),
    heldHabits: heldHabits({
      habits: rationedHabits(opts.traits),
      recent: recentDrafts,
      seed,
    }),
    rationing: opts.rationing,
    register: opts.traits?.register,
  });
}

/**
 * Pick the per-draft STYLE DIRECTIVE (OPENING + SHAPE + STANCE) for this comment.
 */
async function loadStyleDirectives(
  ctx: DraftCtx,
  post: DiscoveredPost,
  structuralRange: StyleStructuralRange | null,
  opts: Parameters<typeof pickStyleDirectivesFromSnapshot>[3],
): Promise<PickedDirectives | null> {
  return pickStyleDirectivesFromSnapshot(
    await prepareStyleWindow(ctx.db, post.campaignId),
    post,
    structuralRange,
    opts,
  );
}

/** Everything the writer prompt consumes for one post, minus the post itself. */
export type CommentContext = {
  stepInstructions?: WritingStep;
  gate: { canMentionProduct: boolean; allowCta: boolean };
  /** In lead mode, the gate the person's intent holds this draft to; null on
   *  a Find posts campaign, whose Goal gates it. */
  intent: IntentGate | null;
  commentType: "promo" | "neutral";
  exemplars: Exemplar[];
  guidance: string | undefined;
  brain: {
    knowledge: string;
    constraints?: string;
    brief?: string;
    briefSourceHash: string | null;
    briefAnchorIds: number[] | null;
  };
  prof: Profile;
  /** The campaign's fully-resolved voice (attached → org default → legacy
   *  profile → template) — the single register authority for this draft. */
  voice: ResolvedVoiceV2;
  picked: PickedDirectives | null;
  /** Convenience mirror of `voice.styleRules`. */
  styleRules: ResolvedStyleRules;
  /** Per-post adaptive length decision (pinned campaigns resolve deterministically). */
  lengthDecision: LengthDecision;
  /** Per-post slop-gate strictness (auto varies with jitter; pinned is verbatim). */
  slopDecision: StrictnessDecision;
  /** Whether THIS draft gets the web-search fact-check path (campaign.webFacts
   *  gated by the smoothed webFactsRatio sampler — false when webFacts is off). */
  webFactsOn: boolean;
};

/**
 * What a comment may carry, and whether it is the promo. On a Find posts
 * campaign the objective is the ceiling: whether a product may be referenced
 * at all, the promo share sampled (smoothed), and whether a CTA is allowed
 * (see campaigns/objectives.ts). In lead mode the person's intent gate decides
 * instead and no share is sampled: a comment a product may come up in is the
 * promo, as it is on a Find posts campaign, so what it is held to (its length,
 * its strictness, the promo flag the slop check takes) allows a mention; Topic
 * only stays neutral.
 */
async function commentGate(
  tx: Tx,
  campaign: Campaign,
  hasProducts: boolean,
  intent: IntentGate | null,
): Promise<{ gate: CommentContext["gate"]; commentType: "promo" | "neutral" }> {
  if (intent) {
    return {
      gate: { canMentionProduct: intent.canMentionProduct, allowCta: intent.allowCta },
      commentType: intent.canMentionProduct ? "promo" : "neutral",
    };
  }
  const canMentionProduct = mayMentionProduct(campaign.objective, hasProducts);
  const promoRatio = canMentionProduct
    ? effectivePromoRatio(campaign.objective, campaign.tone?.promo_ratio)
    : 0;
  return {
    gate: { canMentionProduct, allowCta: mayUseCta(campaign.objective) },
    commentType: await decideCommentType(tx, campaign.id, promoRatio),
  };
}

/**
 * Assemble the writer-facing context for ONE post: objective gating + promo
 * sampling, RAG exemplars, learned guidance, Brain knowledge/brief, the account
 * profile (voice), and the per-draft style directive. Read-only against pipeline
 * state (the sampler and style picker only read), for the MCP
 * `get_drafting_context` tool.
 *
 * `post` may be null (the tool's campaign-level variant): retrieval then keys off
 * the campaign's filter instruction and the style directive is skipped.
 */
export async function assembleCommentContext(
  ctx: DraftCtx,
  post: DiscoveredPost | null,
  campaign: Campaign,
  opts: {
    /** Preloaded product context. */
    products: ProductContext[];
    /** The filter's `promo_safe` verdict; `false` downgrades a sampled promo to
     *  neutral under config.promoFit. Undefined (no verdict) → no downgrade. */
    promoSafe?: boolean;
    /** Fresh BetScore, falling back to the stored `post.betScore`. */
    betScore?: number | null;
    /** What this draft's per-post decisions are seeded by, in place of the
     *  post's id — a preview's further candidates. */
    seed?: string;
    /** Drafting knobs laid over the voice's own — a preview's variant. */
    knobs?: DraftingKnobs;
    brainPreparation?: BrainWriterPreparation;
    postText?: string;
  },
): Promise<CommentContext> {
  const content = post
    ? (opts.postText ?? post.contentText ?? "")
    : campaign.aiFilter?.instruction?.trim() || campaign.name;

  // 2. what the comment may carry + promo vs neutral (`commentGate`): the
  //    objective's ceiling, or in lead mode the post author's intent.
  const intent = await draftIntentGate(ctx.db, post?.authorProfileId, opts.products.length > 0);
  const { gate, commentType: decided } = await commentGate(ctx.db, campaign, opts.products.length > 0, intent);
  const { canMentionProduct } = gate;
  let commentType = decided;

  // Post-aware promo fit (flag-gated): the ratio sampler is content-blind, so a promo
  // can land on an emotionally raw post (grief / layoff / loss) that passed the topic
  // filter. The filter already reads the full post, so it returns `promo_safe`; here we
  // only ever DOWNGRADE promo→neutral (never upgrade). The sampler self-corrects the
  // realized ratio on the next draft, so there is no ratio drift.
  if (config.promoFit && commentType === "promo" && opts.promoSafe === false) {
    commentType = "neutral";
  }

  // 2b. the campaign's VOICE (attached → org default → legacy profile →
  //     template) — resolved early: exemplar retrieval filters by it, and it
  //     owns the register everywhere downstream.
  const prof = await getProfile(ctx.db);
  const voice = await resolveSavedWritingVoice(ctx.db, campaign, prof, "comment", {
    knobs: opts.knobs,
  });
  const styleRules = voice.styleRules;

  // 3. exemplars (RAG, voice-compatible) + learned guidance
  const exemplars = await retrieveExemplars({
    campaignId: campaign.id,
    kind: "comment",
    queryText: content,
    db: ctx.db,
    voiceId: voice.voiceId,
  });
  const [g] = await ctx.db
    .select({ g: campaignGuidance.guidance })
    .from(campaignGuidance)
    .where(eq(campaignGuidance.campaignId, campaign.id));
  const guidance = g?.g;

  // 3b. Brain knowledge (facts/beliefs) relevant to this post — slot-aware +
  //     campaign focus brief when compiled (else flat retrieval, byte-identical).
  const brain = opts.brainPreparation
    ? await finalizeBrainForWriter(opts.brainPreparation, { queryText: content, llm: ctx.llm })
    : await brainForWriter(ctx, campaign, content);

  // 3b2. per-post adaptive LENGTH + slop strictness. Resolved BEFORE the style
  //      directive so shape exclusion keys off the ACTUAL tier this draft will
  //      use, not the campaign's static setting. Seeded by the post id (retries
  //      agree); the campaign-level MCP variant seeds off the campaign.
  const seed = opts.seed ?? (post ? String(post.id) : `campaign:${campaign.id}`);
  const betScore = opts.betScore ?? post?.betScore ?? null;
  const recentTiers = await recentLengthTiers(ctx.db);
  const lengthDecision = decideLengthTier({
    campaign,
    postText: post?.contentText ?? null,
    commentType,
    canMentionProduct,
    betScore,
    recentTiers,
    seed,
  });
  const slopDecision = decideSlopStrictness({
    campaign,
    commentType,
    canMentionProduct,
    betScore,
    lengthTier: lengthDecision.tier,
    seed,
  });

  // Fact-check sampling: only webFactsRatio of drafts get the search path — every
  // comment citing a stat is itself an AI tell, and the ratio is the budget dial.
  const webFactsOn = campaign.webFacts
    ? await decideWebFacts(ctx.db, campaign.id, campaign.webFactsRatio)
    : false;

  // 3c. per-draft STYLE DIRECTIVE (writer-variety, Phase 2) — voice-derived,
  //     org-wide LRU rotation. null when the kill switch is off.
  const picked = post
    ? await loadStyleDirectives(ctx, post, voice.structuralRange, {
        length: lengthDecision.tier,
        commentType,
        canPromo: canMentionProduct,
        // The global env default (ENGAGER_QUESTION_CAP); unset = disabled.
        questionCap: config.questionCap,
        closerQuestionPolicy: styleRules.closerQuestionPolicy,
        traits: styleRules.traits,
        rationing: styleRules.knobs?.rationing,
        seed,
      })
    : null;

  return {
    stepInstructions: await readWritingStep(ctx.db, campaign.id, "comment"),
    gate,
    intent,
    commentType,
    exemplars,
    guidance,
    brain,
    prof,
    // A post's draft is shown a seeded few of the owner's examples.
    voice:
      post && voice.examples
        ? { ...voice, examples: examplesForDraft(voice.examples, seed, styleRules.knobs) }
        : voice,
    picked,
    styleRules,
    lengthDecision,
    slopDecision,
    webFactsOn,
  };
}


export type ReplyDraftingContext = {
  guidance?: string;
  brain: Awaited<ReturnType<typeof brainForWriter>>;
  voice: ResolvedVoiceV2;
  threadContext: ReplyThreadContext;
  /** Legacy thread framing consumed by the writer alongside full context. */
  thread?: { ourCommentText: string };
  writerOptions: Omit<ReplyWriterOptions, "llm" | "retryFeedback">;
  renderedPrompt: RenderedReplyPrompt;
};

export type PreparedReplyDraft = {
  stepInstructions?: WritingStep;
  incoming: IncomingComment;
  campaign: Campaign;
  guidance?: string;
  brain: BrainWriterPreparation;
  profile: Profile;
  voice: ResolvedVoiceV2;
  exemplarRows: ExemplarRetrievalSnapshot;
  threadContext: ReplyThreadContext;
  /** The campaign's attached products, as the comment lane reads them. */
  products: ProductContext[];
};

/**
 * Stable compare-and-swap token for every DB input captured before detached
 * reply cognition. Arrays whose SQL order is not part of the contract are
 * sorted so an unchanged snapshot always produces the same revision.
 */
export function replyPreparationRevision(prepared: PreparedReplyDraft): string {
  return JSON.stringify({
    incoming: prepared.incoming,
    campaign: prepared.campaign,
    guidance: prepared.guidance ?? null,
    stepInstructions: writingStepRevision(prepared.stepInstructions),
    brain: {
      compiledBrief: prepared.brain.compiledBrief,
      knowledge: [...prepared.brain.knowledge].sort((a, b) => a.id - b.id),
    },
    profile: prepared.profile,
    voice: prepared.voice,
    exemplarRows: [...prepared.exemplarRows].sort((a, b) => a.id - b.id),
    threadContext: {
      ...prepared.threadContext,
      exchanges: [...prepared.threadContext.exchanges].sort(
        (a, b) =>
          (a.at ?? 0) - (b.at ?? 0) ||
          a.who.localeCompare(b.who) ||
          a.text.localeCompare(b.text),
      ),
    },
    products: prepared.products,
  });
}

/** The products a reply is written with. In lead mode the comment author's intent
 *  decides, as it does for a comment: none are handed over where the gate lets
 *  no product come up. */
async function replyProducts(
  tx: Tx,
  campaign: Campaign,
  incoming: IncomingComment,
  options: ProductContextOptions = {},
): Promise<ProductContext[]> {
  const products = await loadCampaignProductContext(tx, campaign.id, options);
  const intent = await draftIntentGate(tx, incoming.authorProfileId, products.length > 0);
  return productsWithin(intent, products);
}

/** DB-only reply snapshot for the managed worker. `products` shapes the
 *  facts the campaign's products are read with, for a caller that claims only
 *  some of them. */
export async function prepareReplyDraft(
  tx: Tx,
  incoming: IncomingComment,
  campaign: Campaign,
  threadContext?: ReplyThreadContext,
  products: ProductContextOptions = {},
  binding: { step?: WritingStep | null; voice?: ResolvedVoiceV2 } = {},
): Promise<PreparedReplyDraft> {
  const [guidance] = await tx
    .select({ guidance: campaignGuidance.guidance })
    .from(campaignGuidance)
    .where(eq(campaignGuidance.campaignId, campaign.id));
  const profile = await getProfile(tx);
  const voice = binding.voice ?? await resolveSavedWritingVoice(tx, campaign, profile, "reply");
  return {
    stepInstructions: binding.step === undefined ? await readWritingStep(tx, campaign.id, "reply") : binding.step ?? undefined,
    incoming,
    campaign,
    guidance: guidance?.guidance,
    brain: await prepareBrainForWriter(tx, campaign),
    profile,
    voice,
    exemplarRows: await prepareExemplarRetrieval(tx, {
      campaignId: campaign.id,
      kind: "reply",
      voiceId: voice.voiceId,
    }),
    threadContext: threadContext ?? (await assembleReplyContext(tx, incoming)),
    products: await replyProducts(tx, campaign, incoming, products),
  };
}

/**
 * Read-only reply assembly shared by managed drafting and the customer-owned
 * runner. Callers that pass `{ llm: null }` get the exact deterministic
 * prompt/context without any Engager-side cognition.
 */
export async function assembleReplyDraftingContext(
  ctx: DraftCtx,
  inc: IncomingComment,
  campaign: Campaign,
  pre?: { threadCtx?: ReplyThreadContext },
): Promise<ReplyDraftingContext> {
  const [g] = await ctx.db
    .select({ g: campaignGuidance.guidance })
    .from(campaignGuidance)
    .where(eq(campaignGuidance.campaignId, campaign.id));
  const guidance = g?.g;

  const brain = await brainForWriter(ctx, campaign, inc.text);
  const voice = await resolveSavedWritingVoice(
    ctx.db,
    campaign,
    await getProfile(ctx.db),
    "reply",
  );
  const threadContext =
    pre?.threadCtx ?? (await assembleReplyContext(ctx.db, inc));
  const thread =
    inc.source === "our_comment_thread" && threadContext.ourComment
      ? { ourCommentText: threadContext.ourComment.text }
      : undefined;
  const writerOptions: Omit<ReplyWriterOptions, "llm" | "retryFeedback"> = {
    stepInstructions: await readWritingStep(ctx.db, campaign.id, "reply"),
    incomingText: inc.text,
    authorName: inc.authorName,
    campaign,
    guidance,
    voice: {
      persona: voice.persona,
      houseStyle: voice.houseStyle,
      styleRules: voice.styleRules,
      replyTraits: voice.replyTraits,
      examples: voice.examples,
      samples: voice.samples,
      channelEdits: voice.channelEdits,
    },
    knowledge: brain.knowledge,
    constraints: brain.constraints,
    brief: brain.brief,
    products: await replyProducts(ctx.db, campaign, inc),
    thread,
    context: threadContext,
  };
  return {
    guidance,
    brain,
    voice,
    threadContext,
    thread,
    writerOptions,
    renderedPrompt: renderReplyPrompt(writerOptions),
  };
}
