import { writingCompliancePrompt } from "../ai/writingInstructions";
import type { LLM } from "../ai/client";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import {
  TRIAGE_ANGLE_MAX_CHARS,
  AuthoredTextSchema,
  sanitizeTriageAngle,
} from "../ai/authoredText";
import {
  campaigns,
  channels,
  candidateFeedback,
  discoveredPosts,
  incomingComments,
  messageDraftRevisions,
  messages,
  organizations,
  type Campaign,
  type DiscoveredPost,
  type DraftingKnobs,
  type DraftTrace,
  type IncomingComment,
  type Message,
} from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { runtimeEntitlement } from "@engager/billing/entitlement";
import { isAssisted, isUntouchedOffer, measureBoxAssist } from "@engager/common/text-provenance";
import { boxKey, composerOffered, higherRetention, measureComposer } from "../composer/drafts";
import { assertJudgedWords } from "../dispatcher/landedJudge";
import { extractEditSignals, learnFromSave } from "../learning/editSignals";
import {
  captureVoiceSample,
  ownerSampleSource,
} from "../learning/voiceSamples";
import { campaignVoiceId, getVoiceForCampaign } from "../voice";
import { activeDirectives } from "../voice/habits";
import {
  AuthorProfileReadSchema,
} from "../linkedin/browser-use/protocol";
import { hostRoomJudgmentsSchema, hostRoomReadSchema, hostRoomThreadSchema, prepareHostRoomRead } from "../rooms/hostRead";
import { roomInsightsSchema } from "../rooms/insightEvidence";
import { commentingContext } from "../campaigns/commenting";
import { productsWithin } from "../campaigns/intentGate";
import { intakeGateViolations } from "../ai/intakeGate";
import { sensitivityRow } from "../ai/reading";
import { isRoomThreadReply } from "../rooms/thread";
import { lockRoomVoice, roomVoiceTaken } from "../rooms/oneVoice";
import { linkedinPostUrl } from "../linkedin/postUrl";
import { extractExternalLinks } from "../linkedin/externalLinks";
import { engagementCounts } from "./postSnippets";
import { COMMENT_LENGTH_LIMIT } from "../commentLength";
import {
  blendAngleWeights,
  currentAngleProfile,
} from "../learning/angleProfile";
import { ASSIST_MOVES } from "./candidateDraft";
import {
  LENGTH_TARGET_DISTRIBUTION,
  countWords,
  recentLengthTiers,
  tierByWordCount,
} from "../ai/lengthSampler";
import {
  effectiveCommentGuidance,
  effectiveReplyGuidance,
} from "../ai/promptDefaults";
import {
  mechanicalViolations,
  rejectThreshold,
  slopSystemPrompt,
} from "../ai/slop";
import {
  SLOP_PATTERN_FLOOR,
  serializePatterns,
  slopPatternViolations,
} from "../ai/slopPatterns";
import { styleLint } from "../ai/styleRules";
import {
  PLAY_GUIDANCE,
  WEB_FACTS_INSTRUCTIONS,
  lengthSpec,
  lengthSpecForTier,
  renderAngleSystemPrompt,
  renderCommentSystemPrompt,
  replyRules,
  type CommentPromptOptions,
} from "../ai/writer";
import { canAnswerRoom, readRoomForDrafting, readVerifiedResearch } from "./researchReads";
import { draftHoldFor, draftHoldNote, type DraftHold } from "../people/draftHolds";
import { readFollowUp } from "../people/followUp";
import {
  STORY_KEPT_MAX_DISTANCE,
  listOwnerStories,
  storyRefusal,
  storyTold,
} from "./ownerStories";
import { sentTexts } from "./sentTexts";
import { OWNER_AUTHORED_MODEL } from "../learning/authorship";
import { ownerVoiceSamples } from "../learning/recalibrate";
import { config } from "../config";
import { assembleCommentContext, recentAgentDrafts, type BrainWriterPreparation } from "../draft";
import { draftingPostText } from "../workers/postText";
import { rationingOveruse } from "../learning/styleVariety";
import { recentFactsShare } from "../ai/promoSampler";
import { randomUUID } from "node:crypto";
import { getProfile } from "../profile";
import { resolveCampaignVoice } from "../voice";
import { pausedPressAllowed, readCampaignStrategy, type PausedPress } from "../strategy/read";
import { modeFor } from "../strategy/mode";
import { isSupportedPublicCampaignRuntime } from "./campaigns";
import { getChannelWriteAuthority, getOwnPostRepliesScoped } from "./orgSettings";
import { queueComment } from "../actions/comment";
import { queueAutomaticReply, sendApprovedReply } from "../actions/reply";
import { assignSlots, type SlotItem } from "./schedule";
import {
  lockCommentDraftCandidateRows,
  lockCommentDraftIntake,
} from "./commentDraftLocks";
import { dedupeKey } from "../posting";
import { canEngage, recordLedger } from "../ratelimit/ledger";
import { loadCampaignProductContext } from "../products/queries";
import { trackOwnerSave } from "../telemetry/emit";
import { trackFirstDraft } from "../telemetry/firstResults";

export type ClientIntakeErrorDetails = {
  code?: string;
  status?: number;
  recovery?: string;
};

export type ClientIntakeResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; details?: ClientIntakeErrorDetails };

export type ClientIntakeOptions = {
  /** Legacy runner credentials are review-only. Leased v2 callers pass false. */
  forceProposal: boolean;
  /** Server-derived from the MCP credential profile, never from tool input. */
  explicitUserDirected?: boolean;
  /** Resolve an agent's interactive draft against the active strategy. */
  resolveStepMode?: boolean;
  /** The owner asked for these words (a redraft). The text-boundary invariant
   *  (markdown, a URL) still refuses them; a repeat of a sent comment does not. */
  ownerRequested?: boolean;
  /** Private durable authority frozen into a runner order; never exposed on wire. */
  durableRequest?: DurableDraftRequest;
  /** Candidate-keyed private authorities for runner comment/redraft batches. */
  durableRequests?: ReadonlyMap<number, DurableDraftRequest>;
  /** Runner credentials may use a request only when the order froze its identity. */
  requireFrozenRequest?: boolean;
  /**
   * A draft the owner asked for from the app, written by the app's own
   * workflow (`chat/requestedReply.ts`), which runs no sensitivity check: the
   * reply's verdict and why it was held stand as intake left them, as they do
   * under the owner's own words. Server-derived, never wire input.
   */
  keepsSensitivity?: boolean;
  /**
   * The text is the owner's own, saved from a card rather than drafted for
   * them. Server-derived from the calling tool, never from wire input.
   *
   * ONE flag, three consequences, deliberately inseparable: it exempts the
   * text from the AI-slop gate, marks the row owner-authored for pacing, and
   * IS the approval (save = send — the comment lands approved and takes the
   * nearest min-gap slot). There is no campaign column in that decision; the
   * fences that still bind are `forceProposal` and the paused-target
   * refusal. The one exception is {@link agentWords}.
   */
  authoredByOwner?: boolean;
  /**
   * The owner saved their agent's words from their own box untouched
   * (`isUntouchedOffer` against everything the box offered), words they had
   * not typed first (`isAssisted`). The press is still their approval, but
   * the words are not theirs, so the row goes out as the agent's —
   * `publishOrigin = 'worker'`, where caps, the window and the day plan
   * bind — and teaches the voice nothing. Server-derived by the save, never
   * wire input.
   */
  agentWords?: boolean;
  /**
   * A WORKER RUN is the author of this batch, and whether its drafts land
   * approved (scheduled, which IS posting) or proposed (waiting for a yes)
   * is the worker's own `publish`, not a campaign property.
   *
   * Server-derived from the worker row inside the run handler, NEVER from
   * wire input — no MCP caller can hand itself publish authority. Two separate
   * facts on purpose: `workerAuthored` is what lets the batch through the
   * bulk-supply refusal below, `publish` is what arms it. `forceProposal` and a
   * sensitivity hold still win over both.
   *
   * `runId` is REQUIRED, not optional: it is the only durable evidence that a
   * run wrote a row (`publishOrigin` defaults to "worker", so it proves
   * nothing), and an optional field would let a worker-authored intake
   * path compile while silently writing NULL. It is nullable but never
   * omittable — the leased runner lane is unattended output with no
   * `worker_runs` row to point at, and it says so explicitly rather than
   * by forgetting.
   */
  worker?: {
    workerAuthored: true;
    publish: boolean;
    runId: number | null;
  };
  /**
   * The Run once press whose run wrote this batch, on the Paused campaign it
   * is for (`pausedPressAllowed`): that campaign takes the batch, and nothing
   * in it is armed — the run passes `publish: false`. Server-derived inside
   * the run handler, never from wire input.
   */
  pausedPress?: PausedPress;
};

export type DurableDraftRequest = {
  target: "incoming" | "message";
  targetId: number;
  requestId: string;
  requestVersion: number;
  status: string;
};

/**
 * Provenance for `pacingPolicy` (ratelimit/ledger.ts). An owner-authored save
 * is a human act, so only the spacing floors bind it; agent bulk supply,
 * server drafts, and worker output are unattended volume and take the full
 * daily caps, active window, org ceiling, and day plan.
 *
 * Deliberately the SAME predicate that exempts the text from the AI-slop gate
 * and earns it a voice sample: the act that teaches the voice is the act that
 * earns spacing-only pacing. A bare approval of someone else's draft is not
 * that act — including the owner's own press on their agent's words left
 * untouched in their box (`agentWords`).
 */
function publishOriginFor(options: ClientIntakeOptions): "owner" | "worker" {
  return options.authoredByOwner === true && options.agentWords !== true ? "owner" : "worker";
}

function intakeSuccess<T>(data: T): ClientIntakeResult<T> {
  return { ok: true, data };
}

function intakeError(
  error: string,
  details?: ClientIntakeErrorDetails,
): ClientIntakeResult<never> {
  return details ? { ok: false, error, details } : { ok: false, error };
}

/** Re-exported where the composing tools have always named it. */
export { OWNER_AUTHORED_MODEL };

async function supportedCampaignError(
  tx: Tx,
  campaign: Campaign,
  opts: {
    /** The owner press a Paused campaign lets through (`pausedPressAllowed`):
     *  that one campaign is supported for the press's own writes. */
    press?: PausedPress;
    /** False only for the owner's own words landing as a proposal: nothing
     *  that waits for a yes needs its campaign running, and a reply on a paused
     *  campaign is still the owner's to answer. */
    requireActive?: boolean;
  } = {},
): Promise<ClientIntakeResult<never> | null> {
  // Intake is a mutation boundary: serialize it with cancellation. There is no
  // pre-activation exception left: an unactivated Checkout grants nothing.
  const entitlement = await runtimeEntitlement(tx, campaign.organizationId, {
    lock: true,
  });
  if (!entitlement.allowed) {
    return intakeError("An active subscription is required for campaign work", {
      code: "subscription_inactive",
      status: 402,
      recovery:
        "Use setup/billing tools to start a protected subscription generation, then retry.",
    });
  }
  if (
    opts.requireActive !== false &&
    !isSupportedPublicCampaignRuntime(campaign) &&
    !(await pausedPressAllowed(tx, campaign, opts.press))
  ) {
    return intakeError(
      `campaign ${campaign.id} is not in a supported active/live public state`,
      {
        code: "unsupported_public_campaign_flow",
        status: 409,
        recovery:
          "Ask the owner to start the campaign in Engager, or point the work at one that is active.",
      },
    );
  }
  // No active-campaign count. The one-active-target policy lifted with T-8.11:
  // an account may hunt several audiences at once, and what bounds the work is
  // the account's own arithmetic — one budget, one day plan, one lease.
  return null;
}

/**
 * The CLIENT-DRAFTING (batch draft-factory) tool set. The external agent's LLM
 * does all the LLM work — filtering candidates, drafting, slop/sensitivity
 * self-checks (rubrics ship in the skills/engager-people skill); these tools only
 * hand it context and accept its finished drafts. The submit path runs no server
 * LLM and consumes no Engager credits — the customer's model-provider allowance
 * or API spend still applies. Publishing stays gated per-post at send time by
 * canEngage + exactly-once, untouched.
 */

const DAY = 86_400_000;
const RECENT_COMMENTS_WINDOW_MS = 7 * DAY;
const RECENT_COMMENTS_K = 15;
const RECENT_STATUSES: Message["status"][] = [
  "posted",
  "approved",
  "proposed",
  "suppressed_dryrun",
];

/**
 * Where a client-authored draft lands: "auto" → approved (the paced publisher
 * takes it from there); "manual" → proposed. A sensitivity HOLD always waits
 * for human review even when the caller passes "auto" (parity with
 * processIncoming).
 */
function submitStatus(
  hold = false,
  forceProposal = false,
  /**
   * Who decides approve-vs-propose for THIS batch. There are exactly two
   * authorities, and both are properties of the BATCH: an owner-AUTHORED batch
   * passes "auto" (save = send — writing the words is the approval), and a
   * worker passes its action's live mode, because the worker is what the owner
   * armed. The campaign is not one of them — the default is "manual", so
   * nothing approves a draft nobody asked to publish.
   */
  approval: "manual" | "auto" = "manual",
): "approved" | "proposed" {
  // The temporary runner v1 bridge is deliberately draft-only. Until Phase 3
  // replaces it with leased item-scoped operations, an unattended credential
  // may populate the human review queue but can never queue a send.
  if (forceProposal) return "proposed";
  if (approval === "auto" && !hold) return "approved";
  return "proposed";
}

function exactIncomingRequest(
  request: DurableDraftRequest | undefined,
  incoming: {
    id: number;
    status: string;
    draftRequestId: string | null;
    draftRequestVersion: number;
  },
): boolean {
  return (
    request?.target === "incoming" &&
    request.targetId === incoming.id &&
    request.requestId === incoming.draftRequestId &&
    request.requestVersion === incoming.draftRequestVersion &&
    request.status === incoming.status
  );
}

function exactMessageRequest(
  request: DurableDraftRequest | undefined,
  message: {
    id: number;
    status: string;
    redraftRequestId: string | null;
    redraftRequestVersion: number;
  },
): boolean {
  return (
    request?.target === "message" &&
    request.targetId === message.id &&
    request.requestId === message.redraftRequestId &&
    request.requestVersion === message.redraftRequestVersion &&
    request.status === message.status
  );
}

async function replayedRedraft(
  tx: Tx,
  request: DurableDraftRequest | undefined,
): Promise<{ messageId: number } | null> {
  if (request?.target !== "message") return null;
  const [revision] = await tx
    .select({ messageId: messageDraftRevisions.messageId })
    .from(messageDraftRevisions)
    .where(
      and(
        eq(messageDraftRevisions.messageId, request.targetId),
        eq(messageDraftRevisions.requestId, request.requestId),
        eq(messageDraftRevisions.requestVersion, request.requestVersion),
      ),
    )
    .limit(1);
  return revision ?? null;
}

/** Recent org-wide comment texts — the client self-diversifies against these
 *  (the server-side embedding diversity check is deliberately NOT run here). */
async function recentCommentTexts(
  tx: Tx,
): Promise<string[]> {
  const rows = await tx
    .select({ final: messages.finalText, proposed: messages.proposedText })
    .from(messages)
    .where(
      and(
        eq(messages.kind, "comment"),
        inArray(messages.status, RECENT_STATUSES),
        gt(messages.createdAt, Date.now() - RECENT_COMMENTS_WINDOW_MS),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(RECENT_COMMENTS_K);
  return rows.map((r) => r.final ?? r.proposed ?? "").filter(Boolean);
}

/** Few-shot corpus size for `voiceSamples`: the 5–8 newest owner-written
 *  samples. */
const VOICE_SAMPLE_FEWSHOT_LIMIT = 8;

export async function getCommentDraftingContext(
  tx: Tx,
  campaign: Campaign,
  input: {
    discoveredPostId?: number;
    /** "angles" renders the angle system prompt instead of the comment one;
     *  absent = "draft" (byte-compatible). Everything else stays identical. */
    mode?: "angles" | "draft";
    llm?: LLM | null;
    /** A preview's: what the post's per-draft decisions are seeded by in
     *  place of its id, and knobs laid over the voice's own. */
    seed?: string;
    knobs?: DraftingKnobs;
    brainPreparation?: BrainWriterPreparation;
    products?: Awaited<ReturnType<typeof loadCampaignProductContext>>;
    /** Recheck saved owner inputs without resampling a per-draft suggestion. */
    styleDirective?: string | null;
  },
) {
  let post = null;
  if (input.discoveredPostId != null) {
    const [p] = await tx
      .select()
      .from(discoveredPosts)
      .where(eq(discoveredPosts.id, input.discoveredPostId));
    if (!p)
      return intakeError(`discovered_post ${input.discoveredPostId} not found`);
    if (p.campaignId !== campaign.id) {
      return intakeError(
        `discovered_post ${input.discoveredPostId} belongs to campaign ${p.campaignId}, not ${campaign.id}`,
      );
    }
    post = p;
  }

  const draftCtx = { db: tx, llm: input.llm };
  const products = input.products ?? await loadCampaignProductContext(tx, campaign.id);
  // A verified read of the post: the play the writer follows, what the thread
  // already said, and the author's register. Null for an unverified post, and
  // the prompt is then byte-identical to before research existed.
  const research = post ? await readVerifiedResearch(tx, post.id) : null;
  const room = post && research ? await readRoomForDrafting(tx, post.id) : null;
  // What already passed between the account and the post's author: with any,
  // this comment is a follow-up and is written as one. Null for a first touch,
  // and the prompt is then byte-identical to before follow-ups existed.
  const followUp = post?.authorProfileId ? await readFollowUp(tx, post.authorProfileId) : null;
  // The owner's own stories: the only personal claims a draft may make.
  const ownerStories = await listOwnerStories(tx, Date.now());
  const authorToneSample = (research?.author?.recentPosts ?? [])
    .slice(0, 2)
    .map((recent) => recent.text.slice(0, 280))
    .filter((line) => line.trim().length > 0);
  const cc = await assembleCommentContext(draftCtx, post, campaign, {
    products,
    seed: input.seed,
    knobs: input.knobs,
    brainPreparation: input.brainPreparation,
    postText: post ? draftingPostText(post, research?.thread.fullText) : undefined,
  });
  // Per-post: the exact seeded decision the server writer would make (same
  // sampler, same seed) so client and server drafts agree. Campaign-level:
  // the campaign's own decision plus a lengthPlan so the batch agent can
  // self-allocate varied tiers across its drafts.
  const spec = lengthSpec(
    campaign,
    cc.commentType,
    cc.gate.canMentionProduct,
    cc.lengthDecision.tier,
  );
  const recentTiers = await recentLengthTiers(tx);
  // The campaign's fully-resolved voice (attached → org default → legacy →
  // template) — the client drafts comments, so it always gets the comment
  // channel. The resolved register rules ride along so the agent's
  // self-checks and the rendered system prompt agree ("one source, three
  // renderings").
  const resolved = cc.voice;
  const voice = {
    channel: resolved.channel,
    voiceId: resolved.voiceId,
    name: resolved.voiceName,
    language: resolved.language,
    persona: resolved.persona,
    houseStyle: resolved.houseStyle,
    sources: resolved.sources,
    styleRules: cc.styleRules,
    styleRulesOverridden: resolved.styleRulesOverridden,
    resolvedFrom: resolved.resolvedFrom,
    // The examples the owner gave of how they write (save_voice) —
    // rendered into systemPrompt ahead of the samples below.
    examples: resolved.examples ?? [],
  };
  // Few-shot register evidence for BOTH prompt modes: the newest comments the
  // owner WROTE — never an agent draft they approved, which would teach the
  // model its own style back — of the campaign's own voice (the same ladder
  // resolveCampaignVoice walks — attached voice, else the org default). Lives
  // inside this operation so the campaign-level and post-level calls carry it
  // identically. No samples → [] → byte-identical prompts. An org with no
  // voice rows yet still has a corpus — samples captured then carry voiceId
  // null ("the default voice at the time"), which is exactly what the
  // default-shaped probe matches; read paths stay write-free, so no
  // ensureDefaultVoice here.
  const voiceRow = await getVoiceForCampaign(tx, campaign);
  const voiceSampleTexts = await ownerVoiceSamples(
    tx,
    voiceRow?.voice ?? { id: -1, isDefault: true },
    VOICE_SAMPLE_FEWSHOT_LIMIT,
  );
  // Revealed angle preferences, pre-blended with the taxonomy floor so the
  // heaviest move never monopolizes. Null profile → field absent → prompt
  // byte-identical to before angle learning existed.
  const angleProfile = await currentAngleProfile(tx);
  const blendedAngles =
    angleProfile != null ? blendAngleWeights(angleProfile.weights) : null;
  const promptOptions: CommentPromptOptions = {
    campaign,
    commentType: cc.commentType,
    stepInstructions: cc.stepInstructions,
    styleDirectives: input.styleDirective === undefined ? cc.picked?.block : input.styleDirective ?? undefined,
    guidance: cc.guidance,
    voice,
    knowledge: cc.brain.knowledge,
    constraints: cc.brain.constraints,
    brief: cc.brain.brief,
    gate: cc.gate,
    products: productsWithin(cc.intent, products),
    groundInFacts: config.factGrounding,
    lengthTier: cc.lengthDecision.tier,
    webFacts: campaign.webFacts,
    voiceSamples: voiceSampleTexts,
    ...(blendedAngles ? { angleProfile: blendedAngles } : {}),
    research: research
      ? {
          play: research.play,
          alreadySaid: research.alreadySaid,
          authorHeadline: research.author?.headline ?? null,
          authorToneSample,
          ...(room ? { room } : {}),
        }
      : null,
    ownerStories:
      ownerStories.length > 0
        ? ownerStories

            .map(({ id, title, content }) => ({ id, title, content }))
        : null,
    // How this voice edits drafts, from its own saves, less what the owner
    // switched off. None learned → no block.
    learnedEdits: activeDirectives(voiceRow?.voice),
    followUp,
  };
  const systemPrompt =
    input.mode === "angles"
      ? renderAngleSystemPrompt(promptOptions)
      : renderCommentSystemPrompt(promptOptions);
  const t = campaign.tone ?? {};

  return intakeSuccess({
    voice,
    commenting: commentingContext(campaign, cc.intent),
    campaign: {
      id: campaign.id,
      name: campaign.name,
      // None in lead mode: the person's intent gates it (`gate`, `commenting`).
      objective: null,
      angle: t.angle ?? null,
      do: t.do ?? [],
      avoid: t.avoid ?? [],
      commentGuidance: effectiveCommentGuidance(
        campaign.prompts?.comment_guidance,
        null,
      ),
      replyGuidance: effectiveReplyGuidance(campaign.prompts?.reply_guidance),
      filterInstruction:
        campaign.aiFilter?.instruction?.trim() ||
        "Posts relevant to the campaign.",
      filterMinConfidence: campaign.aiFilter?.min_confidence ?? 0,
      targetLanguage: campaign.aiFilter?.target_language ?? null,
      maxPostAgeDays: campaign.maxPostAgeDays,
    },
    brain: {
      knowledge: cc.brain.knowledge || null,
      constraints: cc.brain.constraints ?? null,
      brief: cc.brain.brief ?? null,
    },
    // What a writer may name: none under a gate that lets no product come up.
    // The context is serialized to the writer whole, so nothing else in it
    // names one; the dispatcher's judge reads the names itself.
    products: productsWithin(cc.intent, products),
    gate: cc.gate,
    suggestedCommentType: cc.commentType,
    // Post-specific: the post itself, in full. This is the model-visible
    // full-body read — the deck's own composition read stays app-only — so
    // chat can draft from deckFocus with exactly one further call.
    post: post
      ? {
          contentText: post.contentText,
          url: linkedinPostUrl(post.url, post.postUrn),
          postedAt: post.postedAt,
          status: post.status,
          agentAngle: post.agentAngle,
          whyItFits: post.agentRankReason,
          engagement: engagementCounts(post.metrics),
          // External assets the post points at. When present, FETCH them
          // (WebFetch) before drafting — the substance of a link-post lives
          // in the asset, and an angle grounded in it beats one guessed from
          // the teaser. Untrusted third-party content, like the post body.
          externalLinks: extractExternalLinks(post),
        }
      : null,
    // Post-specific, verified posts only: the full read the verify phase
    // judged. Draft FROM this, never from the preview — the play says how to
    // join, alreadySaid what not to repeat, and a few comments with whether
    // the author answered them.
    research: research
      ? {
          play: research.play,
          playGuidance: PLAY_GUIDANCE[research.play],
          fullText: research.thread.fullText,
          mediaText: research.thread.mediaText ?? null,
          counts: research.thread.counts,
          authorReplyRate: research.authorReplyRate,
          alreadySaid: research.alreadySaid,
          author: research.author
            ? {
                headline: research.author.headline ?? null,
                about: research.author.about ?? null,
                currentRole: research.author.currentRole ?? null,
                toneSample: authorToneSample,
              }
            : null,
          exampleComments: research.thread.comments.slice(0, 5).map((comment) => ({
            authorName: comment.authorName ?? null,
            authorHeadline: comment.authorHeadline ?? null,
            text: comment.text,
            reactions: comment.reactions,
            authorReplied: comment.authorReplied,
            authorReplyText: comment.authorReplyText ?? null,
          })),
          moves: ASSIST_MOVES.filter((move) => move !== "answer_room" || canAnswerRoom(room)),
          ...(room ? { room } : {}),
        }
      : null,
    // The owner's stories (Brain notes in the stories slot, or tagged
    // owner_story): the only personal experiences a draft may claim.
    ownerStories: ownerStories.map((story) => ({
      id: story.id,
      title: story.title,
      content: story.content,
      spentToday: story.spent,
    })),
    // Post-specific, for an author with history: what already passed between
    // the account and them — our comments and replies that went out, their
    // replies, where the connection stands. The comment is a follow-up: the
    // systemPrompt says how one is written. Absent for a first touch.
    ...(followUp ? { followUp } : {}),
    // Post-specific: who you're replying to (audience size can shape tone).
    author: post
      ? {
          name: post.authorName,
          headline: post.authorHeadline,
          followers: post.authorFollowers,
          connections: post.authorConnections,
        }
      : null,
    exemplars: cc.exemplars,
    // The owner's own captured comments, newest first — already rendered into
    // systemPrompt as few-shot register evidence; surfaced raw for agents that
    // compose their own prompt. Empty when the org has no samples yet.
    voiceSamples: voiceSampleTexts,
    recentComments: await recentCommentTexts(tx),
    styleDirective: cc.picked?.block ?? null,
    systemPrompt,
    outputRules: {
      // Invariants — never voice-dependent.
      invariants: {
        plainTextOnly: false,
        noMarkdown: false,
        noRawUrls: false,
        outputOnlyTheComment: true,
      },
      // The voice's resolved register rules — validate drafts against
      // THESE, not hardcoded assumptions.
      style: cc.styleRules,
    },
    // Per-post: obey this tier (it's the server's own seeded decision for
    // this post). Campaign-level auto: allocate tiers across the batch per
    // lengthPlan — fill under-represented tiers first, promo ≥ medium, and
    // do NOT normalize lengths across the batch. `maxWords` is the hard cap
    // (skill ≥3.2.0 reads it here; it lived under outputRules before).
    lengthDecision: {
      tier: cc.lengthDecision.tier,
      mode: cc.lengthDecision.mode,
      factors: cc.lengthDecision.factors,
      rule: spec.rule,
      maxWords: null,
      preferredMaxWords: spec.maxWords,
    },
    lengthPlan:
      cc.lengthDecision.mode === "auto"
        ? { targetDistribution: LENGTH_TARGET_DISTRIBUTION, recentTiers }
        : null,
    // Self-check contract: score each draft against the rubric bands, then
    // rewrite until score < rejectThreshold. Strictness is per-post when a
    // discoveredPostId was given (jittered by design), campaign-base otherwise.
    slop: {
      mode: cc.slopDecision.mode,
      strictness: cc.slopDecision.strictness,
      rejectThreshold: Math.min(0.7, rejectThreshold(cc.slopDecision.strictness)),
      // The exact per-item systemPrompt is beside this rubric. Refer to it
      // instead of duplicating a full prompt in every prepared-context item.
      rubric: writingCompliancePrompt("Use this item's systemPrompt as the effective instruction set. Apply its source priorities and general rules to this item only."),
      // Legacy fields remain readable, without an independent editorial veto.
      deterministicFloor: 0,
      patterns: [],
    },
    // Fact-checked drafting: when enabled, use YOUR OWN web-search tools and
    // follow the instructions exactly (same contract the server writer gets).
    webFacts: {
      enabled: campaign.webFacts,
      ratio: campaign.webFactsRatio,
      recentShare: campaign.webFacts
        ? await recentFactsShare(tx, campaign.id)
        : null,
      applyToThisDraft: post ? cc.webFactsOn : null,
      instructions: campaign.webFacts ? WEB_FACTS_INSTRUCTIONS : null,
    },
  });
}

export type ClientCommentDraftInput = {
  discoveredPostId: number;
  text: string;
  commentType?: "promo" | "neutral";
  lengthTier?: "ultra_short" | "short" | "medium" | "long";
  lengthWhy?: string;
  slopSelfScore?: number;
  slopStrictness?: number;
  rationale?: string;
  webSearched?: boolean;
  sources?: { url: string; title?: string; date?: string }[];
  /** The owner story the draft tells, when it tells one: advice backed by the
   *  owner's own documented experience is not an unsolicited tip. */
  ownerStoryId?: number | null;
  /** The agent judged the post sensitive: the draft waits for a yes at any mode. */
  sensitivityHold?: boolean;
};

export type SubmitCommentDraftBatchInput = {
  drafts: ClientCommentDraftInput[];
  model?: string;
};

export async function submitCommentDraftBatch(
  tx: Tx,
  campaign: Campaign,
  input: SubmitCommentDraftBatchInput,
  options: ClientIntakeOptions,
) {
  const { drafts, model } = input;
  const campaignId = campaign.id;
  if (options.resolveStepMode) {
    await tx.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.id, campaignId)).for("share");
    if (campaign.channelId !== null) await tx.select({ id: channels.id }).from(channels).where(eq(channels.id, campaign.channelId)).for("share");
  }
  await lockCommentDraftIntake(tx, campaignId);
  await lockCommentDraftCandidateRows(
    tx,
    campaignId,
    drafts.map((draft) => draft.discoveredPostId),
  );
  // An interactive agent draft is admitted only by the server-derived pair of
  // flags below. Its mode is resolved separately before anything is written.
  // A runner or legacy wire caller cannot claim either authority as input.
  if (
    options.authoredByOwner !== true &&
    options.worker?.workerAuthored !== true &&
    !(options.explicitUserDirected === true && options.resolveStepMode === true)
  ) {
    return intakeError(
      `campaign ${campaignId} — this batch claims no author: only owner-authored drafts or a worker run can supply this batch`,
      {
        code: "unsupported_public_campaign_flow",
        status: 409,
        recovery:
          "A draft must claim an author or a worker run. Engager still wants your drafting — it just refuses unattributed queued supply. Offer angles or a draft to the owner in chat, or let a worker run produce the batch.",
      },
    );
  }
  // The owner's own words kept as a proposal wait for their yes whatever the
  // target is doing: Pause only stops new runs, and nothing leaves until they
  // approve it. An archived target takes nothing.
  const runtimeError = await supportedCampaignError(tx, campaign, {
    press: options.pausedPress,
    requireActive: !(options.authoredByOwner === true && options.forceProposal && campaign.status === "paused"),
  });
  if (runtimeError) return runtimeError;

  // THE STRICT DRAFTING SPLIT IS GONE, and what replaced it is a switch rather
  // than a mode. It refused client drafts on a server-led campaign because two
  // drafters would contend for the same posts and double the voice — but there
  // is one drafter now: the owner's own agent. The worker's writing is a STEP
  // on an Ambassador, and an Ambassador with its write step off writes nothing at
  // all, so the contention this guarded against is unrepresentable rather than
  // merely unlikely (T-8.13, correction 1).

  // Abuse guard for the unmetered-by-Engager path: rolling-day intake cap.
  const cap = config.mcpSubmitsPerDay;
  if (cap > 0) {
    const [usage] = await tx.select({ n: sql<number>`count(*)::int` }).from(messages)
      .where(and(eq(messages.loopVersion, "client"), sql`${messages.createdAt} >= ${Date.now() - 86_400_000}`));
    const used = usage?.n ?? 0;
    if (used + drafts.length > cap) {
      return intakeError(
        `daily client-submit cap reached (${used}/${cap} used, batch of ${drafts.length} rejected) — try again tomorrow or submit a smaller batch`,
      );
    }
  }

  // The server knows which voice it handed the client (get_drafting_context
  // always serves the campaign's comment-channel voice) — stamp it, no
  // client input needed; the intake lint verifies against the same rules.
  const profRow = await getProfile(tx);
  const voiceResolved = await resolveCampaignVoice(
    tx,
    campaign,
    profRow,
    "comment",
  );
  const voiceTrace = {
    channel: "comment",
    source: voiceResolved.persona?.trim()
      ? voiceResolved.sources.join("+")
      : "campaign_fallback",
    ...(voiceResolved.voiceId != null
      ? { voiceId: voiceResolved.voiceId }
      : {}),
    resolvedFrom: voiceResolved.resolvedFrom,
  };
  const styleRules = voiceResolved.styleRules;

  // The owner's words are their approval; agent words use the effective step
  // mode, and worker-run words use the run's server-derived publish switch.
  const strategy = options.resolveStepMode ? await readCampaignStrategy(tx, campaign.id) : null;
  const action = strategy?.strategy.status === "active" ? strategy.actions.find(row => row.stored === "publish_comment") : undefined;
  if (options.resolveStepMode && (!action || action.effective === "off")) {
    return intakeError("The comment step is Off.", { code: "mode_off", status: 409 });
  }
  const batchStatus = submitStatus(
    drafts.some((draft) => draft.sensitivityHold === true),
    options.forceProposal,
    options.authoredByOwner === true
      ? "auto"
      : options.resolveStepMode
        ? action?.effective === "auto" ? "auto" : "manual"
      : options.worker
        ? options.worker.publish
          ? "auto"
          : "manual"
        : undefined,
  );
  type ItemResult =
    | {
        discoveredPostId: number;
        messageId: number | null;
        alreadyExisted: boolean;
        redrafted?: boolean;
        status: string;
        /** Persisted send slot (ISO) — assigned when the draft goes straight
         *  to approved. Absent for proposed/held/deduped drafts. */
        scheduledAt?: string;
        /** Server-verified intake warnings (over-cap / mechanical lint) —
         *  informational; the draft was still accepted. */
        warnings?: string[];
      }
    | {
        /** Hard-rejected by the deterministic slop gate — NOT stored. The
         *  `error` field carries a human summary (old agents parse it);
         *  `violations` is the machine-readable redraft target. */
        discoveredPostId: number;
        error: string;
        rejected: true;
        violations: { rule: string; detail: string }[];
      }
    | {
        /** Not written: its author is held (`people/draftHolds.ts`), and the
         *  post stays a match for a later run. */
        discoveredPostId: number;
        error: string;
        held: DraftHold["kind"];
      }
    | { discoveredPostId: number; error: string };
  const items: ItemResult[] = [];
  // A worker's drafts carry the owner's signatures and rare moves at
  // about the owner's rate: each is judged against the campaign's newest agent
  // drafts — less the ones this batch replaces — and this batch's own earlier
  // drafts, newest first.
  const signatureWindow = options.worker?.workerAuthored
    ? await recentAgentDrafts(tx, campaignId, {
        excludePostIds: drafts.map((draft) => draft.discoveredPostId),
      })
    : null;
  // What an agent's draft is read against before it is accepted: the owner's
  // stories, to know which one it tells, and the words the account has said
  // lately, to refuse a repeat of them. The owner's own words are neither
  // attributed nor refused.
  const owned = options.authoredByOwner ? [] : await listOwnerStories(tx, Date.now());
  const said = options.authoredByOwner ? [] : await sentTexts(tx, Date.now());
  const saidInBatch: string[] = [];
  let submitted = 0;
  // Approved inserts are slotted AFTER the loop, and queued as actions once they
  // have one: one jittered lane walk for the whole batch instead of N racing ones.
  const toSlot: {
    messageId: number;
    targetPostedAt: number | null;
    itemIndex: number;
  }[] = [];

  // Consume the candidate once a message exists for it (created OR resolved
  // already-existing), so it leaves the selectable pool.
  const consumeDraftedCandidate = async (post: {
    id: number;
    status: DiscoveredPost["status"];
  }) => {
    await tx
      .update(discoveredPosts)
      .set({ status: "drafted" })
      .where(eq(discoveredPosts.id, post.id));

  };

  const [roomAccount] = campaign.channelId == null ? [] : await tx.select().from(channels)
    .where(eq(channels.id, campaign.channelId));
  if (roomAccount?.externalAccountId) await lockRoomVoice(tx, { accountProfileId: roomAccount.externalAccountId });

  for (const draft of drafts) {
    const authoredText = AuthoredTextSchema.safeParse(draft.text);
    if (!authoredText.success) {
      const detail = authoredText.error.issues[0]?.message ?? "invalid text";
      items.push({
        discoveredPostId: draft.discoveredPostId,
        error: `rejected by text boundary: ${detail}`,
        rejected: true,
        violations: [{ rule: "text_boundary", detail }],
      });
      continue;
    }
    const text = authoredText.data;
    const [post] = await tx
      .select()
      .from(discoveredPosts)
      .where(eq(discoveredPosts.id, draft.discoveredPostId));
    if (!post) {
      items.push({
        discoveredPostId: draft.discoveredPostId,
        error: "not found",
      });
      continue;
    }
    if (post.campaignId !== campaign.id) {
      items.push({
        discoveredPostId: draft.discoveredPostId,
        error: `belongs to campaign ${post.campaignId}, not ${campaign.id}`,
      });
      continue;
    }

    const room = roomAccount?.externalAccountId ? { channelId: roomAccount.id,
      accountProfileId: roomAccount.externalAccountId, postUrn: post.postUrn } : null;
    const status = batchStatus === "approved" && options.authoredByOwner !== true && room &&
      await roomVoiceTaken(tx, room, Date.now()) ? "proposed" : batchStatus;

    const key = dedupeKey("comment", campaign.id, post.postUrn);
    const durableRequest = options.durableRequests?.get(post.id);
    const [existingMessage] = await tx
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.kind, "comment"),
          eq(messages.discoveredPostId, post.id),
        ),
      )
      .for("update");
    const replay = await replayedRedraft(tx, durableRequest);
    if (replay) {
      items.push({
        discoveredPostId: post.id,
        messageId: replay.messageId,
        alreadyExisted: true,
        redrafted: true,
        status: "proposed",
      });
      continue;
    }
    const hasActiveRedraft = existingMessage?.redraftRequestId != null;
    const exactDurableRedraft =
      existingMessage != null &&
      exactMessageRequest(durableRequest, existingMessage);
    if (durableRequest && (!existingMessage || !exactDurableRedraft)) {
      items.push({
        discoveredPostId: post.id,
        error: "stale durable draft request",
      });
      continue;
    }
    const redraftAuthorized =
      hasActiveRedraft &&
      (options.explicitUserDirected === true || exactDurableRedraft);

    // Hard slop gate (config.intakeSlopGate, default on): reject drafts that
    // hit a deterministic invariant — markdown/URL, a stop-slop AI-tell
    // pattern, or a gateable register rule (em-dash/semicolon/emoji, an
    // ANCHORED banned opener). AI-tell patterns are served via
    // get_drafting_context. An already-accepted duplicate still resolves
    // alreadyExisted first, so a crashed runner resubmitting after a
    // rules-tightening deploy keeps its resume semantics. Everything else
    // stays a warning below.
    // The gate exists to stop AI-sounding drafts. Text the OWNER wrote is not
    // a draft to be judged — rejecting their own sentence for an em dash would
    // be both wrong and insulting, and their wording is exactly what the voice
    // is supposed to learn from.
    // The story it tells: the one it names, else the one its words tell.
    const story = options.authoredByOwner
      ? null
      : storyTold(owned, { text, ownerStoryId: draft.ownerStoryId });
    const storyColumn = options.authoredByOwner ? {} : { ownerStoryId: story?.id ?? null };
    const gateViolations = options.authoredByOwner
      ? []
      : intakeGateViolations(text, styleRules, {
          ownerStory: draft.ownerStoryId != null || story != null,
          // A draft already accepted is not a repeat of itself, and words the
          // owner asked for are not refused for repeating.
          ...(options.ownerRequested
            ? {}
            : { sent: [
                ...said.filter((row) => row.messageId !== existingMessage?.id).map((row) => row.text),
                ...saidInBatch,
              ] }),
        });
    if (gateViolations.length > 0 && config.intakeSlopGate) {
      if (existingMessage && !redraftAuthorized) {
        await consumeDraftedCandidate(post);
        items.push({
          discoveredPostId: post.id,
          messageId: existingMessage.id,
          alreadyExisted: true,
          status,
        });
        continue;
      }
      items.push({
        discoveredPostId: post.id,
        error: `rejected by slop lint: ${gateViolations[0]!.detail}`,
        rejected: true,
        violations: gateViolations,
      });
      continue;
    }
    signatureWindow?.unshift(text);
    if (!options.authoredByOwner) saidInBatch.push(text);

    // Trace: declared fields are self-reported (never trusted); verified
    // fields are recomputed HERE — word count, tier-by-words, cap check
    // against the declared (else measured) tier, and a cheap lint: the
    // invariant floor (markdown/URL), the stop-slop
    // AI-tell patterns (slopPatterns.ts), and the voice-aware register
    // lint. Regex-only by construction (no server LLM at intake).
    // Warnings only — intake never gates.
    const wordCount = countWords(text);
    const measuredTier = tierByWordCount(wordCount);
    const capTier = draft.lengthTier ?? measuredTier;
    const lint = [
      ...mechanicalViolations(text),
    ];
    const declared =
      draft.lengthTier != null ||
      draft.lengthWhy != null ||
      draft.slopSelfScore != null ||
      draft.slopStrictness != null ||
      draft.rationale != null
        ? {
            lengthTier: draft.lengthTier,
            lengthWhy: draft.lengthWhy,
            slopSelfScore: draft.slopSelfScore,
            slopStrictness: draft.slopStrictness,
            rationale: draft.rationale?.trim() || undefined,
          }
        : undefined;
    // http/https only — z.string().url() also admits other schemes.
    const sources = (draft.sources ?? []).filter((s) =>
      /^https?:\/\//i.test(s.url),
    );
    const trace: DraftTrace = {
      v: 1,
      source: "client",
      voice: voiceTrace,
      ...(draft.webSearched || sources.length > 0
        ? {
            facts: {
              enabled: true,
              searched: sources.length,
              sources: sources.length > 0 ? sources : undefined,
              declaredByClient: true,
            },
          }
        : {}),
      client: {
        declared,
        verified: {
          wordCount,
          tierByWords: measuredTier,
          withinCap: true,
          lint: lint.length > 0 ? lint : undefined,
        },
      },
    };

    // The owner's own words over a draft they skipped (`rejected`, never
    // posted): that draft's row is the one row the post can hold
    // (`messages_org_discovered_post_unq`), so it becomes the owner's, its
    // draft kept on the revision history. Anything else on the post already
    // answered it.
    if (existingMessage?.status === "rejected" && options.authoredByOwner === true) {
      const [retaken] = await tx
        .update(messages)
        .set({
          proposedText: text,
          finalText: null,
          status,
          scheduledAt: null,
          error: null,
          postingStartedAt: null,
          commentType: draft.commentType ?? existingMessage.commentType,
          promptVersionId: null,
          model: model ?? "client",
          loopVersion: "client",
          trace,
          publishOrigin: publishOriginFor(options),
          redraftRequestId: null,
          redraftRequestVersion: existingMessage.redraftRequestVersion + 1,
          redraftRequestedAt: null,
          redraftRequestedBy: null,
          redraftRequestNote: null,
        })
        .where(
          and(
            eq(messages.id, existingMessage.id),
            eq(messages.status, "rejected"),
            eq(messages.redraftRequestVersion, existingMessage.redraftRequestVersion),
          ),
        )
        .returning({ id: messages.id });
      if (!retaken) {
        items.push({ discoveredPostId: post.id, error: "the skipped draft changed while the comment was saved" });
        continue;
      }
      submitted++;
      await consumeDraftedCandidate(post);
      items.push({ discoveredPostId: post.id, messageId: retaken.id, alreadyExisted: false, status });
      if (status === "approved") {
        toSlot.push({ messageId: retaken.id, targetPostedAt: post.postedAt, itemIndex: items.length - 1 });
      }
      continue;
    }

    if (existingMessage && redraftAuthorized) {
      const [redrafted] = await tx
        .update(messages)
        .set({
          proposedText: text,
          finalText: null,
          status: "proposed",
          scheduledAt: null,
          error: null,
          postingStartedAt: null,
          commentType: draft.commentType ?? existingMessage.commentType,
          promptVersionId: null,
          model: model ?? "client",
          loopVersion: "client",
          trace,
          // The story these words tell, not the one the replaced ones did.
          ...storyColumn,
          // Whose words these are now, not whose the replaced ones were: an
          // owner-written row redrafted by an agent is an agent's volume, and
          // the caps bind it.
          publishOrigin: publishOriginFor(options),
          redraftRequestId: null,
          redraftRequestedAt: null,
          redraftRequestedBy: null,
          redraftRequestNote: null,
        })
        .where(
          and(
            eq(messages.id, existingMessage.id),
            eq(messages.status, existingMessage.status),
            eq(
              messages.redraftRequestVersion,
              existingMessage.redraftRequestVersion,
            ),
            eq(messages.redraftRequestId, existingMessage.redraftRequestId!),
          ),
        )
        .returning({ id: messages.id });
      if (!redrafted) {
        items.push({
          discoveredPostId: post.id,
          error: "stale durable draft request",
        });
        continue;
      }
      submitted++;
      await consumeDraftedCandidate(post);
      items.push({
        discoveredPostId: post.id,
        messageId: redrafted.id,
        alreadyExisted: false,
        redrafted: true,
        status: "proposed",
      });
      continue;
    }

    // A worker's new draft is person-aware (`people/draftHolds.ts`): none for
    // someone a decision already waits on — this batch's own earlier draft
    // for them included — or whose allowance is spent. The worker's selection
    // left them out; this is the same rule where the row is written. A draft
    // the owner asked for by name is theirs.
    if (
      options.worker?.workerAuthored === true &&
      !existingMessage &&
      post.status !== "draft_requested" &&
      post.authorProfileId
    ) {
      const hold = await draftHoldFor(tx, campaign.channelId, post.authorProfileId, Date.now());
      if (hold) {
        items.push({ discoveredPostId: post.id, error: draftHoldNote(hold), held: hold.kind });
        continue;
      }
    }

    const [inserted] = await tx
      .insert(messages)
      .values({
        kind: "comment",
        campaignId: campaign.id,
        publishOrigin: publishOriginFor(options),
        // Only a row this batch INSERTED gets stamped. The `alreadyExisted`
        // resolve below deliberately does not: that row was written by an
        // earlier act, and re-stamping it would let a run claim authorship of
        // work it merely counted.
        workerRunId: options.worker?.runId ?? null,
        discoveredPostId: post.id,
        targetProfileId: post.authorProfileId,
        commentType: draft.commentType ?? "neutral",
        proposedText: text,
        status,
        dedupeKey: key,
        promptVersionId: null,
        model: model ?? "client",
        loopVersion: "client",
        ...storyColumn,
        // Snapshot for Gate 2 post-ordering, same as the server pipeline.
        betScoreAtPost: post.betScore ?? null,
        trace,
      })
      .onConflictDoNothing()
      .returning({ id: messages.id });

    const existing =
      inserted ??
      (
        await tx
          .select({ id: messages.id })
          .from(messages)
          .where(eq(messages.dedupeKey, key))
      )[0];

    // Idempotent on the dedupe path too: the candidate leaves the selectable
    // pool whether this call created the message or resolved a pre-existing one.
    await consumeDraftedCandidate(post);

    if (inserted) submitted++;
    const warnings: string[] = [];
    if (!trace.client!.verified!.withinCap) {
      warnings.push(
        `over length cap: ${wordCount} words > ${lengthSpecForTier(capTier).maxWords} (${capTier})`,
      );
    }
    for (const l of lint) warnings.push(`lint: ${l}`);
    items.push({
      discoveredPostId: post.id,
      messageId: existing?.id ?? null,
      alreadyExisted: !inserted,
      status,
      warnings: warnings.length > 0 ? warnings : undefined,
    });
    if (inserted && status === "approved") {
      toSlot.push({
        messageId: inserted.id,
        targetPostedAt: post.postedAt,
        itemIndex: items.length - 1,
      });
    }
  }

  if (toSlot.length > 0) {
    const slots = await assignSlots(tx, {
      campaign,
      origin: publishOriginFor(options),
      items: toSlot.map(
        (s): SlotItem => ({
          messageId: s.messageId,
          kind: "comment",
          targetPostedAt: s.targetPostedAt,
        }),
      ),
    });
    for (let i = 0; i < toSlot.length; i++) {
      const slot = slots[i]!;
      const entry = toSlot[i]!;
      const item = items[entry.itemIndex]!;
      // The owner's save is the comment's yes; a step's at Automatic has none. A
      // comment the ledger refuses waits for the owner instead, its reason on it.
      const queued = await queueComment(tx, entry.messageId, options.authoredByOwner === true ? { by: "owner:save" } : null);
      if (!("status" in item)) continue;
      if (!queued) {
        item.status = "proposed";
        continue;
      }
      item.scheduledAt = new Date(slot.scheduledAt).toISOString();
      if (slot.willAgeOut) {
        (item.warnings ??= []).push(
          "slot falls past the campaign's maxPostAgeDays for this post — the comment will land stale; move it earlier or drop it",
        );
      }
    }
  }

  const rejected = items.filter((i) => "rejected" in i && i.rejected).length;
  const hasProposals = items.some((item) => "status" in item && item.status === "proposed");
  const hasScheduled = items.some((item) => "status" in item && item.status === "approved");
  const status = hasProposals ? "proposed" : batchStatus;
  const baseNote =
    hasProposals && hasScheduled
      ? "Some drafts await approval; scheduled items carry their own send slot. Review each item's status."
      : status === "approved"
        ? "scheduled — each item carries its persisted send slot (scheduledAt, jittered spacing). Pacing keys on ORIGIN: a worker's own output takes caps and active-hours; a comment the owner wrote themselves is spaced by the minimum gap only"
        : "awaiting approval — use decide or the Engager app";
  return intakeSuccess({
    submitted,
    alreadyExisted: items.filter(
      (i) => "alreadyExisted" in i && i.alreadyExisted,
    ).length,
    rejected,
    errors: items.filter((i) => "error" in i).length,
    status,
    items,
    note:
      rejected > 0
        ? `${baseNote}. ${rejected} draft(s) hard-rejected by the deterministic slop lint — redraft each against its \`violations\` and resubmit ONLY those items.`
        : baseNote,
  });
}

export type SaveOwnerCommentOutcome =
  | { kind: "duplicate"; messageId: number; status: string }
  | {
      kind: "intake";
      result: Awaited<ReturnType<typeof submitCommentDraftBatch>>;
      messageId: number | null;
      /** Frozen corpus verdict for the captured voice sample — whether this
       *  save teaches the voice. Null when no message row landed (nothing was
       *  captured on this path). The dashboard's own-comment box renders its
       *  calibration moment from this instead of overclaiming. */
      sampleEligible: boolean | null;
      /** The draft the fit metric was measured against — for the caller's
       *  best-effort post-commit embedding second opinion. Null when no draft
       *  was offered or no message row landed. */
      draftFitText: string | null;
    };

/**
 * Of two measures of one save, against the drafts and angles the candidate
 * was delivered and against words offered in the box it was saved from, the
 * one that kept more. A save has three, folded in two at a time: the
 * candidate's, the words the page sent (`assistTexts`), and every angle the
 * box kept (`composerFor`). The words the owner kept more of govern, so words
 * offered in the box are never forgiven because the candidate was offered
 * less. A box's words carry no revision, story or fit, so a box measure that
 * wins carries none.
 */
type CommentAuthorship = {
  assistRetention: number | null; assistDraftRevision: number | null; ownerOrigin: number | null;
  draftFitDistance: number | null; draftFitText: string | null; draftFitStoryId: number | null;
} | null;

function boxedAuthorship(
  delivered: CommentAuthorship,
  boxed: ReturnType<typeof measureBoxAssist>,
): CommentAuthorship {
  if (boxed === null || (delivered?.assistRetention ?? -1) >= boxed.assistRetention) return delivered;
  return {
    assistRetention: boxed.assistRetention,
    assistDraftRevision: null,
    ownerOrigin: boxed.ownerOrigin,
    draftFitDistance: null,
    draftFitText: null,
    draftFitStoryId: null,
  };
}

/**
 * The owner saved their own comment on one candidate — shared by the MCP card
 * tool and the dashboard's own-comment box so both surfaces behave identically.
 *
 * Every save goes through the owner-authored intake: authorship is frozen on
 * the row and the text is kept as a voice sample. Save = send (founder
 * decision 2026-07-29): the owner writing it IS the approval, so the row lands
 * approved and takes the nearest min-gap slot. No campaign column decides
 * that — authorship does. Words that are their agent's draft for the box,
 * untouched, are approved the same way and go out as the agent's
 * (`agentWords`): capped, never learned. On a PAUSED campaign the words are
 * kept as a proposal, which waits for the owner's yes (the deck says so,
 * `ownerCommentMode`); an archived target is refused upstream.
 */
export async function saveOwnerComment(
  tx: Tx,
  campaign: Campaign,
  input: {
    discoveredPostId: number;
    text: string;
    /** Words their agent wrote for the box this was saved from, and what the
     *  owner had typed before them (`inbox/agent-words.tsx`): offered words
     *  the save is measured against beside the candidate's own drafts. */
    assistTexts?: readonly string[];
    ownerWords?: readonly string[];
    /** The box the words were drafted in, where it is not the post's own: a
     *  lead's opener box, every text of which counts as offered. */
    box?: string;
  },
): Promise<SaveOwnerCommentOutcome> {
  const { discoveredPostId, text } = input;
  await assertJudgedWords(tx, text);
  // One comment per candidate: posted, on its way, or a draft still waiting.
  // Replacing a waiting draft with the owner's words is a draft decision,
  // and silently discarding their text because a draft already exists would be
  // worse than refusing. A draft the owner skipped is no comment of ours: the
  // one row a post can hold (`messages_org_discovered_post_unq`) is theirs to
  // take up, which the intake does.
  const [existing] = await tx
    .select({ id: messages.id, status: messages.status })
    .from(messages)
    .where(
      and(
        eq(messages.kind, "comment"),
        eq(messages.discoveredPostId, discoveredPostId),
      ),
    )
    .limit(1);
  if (existing && existing.status !== "rejected") {
    return {
      kind: "duplicate",
      messageId: existing.id,
      status: existing.status,
    };
  }
  // Freeze authorship at the moment of the human act, against the drafts this
  // candidate was actually offered and the wording the owner supplied, through
  // the same shared window the card scores live, and against everything its
  // box ever offered. Null when nothing was ever drafted here — their words by
  // construction.
  const offered = [
    ...(await composerOffered(tx, boxKey({ kind: "comment", discoveredPostId }))),
    ...(input.box ? await composerOffered(tx, input.box) : []),
  ];
  const measured = boxedAuthorship(
    boxedAuthorship(null, measureBoxAssist(text, input.assistTexts, input.ownerWords)),
    measureComposer(text, offered, input.ownerWords),
  );
  const ratios = {
    assistRetention: measured?.assistRetention ?? null,
    ownerOrigin: measured?.ownerOrigin ?? null,
  };
  const voiceRow = await getVoiceForCampaign(tx, campaign);
  // A comment kept from a draft that told a story tells it too, and spends it
  // for the day.
  const storyTold =
    measured?.draftFitStoryId != null &&
    measured.draftFitDistance != null &&
    measured.draftFitDistance <= STORY_KEPT_MAX_DISTANCE;
  const sampleInput = {
    text,
    source: ownerSampleSource(ratios),
    ...ratios,
    campaignId: campaign.id,
    discoveredPostId,
    voiceId: voiceRow?.voice.id ?? null,
    // How the owner changed the draft (spec 7), against the one closest to
    // what they saved. A comment written over it from scratch still shows
    // which of the draft's moves they cut; the sentence-level dimensions skip
    // what no draft sentence became.
    editSignals:
      measured?.draftFitText
        ? extractEditSignals(measured.draftFitText, text, {
            storyRemoved: measured.draftFitStoryId != null && !storyTold,
          })
        : null,
  };

  const result = await submitCommentDraftBatch(
    tx,
    campaign,
    { drafts: [{ discoveredPostId, text }], model: OWNER_AUTHORED_MODEL },
    {
      // Save = send on a campaign that runs; on a paused one the words wait for
      // the owner's yes, as a reply's do (`ownerCommentMode`).
      forceProposal: ownerCommentMode(campaign) === "proposal",
      explicitUserDirected: true,
      authoredByOwner: true,
      // Their agent's words, queued as they were: the press approves them.
      // Words the owner had typed before the agent's came stay theirs.
      agentWords:
        isUntouchedOffer(text, [...offered, ...(input.assistTexts ?? [])]) &&
        isAssisted(measured?.assistRetention, measured?.ownerOrigin),
    },
  );
  const messageId = result.ok
    ? ((result.data as { items?: Array<{ messageId?: number }> }).items?.[0]
        ?.messageId ?? null)
    : null;
  let sampleEligible: boolean | null = null;
  if (messageId != null) {
    await tx
      .update(messages)
      .set({
        assistRetention: measured?.assistRetention ?? null,
        assistDraftRevision: measured?.assistDraftRevision ?? null,
        ownerOrigin: measured?.ownerOrigin ?? null,
        draftFitDistance: measured?.draftFitDistance ?? null,
        ownerStoryId: storyTold ? measured.draftFitStoryId : null,
      })
      .where(eq(messages.id, messageId));
    trackOwnerSave({ for: "comment", retention: measured?.assistRetention, characters: text.length }, tx);
    const sample = await captureVoiceSample(tx, { ...sampleInput, messageId });
    sampleEligible = sample.eligible;
    // A measured save moves what the voice has learned about editing. A
    // write may create the default voice it is stored on.
    if (sample.id != null && sampleInput.editSignals) {
      await learnFromSave(tx, sampleInput.voiceId);
    }
  }
  return {
    kind: "intake",
    result,
    messageId,
    sampleEligible,
    draftFitText: messageId != null ? (measured?.draftFitText ?? null) : null,
  };
}

export type SaveOwnerReplyOutcome =
  | {
      kind: "saved";
      messageId: number;
      status: "approved" | "proposed" | "suppressed_dryrun";
      scheduledAt: number | null;
    }
  /** The reply moved on before the press — answered elsewhere, or with its
   *  reply already on its way. Nothing changed. */
  | { kind: "answered"; status: IncomingComment["status"] }
  | { kind: "refused"; error: string; recovery?: string };

/**
 * The campaign a reply goes out under: its own, or — for a reply that came in
 * under none, on the owner's own post — the account's first active one.
 * Undefined when there is neither, and then nothing can send it.
 */
export async function replyCampaign(
  tx: Tx,
  reply: { campaignId: number | null },
  opts: { lock?: boolean } = {},
): Promise<Campaign | undefined> {
  const query = tx
    .select()
    .from(campaigns)
    .where(reply.campaignId == null ? eq(campaigns.status, "active") : eq(campaigns.id, reply.campaignId))
    .orderBy(campaigns.id)
    .limit(1);
  const [campaign] = opts.lock ? await query.for("share") : await query;
  return campaign;
}

/**
 * What saving the owner's own COMMENT does, for the deck to say before it is
 * pressed and for {@link saveOwnerComment} to do: send while the campaign runs,
 * and wait for their yes on a Paused one — Pause only stops new runs, so the
 * words are kept rather than refused, but nothing leaves unseen (founder rule,
 * 2026-10-15).
 */
export function ownerCommentMode(campaign: Pick<Campaign, "status">): "send" | "proposal" {
  return campaign.status === "active" ? "send" : "proposal";
}

/**
 * What saving the owner's own reply does, for a box to say before it is
 * pressed and for {@link saveOwnerReply} to do: send while the campaign it
 * goes out under ({@link replyCampaign}) runs and the account may write to
 * LinkedIn, and otherwise wait for a yes — as it does where there is no campaign to send under at all.
 */
export function ownerReplyMode(
  campaign: Pick<Campaign, "status"> | undefined,
  writesEnabled: boolean,
): "send" | "proposal" {
  if (!writesEnabled || campaign === undefined) return "proposal";
  return isSupportedPublicCampaignRuntime(campaign) ? "send" : "proposal";
}

/**
 * The owner's saved reply, kept as a reply sample of the voice its campaign
 * writes in. It is measured against every word an agent offered for it — in
 * the box, or as the draft that waited — so a save that kept most of them is
 * an approval and teaches the voice nothing (`ownerAuthoredSample`). Words
 * written with nothing offered are theirs by construction. What it changed of
 * a draft is kept with it, and the reply channel's habits roll up from it.
 */
async function captureOwnerReply(
  tx: Tx,
  input: {
    text: string;
    messageId: number;
    campaignId: number | null;
    discoveredPostId: number | null;
    draft: string | null;
    assistTexts?: readonly string[];
    ownerWords?: readonly string[];
    /** Everything the reply's box ever offered (`composerFor`). */
    boxOffered: readonly string[];
  },
): Promise<void> {
  // The waiting draft first: the window the measure reads is bounded, and a
  // box full of the dock's words must never push the draft out of it.
  const offered = [...(input.draft ? [input.draft] : []), ...(input.assistTexts ?? [])];
  const measured = higherRetention(
    measureBoxAssist(input.text, offered, input.ownerWords),
    measureComposer(input.text, input.boxOffered, input.ownerWords),
  );
  const voiceId = await campaignVoiceId(tx, input.campaignId);
  const editSignals = input.draft ? extractEditSignals(input.draft, input.text) : null;
  const sample = await captureVoiceSample(tx, {
    text: input.text,
    source: "owner_reply",
    assistRetention: measured?.assistRetention ?? null,
    ownerOrigin: measured?.ownerOrigin ?? null,
    voiceId,
    messageId: input.messageId,
    campaignId: input.campaignId,
    discoveredPostId: input.discoveredPostId,
    editSignals,
  });
  if (sample.id != null && editSignals) await learnFromSave(tx, voiceId);
}

/** The record a Don't reply leaves on a reply for its Undo (`dontReply`). */
type DismissalRecord = Pick<
  IncomingComment,
  "dismissedAt" | "dismissedFrom" | "dismissedReplyId" | "dismissedReplyVersion" | "dismissedBy"
>;

/** No Don't reply on record. */
const NOT_DISMISSED: DismissalRecord = {
  dismissedAt: null,
  dismissedFrom: null,
  dismissedReplyId: null,
  dismissedReplyVersion: null,
  dismissedBy: null,
};

/** Moves a reply between two states, only from the one it was read in, and
 *  sets the Don't reply record the new state holds. */
async function setIncomingStatus(
  tx: Tx,
  id: number,
  from: IncomingComment["status"],
  to: IncomingComment["status"],
  record: DismissalRecord,
): Promise<void> {
  await tx
    .update(incomingComments)
    .set({
      status: to,
      dismissedAt: record.dismissedAt,
      dismissedFrom: record.dismissedFrom,
      dismissedReplyId: record.dismissedReplyId,
      dismissedReplyVersion: record.dismissedReplyVersion,
      dismissedBy: record.dismissedBy,
    })
    .where(and(eq(incomingComments.id, id), eq(incomingComments.status, from)));
}

/**
 * The owner answered one reply in their own words — the reply twin of
 * {@link saveOwnerComment}, for every box that answers a reply the owner holds.
 *
 * Owner-AUTHORED: the row is `publishOrigin = 'owner'`, so pacing spaces it
 * and never caps it, and the words are the approval (save = send) while the
 * campaign runs and the account may write to LinkedIn. Otherwise they land as
 * a proposal waiting for a yes. Their words are a reply sample of the voice the campaign writes
 * in, which teaches how they reply (`captureOwnerReply`).
 *
 * ONE reply row per reply (`messages_org_incoming_comment_unq`): a reply with
 * no row of ours goes through the reply intake; one whose draft still waits,
 * or was turned down, has that row rewritten as the owner's, the draft kept
 * beside it and the edit on its revision history. A reply the owner or Reply
 * Off let go (`dismissed`, `ignored`) is theirs to take back up by answering
 * it. A reply that moved on is left exactly as it is, which is what makes a
 * second press a no-op. Nothing
 * here classifies or drafts for the reply, and the one send the owner asked
 * for is all that can reach LinkedIn.
 *
 * Words their agent wrote for the box (`assistTexts`, and every angle the
 * box kept) stay the owner's to send, and are measured at the save as a saved
 * comment's drafts are — how much of them it kept, and how much of that the
 * owner had typed before them (`ownerWords`) — so a reply that is mostly the
 * agent's is marked assisted. Saved untouched, they go out as the agent's
 * (`agentWords`), where caps bind.
 */
export async function saveOwnerReply(
  tx: Tx,
  input: {
    incomingCommentId: number;
    text: string;
    assistTexts?: readonly string[];
    ownerWords?: readonly string[];
  },
): Promise<SaveOwnerReplyOutcome> {
  const authored = AuthoredTextSchema.safeParse(input.text);
  if (!authored.success) {
    return { kind: "refused", error: authored.error.issues[0]?.message ?? "invalid text" };
  }
  const text = authored.data;
  await assertJudgedWords(tx, text);
  const [incoming] = await tx
    .select()
    .from(incomingComments)
    .where(eq(incomingComments.id, input.incomingCommentId))
    .for("update");
  if (!incoming) {
    return { kind: "refused", error: `incoming_comment ${input.incomingCommentId} not found` };
  }
  const [existing] = await tx
    .select()
    .from(messages)
    .where(eq(messages.incomingCommentId, incoming.id))
    .for("update");
  // Reply Off left their reply `ignored`, and the owner may have dismissed it:
  // their own answer takes either back up — as a draft they ask for would
  // (`requestIncomingReplyDraft`).
  const open =
    incoming.removedAt == null &&
    (existing
      ? (incoming.status === "new" || incoming.status === "reply_proposed") &&
        (existing.status === "proposed" || existing.status === "rejected")
      : incoming.status === "new" || incoming.status === "ignored" || incoming.status === "dismissed");
  if (!open) return { kind: "answered", status: incoming.status };

  const campaign = await replyCampaign(tx, existing ?? incoming);
  const mode = ownerReplyMode(campaign, await getChannelWriteAuthority(tx));
  const boxOffered = await composerOffered(tx, boxKey({ kind: "reply", incomingCommentId: incoming.id }));
  const assisted = higherRetention(
    measureBoxAssist(text, input.assistTexts, input.ownerWords),
    measureComposer(text, boxOffered, input.ownerWords),
  );
  // Their agent's words, saved as they were: the press approves them, and
  // they go out as the agent's — unless the owner had typed them first.
  const agentWords =
    isUntouchedOffer(text, [...boxOffered, ...(input.assistTexts ?? [])]) &&
    isAssisted(assisted?.assistRetention, assisted?.ownerOrigin);

  if (!existing) {
    // Answered after all, a reply let go no longer carries its Don't reply;
    // a refusal puts the reply back as it was found, the record with it.
    const letGo = incoming.status === "ignored" || incoming.status === "dismissed" ? incoming.status : null;
    if (letGo) await setIncomingStatus(tx, incoming.id, letGo, "new", NOT_DISMISSED);
    const result = await submitClientReply(
      tx,
      { incomingCommentId: incoming.id, text, model: OWNER_AUTHORED_MODEL },
      { forceProposal: mode !== "send", explicitUserDirected: true, authoredByOwner: true, agentWords },
    );
    const data = result.ok
      ? (result.data as {
          messageId: number | null;
          status: string;
          scheduledAt?: string;
          note?: string;
          violations?: Array<{ detail: string }>;
        })
      : null;
    if (data?.messageId == null) {
      // A refusal leaves the reply exactly as it was found.
      if (letGo) await setIncomingStatus(tx, incoming.id, "new", letGo, incoming);
      return result.ok
        ? { kind: "refused", error: data?.violations?.[0]?.detail ?? data?.note ?? "the reply was not saved" }
        : { kind: "refused", error: result.error, recovery: result.details?.recovery };
    }
    if (assisted) await tx.update(messages).set(assisted).where(eq(messages.id, data.messageId));
    trackOwnerSave({ for: "reply", retention: assisted?.assistRetention, characters: text.length }, tx);
    await captureOwnerReply(tx, {
      text,
      messageId: data.messageId,
      campaignId: campaign?.id ?? null,
      discoveredPostId: incoming.discoveredPostId,
      draft: null,
      assistTexts: input.assistTexts,
      ownerWords: input.ownerWords,
      boxOffered,
    });
    return {
      kind: "saved",
      messageId: data.messageId,
      status: data.status as "approved" | "proposed" | "suppressed_dryrun",
      // The intake payload dates in ISO; every reader here dates in epoch ms.
      scheduledAt: data.scheduledAt ? Date.parse(data.scheduledAt) : null,
    };
  }

  if (!campaign) return { kind: "refused", error: `reply ${existing.id} has no campaign to send under` };
  const status = mode === "proposal" ? "proposed" : "approved";
  // The owner's words replace the draft as the row's final text — the trigger
  // records it as a human edit — and any redraft still asked of an agent is
  // withdrawn: their words are the answer.
  const [rewritten] = await tx
    .update(messages)
    .set({
      finalText: text,
      publishOrigin: agentWords ? "worker" : "owner",
      status,
      ...(assisted ?? {}),
      scheduledAt: null,
      error: null,
      postingStartedAt: null,
      redraftRequestId: null,
      redraftRequestVersion: existing.redraftRequestVersion + 1,
      redraftRequestedAt: null,
      redraftRequestedBy: null,
      redraftRequestNote: null,
    })
    .where(
      and(
        eq(messages.id, existing.id),
        eq(messages.status, existing.status),
        eq(messages.redraftRequestVersion, existing.redraftRequestVersion),
      ),
    )
    .returning({ id: messages.id });
  if (!rewritten) return { kind: "answered", status: incoming.status };
  trackOwnerSave({ for: "reply", retention: assisted?.assistRetention, characters: text.length }, tx);
  await captureOwnerReply(tx, {
    text,
    messageId: existing.id,
    campaignId: campaign.id,
    discoveredPostId: incoming.discoveredPostId,
    // The draft that waited was offered too, unless the row was born of the
    // owner's own words. An earlier save of theirs over an agent's draft makes
    // the row theirs to send, and leaves the agent's draft where it was.
    draft: existing.model === OWNER_AUTHORED_MODEL ? null : existing.proposedText,
    assistTexts: input.assistTexts,
    ownerWords: input.ownerWords,
    boxOffered,
  });
  if (incoming.status === "new") {
    await tx
      .update(incomingComments)
      .set({ status: "reply_proposed" })
      .where(and(eq(incomingComments.id, incoming.id), eq(incomingComments.status, "new")));
  }
  let scheduledAt: number | null = null;
  if (status === "approved") {
    const [slot] = await assignSlots(tx, {
      campaign,
      origin: agentWords ? "worker" : "owner",
      items: [{ messageId: existing.id, kind: "reply" }],
    });
    scheduledAt = slot?.scheduledAt ?? null;
    // Saving is sending: the owner's save is the reply's yes.
    await sendApprovedReply(tx, existing.id, { yes: { by: "owner:save" } });
  }
  return { kind: "saved", messageId: existing.id, status, scheduledAt };
}

export type SubmitClientReplyInput = {
  incomingCommentId: number;
  text: string;
  sensitivityHold?: boolean;
  model?: string;
  rationale?: string;
};

export async function submitClientReply(
  tx: Tx,
  input: SubmitClientReplyInput,
  options: ClientIntakeOptions,
) {
  const { incomingCommentId, text, sensitivityHold, model, rationale } = input;
  const authoredText = AuthoredTextSchema.safeParse(text);
  if (!authoredText.success) {
    const detail = authoredText.error.issues[0]?.message ?? "invalid text";
    return intakeSuccess({
      messageId: null,
      alreadyExisted: false,
      status: "rejected",
      violations: [{ rule: "text_boundary", detail }],
      note: "rejected by the deterministic text boundary; the incoming comment is untouched",
    });
  }
  const trimmed = authoredText.data;
  const [inc] = await tx
    .select()
    .from(incomingComments)
    .where(eq(incomingComments.id, incomingCommentId))
    .for("update");
  if (!inc)
    return intakeError(`incoming_comment ${incomingCommentId} not found`);
  const [existingReply] = await tx
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.kind, "reply"),
        eq(messages.incomingCommentId, incomingCommentId),
      ),
    )
    .for("update");
  const replay = await replayedRedraft(tx, options.durableRequest);
  if (replay) {
    return intakeSuccess({
      messageId: replay.messageId,
      alreadyExisted: true,
      redrafted: true,
      status: "proposed",
      note: "redraft request already consumed (idempotent replay)",
    });
  }
  const exactIncoming = exactIncomingRequest(options.durableRequest, inc);
  const exactRedraft =
    existingReply != null &&
    exactMessageRequest(options.durableRequest, existingReply);
  if (options.durableRequest && !exactIncoming && !exactRedraft) {
    return intakeError("durable reply request is stale", {
      code: "stale_item",
      status: 409,
      recovery: "Discard the draft and claim fresh work.",
    });
  }
  if (inc.status === "replied" && existingReply) {
    return intakeSuccess({
      messageId: existingReply.id,
      alreadyExisted: true,
      status: existingReply.status,
      note: "already submitted (idempotent resubmit)",
    });
  }
  if (!["new", "reply_proposed"].includes(inc.status)) {
    return intakeError(
      `incoming_comment ${incomingCommentId} is ${inc.status}`,
    );
  }

  // Share-lock the org policy before resolving either reply lane. Policy
  // downgrades take an exclusive row lock, so they cannot commit between this
  // authorization decision and the message/incoming mutations below.
  await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      sql`${organizations.id} = nullif(current_setting('app.current_org', true), '')::uuid`,
    )
    .for("share");

  // Resolve the source-specific reply policy first. Reply approval is a
  // distinct safety axis from comment approval: Auto-post comments must
  // never arm a manual reply lane.
  let campaign: Campaign | undefined;
  let policyEnabled = false;
  let policyAuto = false;
  if (inc.source === "our_comment_thread") {
    if (!inc.campaignId) {
      return intakeError("campaign thread reply has no owning campaign");
    }
    [campaign] = await tx
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, inc.campaignId))
      .for("share");
    const mode = campaign ? (await modeFor(tx, { campaignId: campaign.id, capability: "reply_public", target: "their_reply" })).effective : "off";
    policyEnabled = mode === "review" || mode === "auto";
    policyAuto = mode === "auto";
  } else {
    const policy = await getOwnPostRepliesScoped(tx);
    campaign = await replyCampaign(tx, inc, { lock: true });
    const effective = campaign ? (await modeFor(tx, { ownPost: policy, campaignId: campaign.id })).effective : "off";
    if (effective === "off" && options.authoredByOwner !== true) {
      return intakeError("Replies on your posts are Off.", { code: options.resolveStepMode ? "mode_off" : "reply_off", status: 409 });
    }
    policyEnabled = effective !== "off";
    policyAuto = effective === "auto";
  }
  if (!campaign)
    return intakeError("no agent-led campaign available to drive the reply");
  if (options.resolveStepMode && inc.source === "our_comment_thread") {
    if (campaign.channelId !== null) await tx.select({ id: channels.id }).from(channels).where(eq(channels.id, campaign.channelId)).for("share");
    const action = await modeFor(tx, { campaignId: campaign.id, capability: "reply_public", target: "their_reply" });
    policyEnabled = action.effective !== null && action.effective !== "off";
    policyAuto = action.effective === "auto";
  }
  if (options.resolveStepMode && !policyEnabled) return intakeError("The reply step is Off.", { code: "mode_off", status: 409 });
  const runtimeError = await supportedCampaignError(tx, campaign, {
    requireActive: !(options.authoredByOwner === true && options.forceProposal),
  });
  if (runtimeError) return runtimeError;
  const hasActiveRequest =
    inc.draftRequestId != null || existingReply?.redraftRequestId != null;
  const activeRequestAuthorizes =
    hasActiveRequest &&
    (options.requireFrozenRequest !== true || exactIncoming || exactRedraft);
  if (await isRoomThreadReply(tx, inc)) {
    policyAuto = false;
    if (!options.authoredByOwner && !options.explicitUserDirected && !activeRequestAuthorizes) {
      return intakeError("Room conversations wait for the owner's reply or an explicit draft request.");
    }
  }
  if (
    !policyEnabled &&
    options.explicitUserDirected !== true &&
    !activeRequestAuthorizes
  ) {
    return intakeError(
      inc.source === "our_comment_thread"
        ? "campaign thread replies are disabled"
        : "own-post replies are disabled",
    );
  }

  const hold = sensitivityHold === true;
  // The client's check says held or not, never under which category. The
  // owner's own words run no check, and neither does a draft they asked for,
  // so both leave the reply's as it was — why it was held stays its history.
  const clientHold =
    options.authoredByOwner === true || options.keepsSensitivity === true
      ? {}
      : sensitivityRow({ hold, category: "other" });

  // The campaign voice's register rules, with its reply traits — the intake
  // lint follows them.
  const replyStyle = replyRules(
    await resolveCampaignVoice(tx, campaign, await getProfile(tx), "reply"),
  );

  // The owner's own words are the approval (save = send), as a saved comment
  // is; every other reply waits on its source's reply policy.
  const status = submitStatus(
    hold,
    options.forceProposal,
    options.authoredByOwner === true || policyAuto ? "auto" : "manual",
  );
  const key = dedupeKey("reply", campaign.id, inc.commentUrn);
  const messageRedraftAuthorized =
    existingReply?.redraftRequestId != null &&
    (options.explicitUserDirected === true ||
      exactRedraft ||
      (options.requireFrozenRequest !== true && activeRequestAuthorizes));
  const incomingReplacementAuthorized =
    existingReply != null &&
    inc.draftRequestId != null &&
    (options.explicitUserDirected === true ||
      exactIncoming ||
      (options.requireFrozenRequest !== true && activeRequestAuthorizes));
  const redraftAuthorized =
    messageRedraftAuthorized || incomingReplacementAuthorized;
  if (existingReply && !redraftAuthorized) {
    return intakeSuccess({
      messageId: existingReply.id,
      alreadyExisted: true,
      status,
      note: "already submitted (idempotent resubmit)",
    });
  }

  // Hard slop gate (config.intakeSlopGate) — BEFORE any mutation so a
  // rejection is side-effect-free (the incoming comment stays 'new', its
  // sensitivity untouched). A non-error JSON status is deliberate: an
  // isError result would trip an old agent's two-failures-in-a-row stop
  // rule. Existing non-redraft replies resolve above, before this gate.
  // The owner's own words are exempt, as a saved comment's are.
  const replyGate = options.authoredByOwner
    ? []
    : intakeGateViolations(trimmed, replyStyle);
  if (replyGate.length > 0 && config.intakeSlopGate) {
    return intakeSuccess({
      messageId: null,
      alreadyExisted: false,
      status: "rejected",
      violations: replyGate,
      note: "rejected by the deterministic slop lint — fix the violations and call submit_draft again; the incoming comment is untouched (still 'new')",
    });
  }

  const trace = {
    v: 1,
    source: "client",
    client: {
      declared: rationale?.trim() ? { rationale: rationale.trim() } : undefined,
      verified: {
        wordCount: countWords(trimmed),
        tierByWords: tierByWordCount(countWords(trimmed)),
        withinCap: true,
        lint: (() => {
          const lint = [
            ...mechanicalViolations(trimmed),
          ];
          return lint.length > 0 ? lint : undefined;
        })(),
      },
    },
  } satisfies DraftTrace;

  if (existingReply && redraftAuthorized) {
    let requestBackedReply = existingReply;
    if (
      incomingReplacementAuthorized &&
      existingReply.redraftRequestId == null
    ) {
      const [backed] = await tx
        .update(messages)
        .set({
          redraftRequestId: inc.draftRequestId,
          redraftRequestVersion: inc.draftRequestVersion,
          redraftRequestedAt: inc.draftRequestedAt,
          redraftRequestedBy: inc.draftRequestedBy,
          redraftRequestNote: inc.draftRequestNote,
        })
        .where(
          and(
            eq(messages.id, existingReply.id),
            eq(messages.status, existingReply.status),
            eq(
              messages.redraftRequestVersion,
              existingReply.redraftRequestVersion,
            ),
            isNull(messages.redraftRequestId),
          ),
        )
        .returning();
      if (!backed) {
        return intakeError("durable reply request is stale", {
          code: "stale_item",
          status: 409,
        });
      }
      requestBackedReply = backed;
    }
    const [redrafted] = await tx
      .update(messages)
      .set({
        proposedText: trimmed,
        finalText: null,
        status: "proposed",
        scheduledAt: null,
        error: null,
        postingStartedAt: null,
        promptVersionId: null,
        model: model ?? "client",
        loopVersion: "client",
        trace,
        redraftRequestId: null,
        redraftRequestedAt: null,
        redraftRequestedBy: null,
        redraftRequestNote: null,
      })
      .where(
        and(
          eq(messages.id, requestBackedReply.id),
          eq(messages.status, requestBackedReply.status),
          eq(
            messages.redraftRequestVersion,
            requestBackedReply.redraftRequestVersion,
          ),
          eq(messages.redraftRequestId, requestBackedReply.redraftRequestId!),
        ),
      )
      .returning({ id: messages.id });
    if (!redrafted) {
      return intakeError("durable reply request is stale", {
        code: "stale_item",
        status: 409,
      });
    }
    if (incomingReplacementAuthorized) {
      const [consumed] = await tx
        .update(incomingComments)
        .set({
          status: "reply_proposed",
          ...clientHold,
          draftRequestId: null,
          draftRequestedAt: null,
          draftRequestedBy: null,
          draftRequestNote: null,
        })
        .where(
          and(
            eq(incomingComments.id, inc.id),
            eq(incomingComments.status, "new"),
            eq(incomingComments.draftRequestVersion, inc.draftRequestVersion),
            eq(incomingComments.draftRequestId, inc.draftRequestId!),
          ),
        )
        .returning({ id: incomingComments.id });
      if (!consumed) {
        throw new Error(
          "incoming comment changed while persisting its redraft",
        );
      }
    }
    return intakeSuccess({
      messageId: redrafted.id,
      alreadyExisted: false,
      redrafted: true,
      status: "proposed",
      note: "redrafted in the existing reply pipeline; awaiting approval",
    });
  }

  const [inserted] = await tx
    .insert(messages)
    .values({
      kind: "reply",
      campaignId: campaign.id,
      publishOrigin: publishOriginFor(options),
      incomingCommentId: inc.id,
      targetProfileId: inc.authorProfileId,
      proposedText: trimmed,
      status,
      dedupeKey: key,
      promptVersionId: null,
      model: model ?? "client",
      loopVersion: "client",
      trace,
    })
    .onConflictDoNothing()
    .returning({ id: messages.id });
  const existing =
    inserted ??
    (
      await tx
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.dedupeKey, key))
    )[0];

  const [transitioned] = await tx
    .update(incomingComments)
    .set({
      status: "reply_proposed",
      ...clientHold,
      draftRequestId: null,
      draftRequestedAt: null,
      draftRequestedBy: null,
      draftRequestNote: null,
    })
    .where(
      and(
        eq(incomingComments.id, inc.id),
        eq(incomingComments.status, "new"),
        eq(incomingComments.draftRequestVersion, inc.draftRequestVersion),
        inc.draftRequestId == null
          ? isNull(incomingComments.draftRequestId)
          : eq(incomingComments.draftRequestId, inc.draftRequestId),
      ),
    )
    .returning({ id: incomingComments.id });
  if (inserted && !transitioned) {
    // Throw so the surrounding transaction rolls the inserted message back.
    throw new Error("incoming comment changed while persisting its reply");
  }

  let scheduledAt: number | null = null;
  if (inserted && status === "approved") {
    const [slot] = await assignSlots(tx, {
      campaign,
      origin: publishOriginFor(options),
      items: [{ messageId: inserted.id, kind: "reply" }],
    });
    scheduledAt = slot?.scheduledAt ?? null;
    // The owner's save is the yes; a step's reply at Automatic has none.
    if (options.authoredByOwner === true) await sendApprovedReply(tx, inserted.id, { yes: { by: "owner:save" } });
    else await queueAutomaticReply(tx, inserted.id);
  }

  return intakeSuccess({
    messageId: existing?.id ?? null,
    alreadyExisted: !inserted,
    status,
    scheduledAt:
      scheduledAt != null ? new Date(scheduledAt).toISOString() : undefined,
    note: hold
      ? "sensitivity HOLD — a human must review before this posts"
      : status === "approved"
        ? "scheduled — the paced publisher sends it (still gated)"
        : "awaiting approval",
  });
}
