/**
 * Prepared external judgments: what one task FREEZES, and what makes it stale.
 *
 * THE BINDING RULE. `snapshot()` reads one wide picture of the org — the
 * channel, the campaign, the product and its facts, the worker, the voice, the
 * Brain's notes and knowledge version, the compiler inputs, the frozen
 * candidates. All of it is handed to the agent as `sources`, because context
 * the model reads is cheap and a narrow prompt is a worse one. Almost none of
 * it may DECIDE `stale_context`.
 *
 * A task is bound to the sources its own apply reads and writes, and to
 * nothing else — `TASK_BINDINGS` below, one entry per kind, is that binding
 * and the only input to `context.guard`. An entry names a source, or a
 * PROJECTION of one (`campaignTargeting`, picked in `bindable`), because a
 * task that reads two columns of a row must not stale on the twenty it never
 * reads. Widening it is not a harmless safety margin: it makes every task
 * stale on every unrelated write, and two tasks prepared from ONE snapshot
 * then cannot both be submitted, because accepting the first moves something
 * the second never read.
 *
 * Measured 2026-09-15 on a blank install: `seed_brain {source:{kind:"linkedin"},
 * scope:"brain"}` in session prepared `brain_notes` and `voice_analysis` from
 * one snapshot; submitting `brain_notes` was accepted and moved
 * `knowledgeVersion`, and `voice_analysis` — which reads the voice row and the
 * corpus and nothing else — was then refused `stale_context` while
 * `get_task` still called it `awaiting_agent`.
 *
 * `sourceText` is not in any binding because it cannot drift: it lives in the
 * task's own frozen `context.input`, not in the database.
 *
 * A binding is about what may REFUSE a submission, which is not the same as
 * what the apply may read. `draft`'s accepted-authorship phase deliberately
 * reads Brain knowledge and product facts it does not bind, live at submit
 * time, so that a fact retracted mid-task HOLDS one draft on the evidence
 * review rather than staling a whole batch — see `TASK_BINDINGS` below.
 *
 * `context.bindingVersion` says WHICH rule a stored task was written under.
 * Rows prepared before this landed carry no version and keep the old
 * whole-snapshot guard, so a release does not mass-expire the tasks already in
 * flight.
 */
import { contextHash as hash } from "./hash";
import { modeFor } from "../strategy/mode";
import { readRoomForDrafting } from "../operations/researchReads";
import { lockRoomEvidence } from "../rooms/eligibility";
import { and, desc, eq, inArray, isNull, isNotNull, lte, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { AppError, NotFoundError } from "@engager/common/errors";
import {
  tasks,
  campaigns,
  channels,
  products,
  productFacts,
  voices,
  voiceSamples,
  type StyleRules,
  discoveredPosts,
  workers,
  workerRuns,
  messages,
  type Campaign,
} from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { AuthoredTextSchema } from "../ai/authoredText";
import type { AskedDraft, McpCtx } from "../mcp/context";
import { assertHostedMcpCredentialInTx } from "../mcp/tools/hostedSpend";
import { storeProductFact } from "../products/facts";
import {
  currentKnowledgeVersion,
  storeKnowledge,
  type KnowledgeSource,
} from "../brain/knowledge";
import { BRAIN_SLOTS } from "../brain/slots";
import { listNotes } from "../brain/vault";
import { archiveSourceInTx } from "../brain/seed";
import { lockBrainMutation } from "../brain/mutationLock";
import {
  enqueueRecompileForCampaigns,
  enqueueRecompileForProduct,
  sanitizeBrief,
  snapshotInputs,
  writeCompiledBrief,
} from "../brain/compile";
import { getProfile, setChannelVoice } from "../profile";
import { getSystemState } from "../ratelimit/killswitch";
import { computeCommentDemand } from "../operations/demand";
import { draftHolds } from "../people/draftHolds";
import { channelCeilings } from "../ratelimit/ledger";
import { ensureDefaultVoice, getVoiceForCampaign } from "../voice";
import { eligibleVoiceSamples, consumeVoiceSamples, voiceEvidence } from "../learning/recalibrate";
import { angleClassificationState, submitAngleClassifications, ANGLE_TAXONOMY } from "../learning/angleProfile";
import { untrusted } from "../ai/prompts";
import { snapshotVoiceRevision } from "../learning/voiceRevisions";
import {
  getCommentDraftingContext,
  submitCommentDraftBatch,
} from "../operations/clientDrafting";
import { ASSIST_MOVES, type AssistMove } from "../operations/candidateDraft";
import { boxKey, composerFor, putComposerAngle, putComposerIdea } from "../composer/drafts";
import { addAskedDraft } from "../operations/messages";
import { campaignStops } from "../actions/pause";
import { readExecutionAuthority } from "../execution/authority";
import { createProduct } from "../operations/products";
import { awaitingStart } from "../strategy/read";
import { trackFirstDraft } from "../telemetry/firstResults";
import { setVoiceChannel, mergeLearnedStyleRules } from "../operations/voices";
import { requireSavedCampaign, saveCampaign } from "../operations/saveCampaign";
import {
  pendingTasks,
  withExternalJudgment,
  type TaskIntent,
} from "./judgment";
import { wireSources } from "./draftContext";
import {
  EvidenceSchema,
  EVIDENCE_SYSTEM,
  SLIPS_SYSTEM,
  productEvidenceFacts,
  validateEvidenceVerdict,
  type DraftEvidence,
} from "../workers/evidenceReview";
import { intakeGateViolations } from "../ai/intakeGate";
import { resolveCampaignVoice } from "../voice";

const id = z.number().int().positive();
const text = z.string().trim().min(1).max(20_000);
export const TaskKind = z.enum([
  "product_facts",
  "brain_notes",
  "voice_analysis",
  "campaign_brief",
  "draft",
  "voice_calibration",
  "angle_classification",
]);
/**
 * What each kind is BOUND to — see the binding rule at the top of this file.
 *
 * Read against `applyResult`, one arm at a time:
 *
 * - `product_facts` writes onto `snap.product` and its `facts` are what the
 *   agent deduplicated against.
 * - `brain_notes` reads NEITHER `notes` NOR `knowledgeVersion` in its apply —
 *   it archives by source and calls `storeKnowledge`, which versions and
 *   deduplicates on its own. They stay bound anyway, because they are the
 *   vault the agent's extraction was judged against, and because a partial
 *   submission's second half must see the first half's writes.
 * - `voice_analysis` reads `sources.sourceText` and the voice row. It is the
 *   one kind the seed prepares BESIDE another, so its binding is the whole
 *   point: the Brain's notes, the product, the campaign and the compiler are
 *   context it never reads.
 * - `campaign_brief` writes the compiled brief from `snap.compiler`, whose own
 *   `sourceHash` already covers the notes and products it was compiled over. It
 *   keeps the whole campaign row on purpose: its apply WRITES that row, and a
 *   scheduled compile that landed while it waited is meant to settle it —
 *   `compiler.existing` is the same brief and says so too, and `taskRecovery`
 *   is the copy that tells the caller to continue rather than prepare a second.
 * - `draft` writes against the frozen candidates, under
 *   the worker's demand and the channel's authority. `draft` also resolves the
 *   voice it writes with — which is
 *   `campaignVoice`, the campaign's own attached row, not the org default in
 *   `voice`; both are bound because either can be the one the intake gate's
 *   style rules come from.
 *
 * `draft` reads two things on purpose that it does NOT bind. The accepted
 * authorship phase builds `draftReview.evidence` — Brain knowledge, the
 * constraints and the attached products' facts — from a drafting context read
 * LIVE at submit time, so a note or fact edited while the agent was writing is
 * not in the binding and does not stale the task. That is the design: the
 * evidence review that follows validates every clause against the evidence as
 * it stands NOW, so a retracted fact HOLDS the draft (`unsupported_claim`)
 * instead of refusing the whole task — which is the better failure, because
 * the other items in the same batch still land. The legacy profile row behind
 * `resolveVoiceV2`'s fallback is unbound for the same kind of reason: the
 * canonical writer (`setChannelVoice`) moves the default voice row with it, and
 * that row IS bound, so only a raw column edit slips past.
 */
const TASK_BINDINGS = {
  voice_calibration: ["voice"],
  angle_classification: ["angleProfile"],
  product_facts: ["product", "facts"],
  brain_notes: ["notes", "knowledgeVersion"],
  voice_analysis: ["voice"],
  campaign_brief: ["campaign", "compiler"],
  draft: [
    "channel",
    "campaign",
    "worker",
    "voice",
    "campaignVoice",
    "posts",
    "rooms",
    "focus",
  ],
} as const satisfies Record<
  z.infer<typeof TaskKind>,
  readonly (keyof Bindable)[]
>;
/** The rule this build writes. Bump it when `TASK_BINDINGS` changes, so tasks
 *  already in flight keep the binding they were prepared under.
 *
 */
const BINDING_VERSION = 1;
/** What `snapshot()` returned before bindings existed, in the guard a row
 *  prepared under the old rule was written with. Spelled out rather than taken
 *  as "every key of `snap`", so that ADDING a source — `campaignVoice` did —
 *  does not retroactively stale every task still in flight at the deploy. */
const LEGACY_BINDING = [
  "channel",
  "campaign",
  "product",
  "facts",
  "worker",
  "voice",
  "notes",
  "compiler",
  "knowledgeVersion",
  "posts",
  "focus",
] as const satisfies readonly (keyof Snapshot)[];
export const StartTask = z
  .object({
    taskKind: TaskKind,
    campaignId: id.optional(),
    requestedPostId: id.optional(),
    productId: id.optional(),
    workerId: id.optional(),
    sourceText: z.string().trim().min(1).max(64_000).optional(),
    productName: z.string().trim().min(1).max(200).optional(),
    campaignName: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
const learnedRules = z.object({
  emDashes: z.enum(["allow", "forbid"]).nullable().optional(),
  semicolons: z.enum(["allow", "forbid"]).nullable().optional(),
  emojiMax: z.number().int().min(0).max(10).nullable().optional(),
  casing: z.enum(["sentence", "lowercase", "mirror"]).nullable().optional(),
  bannedOpeners: z.array(z.string().max(60)).max(30).nullable().optional(),
  closerQuestionPolicy: z.enum(["natural", "never", "encouraged"]).nullable().optional(),
  shorthand: z.enum(["allow", "forbid"]).nullable().optional(),
  roughEdges: z.enum(["allow", "forbid"]).nullable().optional(),
  extras: z.string().max(2000).nullable().optional(),
}).strict();
const outputs = {
  voice_calibration: z.object({ persona: z.string().min(1).max(2000), houseStyle: z.string().min(1).max(4000), styleRules: learnedRules.optional() }).strict().describe("Repeat the same calibration for every sample included in this submission."),
  angle_classification: z.object({ labels: z.array(z.object({ move: z.enum(ANGLE_TAXONOMY.map((move) => move.id) as [string, ...string[]]), weight: z.number().min(0).max(1) }).strict()).min(1).max(4), matchedOfferedAngle: z.boolean().nullable() }).strict(),
  product_facts: z
    .object({
      facts: z
        .array(
          z
            .object({
              facet: z.enum([
                "what",
                "audience",
                "value",
                "proof",
                "objections",
                "links",
              ]),
              content: text,
            })
            .strict(),
        )
        .min(1)
        .max(20),
    })
    .strict(),
  brain_notes: z
    .object({
      notes: z
        .array(
          z
            .object({
              slot: z.enum(
                BRAIN_SLOTS.map((s) => s.id) as [
                  (typeof BRAIN_SLOTS)[number]["id"],
                  ...(typeof BRAIN_SLOTS)[number]["id"][],
                ],
              ),
              title: z.string().max(200),
              content: text,
            })
            .strict(),
        )
        .min(1)
        .max(20),
    })
    .strict(),
  voice_analysis: z
    .object({
      persona: z.string().min(1).max(2000),
      houseStyle: z.string().min(1).max(4000),
    })
    .strict(),
  campaign_brief: z.object({ brief: z.string().min(1).max(2000) }).strict(),
  draft: z
    .object({
      text: AuthoredTextSchema,
      rationale: z.string().max(600),
      sources: z
        .array(
          z
            .object({
              url: z.string().url().max(2000),
              quote: z.string().min(1).max(2000),
            })
            .strict(),
        )
        .max(10)
        .describe(
          "WEB FACTS ONLY, and only ones this task already holds: the url AND its quote must both appear in the frozen evidence — the owner's documented material, which is what the evidence review checks every clause against. Never the post you are commenting on: that is the subject, its url is not evidence, and citing it is refused as source_not_in_evidence. Required only on a campaign with webFacts on; otherwise leave it empty.",
        ),
    })
    .strict(),
};
/**
 * What a caller SUBMITS, described where the model reads it.
 *
 * The three names this schema keeps apart were the whole of a native first-run
 * failure (2026-09-16): the task's own `id`, the item ids the task froze, and
 * the source refs evidence cites are three different strings, and only
 * `frozenItemIds` may appear in `items[].id`. A task that freezes one item —
 * every source kind, `brain_notes` and `voice_analysis` among them — holds its
 * entire output inside that one item's `result`, so a single result may carry
 * many notes. A submission that names anything else is refused
 * `unfrozen_item` and writes nothing.
 */
export const TaskSubmission = z
  .object({
    taskId: z
      .string()
      .uuid()
      .describe(
        "The task's own `id`. NOT an item id — item ids come from `frozenItemIds`.",
      ),
    contextRevision: z
      .string()
      .length(64)
      .describe(
        "The task's `contextRevision`, as read. A moved-on revision is refused `stale_context`.",
      ),
    idempotencyKey: z
      .string()
      .uuid()
      .describe(
        "A fresh UUID. The same key and body replays the receipt; the same key with other content is refused `task_receipt_conflict`.",
      ),
    items: z
      .array(
        z
          .object({
            id: z
              .string()
              .min(1)
              .max(2000)
              .describe(
                "A string from THIS task's `frozenItemIds`, once each. Never the `taskId`, a `sourceRefs` name or an output key. One frozen item takes one item holding all its output in `result`.",
              ),
            result: z
              .unknown()
              .describe(
                "This item's output, matching the task's `outputSchema`.",
              ),
            evidenceRefs: z
              .array(z.string().max(2000))
              .max(20)
              .describe(
                "Names from the task's `sourceRefs`; at least one per item, else `unknown_evidence`.",
              ),
          })
          .strict(),
      )
      .max(20),
    incompleteIds: z
      .array(z.string().max(2000))
      .max(20)
      .default([])
      .describe(
        "Frozen item ids you are leaving for a later submission, copied verbatim from `frozenItemIds` — never a `sourceRefs` name.",
      ),
  })
  .strict();
const credential = (_ctx: McpCtx) => "local-stdio";
type Snapshot = Awaited<ReturnType<typeof snapshot>>;
type Context = {
  input: z.infer<typeof StartTask>;
  frozenIds: string[];
  sources: Record<string, unknown>;
  /** The bound sources' hash — see the binding rule at the top of this file. */
  guard: string;
  /** Which `TASK_BINDINGS` revision `guard` was computed under. Absent on a
   *  row prepared before bindings existed, which keeps the old whole-snapshot
   *  guard rather than going stale the moment this build ships. */
  bindingVersion?: number;
  /** The in-session run that prepared this task, shared by every task that
   *  run prepared from ONE snapshot. What makes a sibling a sibling. */
  sessionRunId?: string;
  /** Set when the binding stopped matching the world, so the row says so
   *  instead of sitting `awaiting_agent` behind a revision nothing accepts. */
  stale?: { reason: string; at: number };
  account: unknown;
  runId?: number;
  /** What the phase that DEFERRED this task was about to do. Server-authored
   *  (see `DeferredTask.intent`) — never parsed from a caller's input. */
  intent?: TaskIntent;
  workerDemand?: { limit: number; publish: boolean; floorOnly: boolean };
  /** The sweep's durable marker. `started` is the only value still in the air;
   *  `chat/broker.ts` reads exactly this to settle an interrupted turn, and a
   *  SECOND SERVER PROCESS reads it to refuse a second sweep, which the
   *  in-process lock alone could never do. */
  sweep?: "started" | "completed" | "interrupted";
  /** What that sweep actually did, recorded as it goes rather than returned
   *  once at the end — because past the bound there is no longer a call to
   *  return to. Written per committed term, so a session killed mid-sweep
   *  leaves a record matching the rows that landed.
   *
   *  `sweep` and `sweepRun` are the ONLY two keys the sweep owns. Every write
   *  of them is a JSONB merge of exactly this pair (see `recordSweep`), because
   *  the rest of `context` belongs to writers this sweep knows nothing about. */
  sweepRun?: {
    /** Rows committed across every attempt on this task; the final count once
     *  `sweep` is terminal. Carried across a recovered attempt, since the rows
     *  a lost attempt committed are still in `discovered_posts`. */
    discovered: number;
    /** Their `discovered_posts` ids, in the order the terms committed them. */
    ids: number[];
    /** When the CURRENT attempt began — not the first one. */
    startedAt: number;
    /** Refreshed every `SWEEP_HEARTBEAT_MS` while the sweep runs, and the only
     *  evidence that the process holding it is still alive. A `started` marker
     *  whose heartbeat has gone stale is a sweep whose process died: nothing
     *  else settles it, because `settleExpiredTasks` only touches
     *  `awaiting_agent` rows and a swept terms task is `completed`. */
    heartbeatAt?: number;
    /** Set when `sweep` left `started`, for either outcome. */
    finishedAt?: number;
    /** Why it ended as `interrupted`. The rows above are still real. */
    error?: string;
    /** That reason in the refusing rung's own words, when it had any. The code
     *  is what an agent branches on; this is what it shows the owner. */
    errorDetail?: string;
    /** When the condition behind `error` is expected to lift — a paused
     *  channel's `pausedUntil`, a capped hour's reopening. Absent for the
     *  failures a clock does not fix, sign-in first among them. */
    retryAt?: number;
    /** Attempts abandoned by a dead process before this one. Recorded rather
     *  than overwritten, so a recovered sweep does not read as a clean first
     *  run. */
    lostAttempts?: number;
  };
  draftReview?: Record<
    string,
    { draft: z.infer<typeof outputs.draft>; evidence: DraftEvidence }
  >;
  /** A requested task for the agent's comment draft waiting on the post
   *  (`McpCtx.askedDraft`): which comment, at the request version it was asked
   *  against, and the angle and move a draft written here joins its set with.
   *  Server-read at preparation, never from a caller's input. */
  asked?: { messageId: number; requestVersion: number; angle: string | null; move: string };
};
type Receipt = {
  hash: string;
  items: {
    id: string;
    accepted: boolean;
    result?: unknown;
    reason?: string;
    /** WHAT the reason was about, when the code alone cannot be acted on. A
     *  rejected result says which fields failed the schema and how; a rejected
     *  source says which url the frozen evidence does not hold. Bounded on
     *  purpose: an agent needs the first few to fix its output, and a receipt
     *  is not the place to re-serialise a submission back at its author. */
    detail?: string;
    /** The evidence refs this task actually advertises, returned WITH the
     *  refusal that names one it does not. An agent that guessed a source name
     *  otherwise has to re-read the whole task to learn the ones it could
     *  have cited. */
    allowedEvidence?: string[];
    /** Triage items carry their outcome flat instead of a `result` object: the
     *  candidate the verdict landed on, and whether it landed as a match. */
    matched?: boolean;
    discoveredPostId?: number;
  }[];
  incompleteIds: string[];
  acceptedCount: number;
  /** Triage only: the campaign's pulse ONCE, as it stands after the whole batch.
   *  Every item used to repeat it — twenty identical 1.4 KB blocks differing
   *  from each other only in the counters the next item moved again. */
  queue?: unknown;
  nextRequiredTask?: { id: string; kind: "draft"; phase: "evidence_review" };
  /** Prepared tasks this submission made DUE — the model-bearing work its
   *  writes would have queued, deferred to the owner's agent instead. Stored on
   *  the receipt, so a replay reports the same owed work. */
  pendingTasks?: string[];
};
type Task = typeof tasks.$inferSelect;
const ReviewOutput = EvidenceSchema.shape.verdicts.element
  .omit({ discoveredPostId: true })
  // Slips of style, listed apart from facts (`SLIPS_SYSTEM`): asked of the
  // review only on a draft the owner asked for.
  .extend({ slips: z.array(z.string()).max(5).optional() })
  .strict();

export const draftJudgmentSchemas = {
  draft: outputs.draft,
  review: ReviewOutput,
};

/**
 * The most matches one worker's prepared draft task freezes. The day decides
 * how many drafts are wanted (`computeCommentDemand`); this decides how many
 * one task carries. Each frozen match brings its whole drafting context, and
 * twenty overflow the task's 256 KiB bound before the agent sees them, so a
 * day that wants more is the next run's to draft.
 */
const WORKER_DRAFT_TASK_MAX = 10;

/** How much of a schema failure a receipt carries: the first few complaints,
 *  then a hard character cap on the join. */
const SCHEMA_DETAIL_ISSUES = 3;
const SCHEMA_DETAIL_CHARS = 240;

/**
 * Which fields failed, in zod's own words.
 *
 * `invalid_task_output` alone is a refusal an agent cannot act on: the failure
 * is almost always ONE field — a `sources[0].url` a drafting helper left
 * undefined, measured 2026-09-15 — and from the receipt that is
 * indistinguishable from output that was never close. The task already carries
 * the schema, so this is a signpost back to it and deliberately not a second
 * copy: three issues, capped, with the paths that name where to look.
 */
function schemaDetail(error: z.ZodError): string {
  return error.issues
    .slice(0, SCHEMA_DETAIL_ISSUES)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ")
    .slice(0, SCHEMA_DETAIL_CHARS);
}

async function authorize(
  tx: Tx,
  ctx: McpCtx,
  signal: AbortSignal,
  kind?: string,
) {
  await assertHostedMcpCredentialInTx(
    tx,
    ctx,
    signal,
    kind === "native_read"
      ? "feed:read"
      : ["product_facts", "brain_notes", "voice_analysis"].includes(kind ?? "")
        ? "brain:write"
        : kind === "campaign_brief"
          ? "ops:write"
          : "messages:write",
  );
}

/**
 * The candidates one prepared triage/draft task may freeze for a campaign.
 *
 * The window is the server's own — the campaign's live pool — and the model names
 * nothing in it. What LEADS that window is owner-originated: a standing
 * `draft_requested` row, and above it the candidate the owner's live deck is
 * composing on. That deck focus is the same read the unattended path EXCLUDES
 * on (INV-9), used here for the opposite reason — an interactive draft IS the
 * owner asking about that post, so their request must not fall off the end of a
 * window it would never have topped. Tenant, campaign and status scope stay the
 * server's.
 *
 * A draft window is DELIBERATELY small. Every drafted candidate carries a full
 * frozen drafting context, and twenty of those overflow the task's own 256 KiB
 * bound before the agent ever sees them — an interactive draft is one owner
 * asking about one post, not the Ambassador's supply run, which keeps its own
 * demand-derived limit.
 *
 * Which five, then, is a CHOICE, and for a draft it is made on the relevance
 * the pool already holds. Behind the two owner-originated leads the order used
 * to fall through to `id`, which is discovery order: measured 2026-09-15 on a
 * campaign with ten matched candidates, the five FROZEN scored 0.9, 0.7, 0.65,
 * 0.6 and 0.55 while 0.9, 0.88, 0.85 and 0.8 sat unfrozen — the oldest five
 * rows, dressed up as a selection. Triage keeps id order, because it judges its
 * whole window and the order inside it decides nothing.
 *
 * A VERDICT outranks a score that is only a proxy for one. The coalesce the
 * schema documents and `listCandidatesRanked` implements — agent score, then
 * bet score, then meaningfulness, then the insert-time reach — is a single
 * scale, so on its own it lets an untriaged row's `reachScore` outbid a
 * relevance verdict the agent actually formed: measured 2026-09-15 on a campaign
 * whose triage pass scored 0.95, 0.92, 0.90, 0.88 and 0.85, the window froze
 * two untriaged rows on reach 0.929 and 0.916 and dropped the 0.88 and the
 * 0.85. Reach is an audience-size proxy every discovered row carries; it is
 * never evidence that anyone judged the post relevant. So the draft window
 * splits first on `candidateHasRelevanceVerdictSql` — the matched strategy's
 * own test, an `agentScore` or a current human good-match verdict.
 *
 * Inside the verdict side the coalesce cannot be the ranking either, because
 * an owner's `good_match` carries no `agentScore` and would fall through it to
 * the same reach proxy — losing to every agent score, which is the original
 * defect wearing the owner's own verdict. That side ranks on
 * `candidateRelevanceScoreSql`, the repo's one relevance scale (an owner's
 * verdict is 1, an agent's row is its score), and the coalesce is left to order
 * the untriaged side and to separate two rows the verdict scale ties.
 *
 * It still ranks rather than filters, because this window deliberately carries
 * the untriaged rows and the owner's own `draft_requested` request, which
 * the old matched-post selector would drop: the untriaged fill the window
 * once the verdicts run out, never over them.
 *
 * Carrying the untriaged is where this window and the runner contract's "draft
 * consumes already matched Candidates only" part company, on purpose: that rule
 * is about UNATTENDED supply, where nothing is watching and an untriaged row
 * would be drafted on without anyone having judged it relevant. Here the owner
 * asked, and their agent judges relevance as it writes — a window that hid the
 * untriaged would answer "there is nothing to draft" about a pool the owner can
 * see. The worker-bound branch above keeps the matched-only selector, so the
 * unattended lane is unchanged.
 *
 * The frozen set is always returned in id order, including the re-read against
 * frozen ids at submit time, so the context guard hashes one stable array
 * however a row got into it.
 */
async function campaignCandidates(
  tx: Tx,
  campaign: Campaign,
  frozenIds: string[],
  lock = true,
) {
  const query = tx
    .select()
    .from(discoveredPosts)
    .where(
      and(
        eq(discoveredPosts.campaignId, campaign.id),
        inArray(discoveredPosts.id, frozenIds.map(Number)),
      ),
    )
    .orderBy(discoveredPosts.id);
  return lock ? query.for("update") : query;
}

/** Keep secrets and connector credentials out of prepared content. Account
 * bindings are read from core rows, never from an agent's asserted identity.
 *
 * `lock` is the ONE thing the staleness sweep changes. Preparing and submitting
 * take the rows `FOR UPDATE` because they are about to write them; re-reading
 * the same picture to ask whether a task still matches writes nothing, and a
 * poll that took those locks every fifteen seconds would queue behind the
 * worker it is reporting on. */
async function snapshot(
  tx: Tx,
  input: z.infer<typeof StartTask>,
  frozenIds?: string[],
  intent?: TaskIntent,
  lock = true,
) {
  if (input.taskKind === "draft" && lock) await lockRoomEvidence(tx);
  const channelQuery = tx
    .select({
      id: channels.id,
      account: channels.executionAccountId,
      runtime: channels.executionRuntimeId,
      epoch: channels.executionEpoch,
      holder: channels.executionHolder,
      state: channels.executionState,
    })
    .from(channels)
    .limit(1);
  const [channel] = await (lock ? channelQuery.for("update") : channelQuery);
  const campaignQuery = input.campaignId
    ? tx.select().from(campaigns).where(eq(campaigns.id, input.campaignId))
    : null;
  const [campaign] = campaignQuery
    ? await (lock ? campaignQuery.for("update") : campaignQuery)
    : [];
  if (input.campaignId && !campaign) throw new Error("target_not_found");
  const productQuery = input.productId
    ? tx.select().from(products).where(eq(products.id, input.productId))
    : null;
  const [product] = productQuery
    ? await (lock ? productQuery.for("update") : productQuery)
    : [];
  if (input.productId && !product) throw new Error("product_not_found");
  const facts = input.productId
    ? await tx
        .select()
        .from(productFacts)
        .where(eq(productFacts.productId, input.productId))
        .orderBy(productFacts.id)
    : [];
  const workerQuery = input.workerId
    ? tx.select().from(workers).where(eq(workers.id, input.workerId))
    : null;
  const [worker] = workerQuery
    ? await (lock ? workerQuery.for("share") : workerQuery)
    : [];
  if (input.workerId && (!worker || worker.campaignId !== input.campaignId))
    throw new Error("worker_target_mismatch");
  if (
    worker &&
    input.taskKind === "draft" &&
    (worker.type !== "ambassador" || !campaign || !["review", "auto"].includes((await modeFor(tx, { campaignId: campaign.id, capability: "publish_comment", target: "post" })).effective ?? "off"))
  )
    throw new Error("worker_task_disabled");
  if (worker) {
    if (campaign?.status !== "active") throw new Error("target_paused");
    // A Scout that finds leads has no Find posts task to prepare: its
    // `sweepEnabled` is Find leads' schedule, not the switch for this one.
    if (worker.type === "scout") throw new Error("worker_task_disabled");
    const system = await getSystemState(tx);
    if (system?.killSwitch) throw new Error("kill_switch");
    if (system?.pausedUntil && system.pausedUntil > Date.now())
      throw new Error("organization_paused");
    if (!channel || worker.channelId !== channel.id)
      throw new Error("worker_account_mismatch");
    const authority = await readExecutionAuthority(tx, channel.id);
    if (!authority.allowed) throw new Error(authority.reason);
    // The worker run's own ladder, in its order: a Stop on the campaign, or
    // on its account (Pause LinkedIn), runs nothing in it, prepared here or
    // queued (`campaign_stopped`).
    if ((await campaignStops(tx, campaign)).length > 0)
      throw new Error("campaign_stopped");
  }
  // The voice this task will WRITE, which is the org default unless the
  // deferred phase named another. Frozen here so the guard hash covers it: a
  // task prepared for voice 7 must not apply to whatever became the default
  // while the owner's agent was thinking.
  const fallback = await ensureDefaultVoice(tx);
  const [named] = intent?.voiceId
    ? await tx.select().from(voices).where(eq(voices.id, intent.voiceId))
    : [];
  if (intent?.voiceId && !named) throw new Error("voice_not_found");
  const voice = named ?? fallback;
  const notes = (await listNotes()).map(({ id, content, slot, title }) => ({
    id,
    content,
    slot,
    title,
  }));
  const posts = campaign && input.taskKind === "draft" && (frozenIds || input.requestedPostId)
    ? await campaignCandidates(tx, campaign, frozenIds ?? [String(input.requestedPostId)], lock)
    : [];
  const compiler = campaign ? await snapshotInputs(tx, campaign.id) : null;
  const rooms: Record<number, Awaited<ReturnType<typeof readRoomForDrafting>>> = {};
  if (input.taskKind === "draft") {
    for (const post of posts) rooms[post.id] = await readRoomForDrafting(tx, post.id);
  }
  // The voice a DRAFT is actually written with, which is not `voice` above: a
  // campaign may have its own row attached, and `applyResult` resolves that one
  // for the intake gate's style rules. One read, so it is bound rather than
  // left as a gap — a campaign reattached to another voice mid-task must not
  // have the old voice's rules applied to the draft it accepts.
  const campaignVoice = campaign
    ? await getVoiceForCampaign(tx, campaign)
    : null;
  return {
    channel: channel ?? null,
    campaign: campaign ?? null,
    product: product ?? null,
    facts,
    worker: worker ?? null,
    voice,
    campaignVoice,
    notes,
    compiler,
    knowledgeVersion: await currentKnowledgeVersion(tx),
    posts,
    rooms,
    // Keep the binding key for older tasks, without the retired card focus.
    focus: null,
    angleProfile: input.taskKind === "angle_classification" ? await angleClassificationState(tx) : null,
    samples: input.taskKind === "voice_calibration"
      ? (await eligibleVoiceSamples(tx, voice, 50)).filter((row) => row.ownerAuthored && row.usedInVoiceRevision === null).slice(0, 20)
      : input.taskKind === "angle_classification"
        ? await tx.select({ id: voiceSamples.id, text: voiceSamples.text, discoveredPostId: voiceSamples.discoveredPostId }).from(voiceSamples)
            .where(and(eq(voiceSamples.eligible, true), isNull(voiceSamples.disownedAt), isNull(voiceSamples.angleClassifiedAt)))
            .orderBy(desc(voiceSamples.capturedAt), desc(voiceSamples.id)).limit(20)
        : [],
  };
}

/** The bound sources' hash for one kind — the ONLY input to `stale_context`.
 *  An unknown kind binds the whole snapshot, which is the conservative answer
 *  and the one a new kind gets until it declares what it reads. */
function boundGuard(kind: string, snap: Snapshot): string {
  const keys = TASK_BINDINGS[kind as keyof typeof TASK_BINDINGS] as
    | readonly (keyof Bindable)[]
    | undefined;
  return pickedHash(snap, keys ?? LEGACY_BINDING);
}

/** The campaign columns a terms task is bound to: WHICH campaign, and the sources
 *  and terms it approves — the one thing its apply reads. `status` is not among
 *  them, because a terms task may legitimately be prepared on a paused campaign
 *  (`snapshot` raises `target_paused` only under a worker) and the sweep decides
 *  runnability from the LIVE row anyway (`isSupportedPublicCampaignRuntime` in
 *  `runOverride`, which answers `campaign_not_runnable` with its own recovery);
 *  binding it would have made the owner RESUMING a campaign stale its terms. An
 *  inclusion list rather than the row minus what the compile writes, for the
 *  reason `LEGACY_BINDING` spells itself out: a column added to `campaigns` must
 *  not join a binding by arriving. */
function campaignTargeting(campaign: Campaign | null) {
  if (!campaign) return null;
  const { id, discovery } = campaign;
  return { id, discovery };
}

/** The snapshot plus the projections a binding may name. Computed for the guard
 *  alone: `sources` carries the whole row either way, so a narrowed binding
 *  never narrows what the agent reads. */
function bindable(snap: Snapshot) {
  return { ...snap, campaignTargeting: campaignTargeting(snap.campaign) };
}
type Bindable = ReturnType<typeof bindable>;

function pickedHash(snap: Snapshot, keys: readonly (keyof Bindable)[]): string {
  const bound = bindable(snap);
  return hash(Object.fromEntries(keys.map((key) => [key, bound[key]])));
}

/** The same, for a STORED task: a row prepared before bindings existed keeps
 *  the whole-snapshot guard it was written with. */
function guardOf(kind: string, context: Context, snap: Snapshot): string {
  return context.bindingVersion === BINDING_VERSION
    ? boundGuard(kind, snap)
    : pickedHash(snap, LEGACY_BINDING);
}

/**
 * Does this task's binding still match the world?
 *
 * A snapshot that cannot be READ is MOSTLY not stale, and the split is whether
 * the condition comes back. `snapshot()` raises the run-time refusals a worker
 * task is prepared under — a killed switch, a paused organization, a campaign
 * moved out of `active` — and every one of those lifts; cancelling for one
 * would throw away work the owner's agent can still submit afterwards, and the
 * submit path raises them itself, unchanged, when it comes to write. A row
 * that is GONE does not come back: `target_not_found` and `product_not_found`
 * mean the thing this task was prepared about was deleted, and no submission
 * will ever be accepted again, so those settle as stale with their own reason.
 */
async function taskStaleness(
  tx: Tx,
  task: Task,
  lock = false,
): Promise<{ stale: boolean; reason?: string }> {
  const context = task.context as unknown as Context;
  if (context.stale) return { stale: true, reason: context.stale.reason };
  // A native observation carries no binding and no `input` to re-read.
  if (task.kind === "native_read" || !context.guard || !context.input)
    return { stale: false };
  try {
    const snap = await snapshot(
      tx,
      context.input,
      context.frozenIds,
      context.intent,
      lock,
    );
    return guardOf(task.kind, context, snap) === context.guard
      ? { stale: false }
      : { stale: true, reason: "stale_context" };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return reason.endsWith("_not_found")
      ? { stale: true, reason }
      : { stale: false };
  }
}

/** Record WHY a task can no longer be submitted, on the row. `canceled` is the
 *  durable status (the column's enum has no fifth value and does not need one);
 *  `context.stale` is what makes `get_task` answer `stale` with a
 *  reason instead of the owner's own `cancel_task`. */
async function markStale(tx: Tx, task: Task, reason: string) {
  const context = task.context as unknown as Context;
  context.stale = { reason, at: Date.now() };
  task.context = { ...context } as unknown as Task["context"];
  task.status = "canceled";
  await tx
    .update(tasks)
    .set({ status: "canceled", context: { ...context } })
    .where(eq(tasks.id, task.id));
  await closeRun(tx, context, "canceled");
}

/**
 * The tasks one in-session run prepared BESIDE this one, still open.
 *
 * `skipLocked` because a sibling another transaction is holding is a sibling
 * being submitted right now — leaving it alone is both the right answer and
 * what keeps two concurrent sibling submissions from deadlocking on each
 * other's rows.
 */
async function openSiblings(tx: Tx, context: Context, exceptId: string) {
  if (!context.sessionRunId) return [];
  const rows = await tx
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.status, "awaiting_agent"),
        sql`${tasks.context}->>'sessionRunId' = ${context.sessionRunId}`,
      ),
    )
    .for("update", { skipLocked: true });
  return rows.filter((row) => row.id !== exceptId);
}

/**
 * Settle the tasks this one was prepared BESIDE.
 *
 * `TASK_BINDINGS` is what stops a seed's two tasks invalidating each other,
 * and this is the honest answer for the case it cannot cover: two tasks that
 * genuinely read the same rows, where accepting one really does mean the other
 * was judged against something that no longer holds. The owner's agent learns
 * it once, here, rather than on a `stale_context` it cannot act on.
 *
 * `staleBefore` is read in the same transaction BEFORE this submission wrote
 * anything, which is the only way to tell the two cases apart: a sibling this
 * acceptance broke is `sibling_task_accepted`, and one that was already stale
 * for a reason of its own keeps that reason. Blaming the acceptance for both
 * would point the owner's agent at the wrong task to re-prepare.
 */
async function cancelStaleSiblings(
  tx: Tx,
  siblings: Task[],
  staleBefore: Map<string, string | undefined>,
) {
  for (const sibling of siblings) {
    const verdict = await taskStaleness(tx, sibling);
    if (!verdict.stale) continue;
    const already = staleBefore.get(sibling.id);
    await markStale(tx, sibling, already ?? "sibling_task_accepted");
  }
}

export async function startTask(
  ctx: McpCtx,
  raw: unknown,
  signal = new AbortController().signal,
  /** See `DeferredTask.intent`. A separate argument, not a field on `raw`,
   *  because `raw` is a caller's input and this is the server's own record of
   *  what the deferred phase had already decided to do. */
  intent?: TaskIntent,
  /** The in-session run preparing this task, shared with its siblings. Server-
   *  authored like `intent`, and absent for a directly prepared task. */
  sessionRunId?: string,
) {
  const input = StartTask.parse(raw);
  if (input.requestedPostId && (input.taskKind !== "draft" || input.workerId))
    throw new Error("requested_draft_only");
  if (input.workerId && input.taskKind !== "draft")
    throw new Error("worker_task_unsupported");
  if (
    intent?.firstLook &&
    (!(FIRST_LOOK_TASKS as readonly string[]).includes(input.taskKind) ||
      input.workerId ||
      input.requestedPostId)
  )
    throw new Error("first_look_task_unsupported");
  if (
    ["campaign_brief", "draft"].includes(
      input.taskKind,
    ) &&
    !input.campaignId &&
    !(input.taskKind === "campaign_brief" && input.campaignName && input.productId)
  )
    throw new Error("target_required");
  if (
    input.taskKind === "product_facts" &&
    !input.productId &&
    !input.productName
  )
    throw new Error("product_required");
  if (
    ["product_facts", "brain_notes", "voice_analysis"].includes(
      input.taskKind,
    ) &&
    !input.sourceText
  )
    throw new Error("source_required");
  const external = await withExternalJudgment(() =>
    withOrg(ctx.organizationId, async (tx) => {
      await authorize(tx, ctx, signal, input.taskKind);
      await lockBrainMutation(tx);
      if (input.taskKind === "product_facts" && !input.productId)
        input.productId = await createProduct(tx, { name: input.productName });
      if (input.taskKind === "campaign_brief" && !input.campaignId) {
        const saved = await saveCampaign(tx, ctx.organizationId, { name: input.campaignName, products: [input.productId!], source: "chat", actor: "agent" }, "agent");
        input.campaignId = requireSavedCampaign(saved).campaign!.id;
      }
      let snap = await snapshot(tx, input, undefined, intent);
      // A first look works a campaign that waits for its Start, and only one:
      // once it starts, its own runs take over.
      if (intent?.firstLook && !(snap.campaign && (await awaitingStart(tx, snap.campaign))))
        throw new Error("campaign_started");
      // The owner's ask on a waiting comment, which only the chat broker's own
      // turn carries: words for THAT comment, which needs no draft request.
      const ask = ctx.askedDraft;
      const asking =
        ask && ask.campaignId === input.campaignId && ask.discoveredPostId === input.requestedPostId ? ask : null;
      const asked = asking ? await askedComment(tx, asking, snap) : null;
      if (asking && !asked) throw new Error(ASKED_DRAFT_INACTIVE);
      if (
        input.requestedPostId &&
        !asked &&
        (snap.posts.length !== 1 || snap.posts[0]?.status !== "draft_requested")
      )
        throw new Error("draft_request_inactive");
      let workerDemand: Context["workerDemand"];
      if (snap.worker && input.taskKind === "draft") {
        const channel = await channelCeilings(tx);
        const publish = (await modeFor(tx, { campaignId: snap.campaign!.id, capability: "publish_comment", target: "post" })).effective === "auto";
        const demand = channel
          ? await computeCommentDemand(
              tx,
              {
                channel,
                campaignId: snap.campaign!.id,
                publish,
              },
              Date.now(),
            )
          : { drafts: 0 };
        workerDemand = {
          limit: Math.min(WORKER_DRAFT_TASK_MAX, Math.max(1, demand.drafts)),
          publish: publish && demand.drafts > 0,
          floorOnly: demand.drafts === 0,
        };
        snap = await snapshot(
          tx,
          input,
          snap.posts
            .slice(0, workerDemand.limit)
            .map((post) => String(post.id)),
          intent,
        );
      }
      const frozenIds = input.taskKind === "draft"
        ? snap.posts.map((p) => String(p.id))
        : input.taskKind === "voice_calibration" || input.taskKind === "angle_classification"
          ? snap.samples.map((sample) => String(sample.id)) : ["source"];
      if ((input.taskKind === "voice_calibration" || input.taskKind === "angle_classification") && frozenIds.length === 0)
        throw new Error("no_new_samples");
      const drafting =
        input.taskKind === "draft" && snap.campaign
          ? await Promise.all(
              snap.posts.map((p) =>
                getCommentDraftingContext(tx, snap.campaign!, {
                  discoveredPostId: p.id,
                  llm: null,
                }),
              ),
            )
          : [];
      let runId: number | undefined;
      if (snap.worker && snap.channel) {
        const [run] = await tx
          .insert(workerRuns)
          .values({
            workerId: snap.worker.id,
            campaignId: input.campaignId!,
            channelId: snap.channel.id,
            trigger: "agent",
            status: "partial",
            agentTaskStatus: "awaiting_agent",
            finishedAt: Date.now(),
            phase: "draft",
            error: "awaiting_agent",
            demandCount: workerDemand?.limit ?? 0,
          })
          .returning();
        runId = run!.id;
      }
      const postIds = input.taskKind === "angle_classification" ? snap.samples.flatMap((sample) => sample.discoveredPostId == null ? [] : [sample.discoveredPostId]) : [];
      const angleRows = postIds.length ? await tx.select({ id: discoveredPosts.id, angle: discoveredPosts.agentAngle }).from(discoveredPosts).where(inArray(discoveredPosts.id, postIds)) : [];
      const angles = new Map(angleRows.map((row) => [row.id, row.angle]));
      const sources = {
        ...snap,
        sourceText: input.sourceText ?? null,
        samples: snap.samples.map((sample) => ({ ...sample, text: untrusted("VOICE SAMPLE", sample.text), ...(input.taskKind === "angle_classification" ? { offeredAngles: sample.discoveredPostId != null && angles.get(sample.discoveredPostId) ? [angles.get(sample.discoveredPostId)] : [] } : {}) })),
        drafting,
      };
      if (Buffer.byteLength(JSON.stringify(sources)) > 256 * 1024)
        throw new Error("task_context_oversized");
      const context: Context = {
        input,
        frozenIds,
        sources,
        guard: boundGuard(input.taskKind, snap),
        bindingVersion: BINDING_VERSION,
        account: snap.channel,
        ...(sessionRunId ? { sessionRunId } : {}),
        ...(runId ? { runId } : {}),
        ...(intent ? { intent } : {}),
        ...(workerDemand ? { workerDemand } : {}),
        ...(asked ? { asked } : {}),
      };
      const contextRevision = hash({ sources, frozenIds });
      const [task] = await tx
        .insert(tasks)
        .values({
          credentialBinding: credential(ctx),
          kind: input.taskKind,
          context: { ...context },
          contextRevision,
          expiresAt: Date.now() + 30 * 60_000,
        })
        .returning();
      return view(task!);
    }),
  );
  return { ...external.result, pendingTasks: external.pendingTasks };
}

/** What a first look owes the caller's agent when no background agent can
 *  think for it, in the order it owes them. */
export const FIRST_LOOK_TASKS = ["draft"] as const;
export type FirstLookTaskKind = (typeof FIRST_LOOK_TASKS)[number];

/**
 * What a caller can DO about a task it can no longer submit.
 *
 * Stated on the canonical read because that is where an agent arrives after a
 * refusal, and the one thing it must not do is send NEW work to the dead id or
 * copy a revision from a task of another kind. A stale row is not work to redo
 * blindly: its bound inputs moved, so the fresh task — prepared from the state
 * that now holds — is the one whose id and revision are submittable, and only
 * while the work is still owed (`get_status` says so for a brief). What a
 * settled row DID accept is untouched by any of that: a receipt replay is still
 * answered from the row, so "dead for new work" is never "this id is gone".
 *
 */
function taskRecovery(task: Task, context: Context): string | undefined {
  if (context.stale) {
    const reason = context.stale.reason;
    if (reason === "target_not_found" || reason === "product_not_found")
      return `The ${reason === "target_not_found" ? "campaign" : "product"} this task was prepared for no longer exists, so it can never accept a submission. Recreate or re-target it, then prepare a fresh ${task.kind} task.`;
    return "Its bound inputs changed after it was prepared, so no NEW submission will be accepted against this id — an identical receipt from before it settled still replays. Read get_status for the current state, and if this work is still owed call start_task again (same taskKind, current campaign or source) and submit the FRESH task's id and contextRevision. A campaign_brief is the one kind a scheduled compile can satisfy while it waits: when the campaign's brief now exists, do not prepare a second one — continue with that campaign's remaining owed work instead.";
  }
  if (task.status === "expired")
    return "Its 30-minute lifetime ended with items still unfinished. Every item it already accepted and its receipt stay durable — an identical replay of that receipt still answers from it — and only the unfinished items went with the task. If that remaining work is still owed, call start_task again from the current state and submit the FRESH task's id and contextRevision.";

  return undefined;
}

function view(task: Task) {
  const context = task.context as unknown as Context;
  // What the agent reads, not what the row holds: `wireSources` hoists the
  // drafting fields every frozen candidate shares (see draftContext.ts). The
  // row is untouched, so `drafting` still hashes the STORED array — shared
  // fields included — and an agent that edits nothing computes the revision it
  // computed before the hoist.
  const sources = wireSources(context.sources);
  const recovery = taskRecovery(task, context);
  return {
    id: task.id,
    contractVersion: 1,
    taskKind: task.kind,
    phase: context.draftReview ? "evidence_review" : "judgment",
    contextRevision: task.contextRevision,
    frozenItemIds: context.frozenIds,
    sourceRefs: Object.keys(sources),
    sourceHashes: Object.fromEntries(
      Object.keys(sources).map((key) => [
        key,
        hash(key === "drafting" ? context.sources[key] : sources[key]),
      ]),
    ),
    sources,
    outputSchemaVersion: 1,
    outputSchema: zodToJsonSchema(
      context.draftReview
        ? ReviewOutput
        : outputs[task.kind as keyof typeof outputs],
    ),
    limits: { items: task.kind === "draft" ? 5 : 20, bytes: 256 * 1024 },
    expiresAt: task.expiresAt,
    // `stale` is a READ of the stored `canceled` row, not a fifth column value:
    // a task whose binding stopped matching and one the owner cancelled are
    // both unsubmittable, and telling them apart is the difference between "do
    // it again from the current state" and "you already said no".
    status: context.stale ? "stale" : task.status,
    ...(context.stale ? { staleReason: context.stale.reason } : {}),
    ...(recovery ? { recovery } : {}),
    receipts: task.receipts,
    workerRunId: context.runId ?? null,
    // Only where one can exist, and only once one does: every other task kind
    // would carry a permanent `null` teaching agents to poll something that is
    // never going to fill in.
  };
}

async function lockedTask(
  tx: Tx,
  ctx: McpCtx,
  taskId: string,
  signal: AbortSignal,
) {
  const [task] = await tx
    .select()
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .for("update");
  if (!task || task.credentialBinding !== credential(ctx))
    throw new NotFoundError("Task not found.");
  if (task.kind !== "native_read" && !TaskKind.safeParse(task.kind).success) throw new Error("task_kind_retired");
  await authorize(tx, ctx, signal, task.kind);
  return task;
}

async function closeRun(tx: Tx, context: Context, reason: string) {
  if (context.runId) await refreshRun(tx, context.runId);
}

/**
 * Settle the tasks whose agent never came back, so a run's owner-facing state
 * and counters stop describing work that can no longer happen. Called from the
 * scheduler tick: an abandoned task is a durable row, not a queue, and nothing
 * else reads it once the client is gone.
 *
 * BOUNDED and idempotent — oldest expiries first, one page per tick, already
 * locked rows skipped — so this can never become a full scan of the table on
 * every poll. It settles the run's record only; sibling tasks that are still
 * live keep their own status and can still submit into the same run.
 */
export async function settleExpiredTasks(
  tx: Tx,
  now = Date.now(),
  limit = 50,
): Promise<number> {
  const expired = await tx
    .select({ id: tasks.id, context: tasks.context })
    .from(tasks)
    .where(
      and(
        eq(tasks.status, "awaiting_agent"),
        lte(tasks.expiresAt, now),
      ),
    )
    .orderBy(tasks.expiresAt)
    .limit(limit)
    .for("update", { skipLocked: true });
  if (!expired.length) return 0;
  await tx
    .update(tasks)
    .set({ status: "expired" })
    .where(
      inArray(
        tasks.id,
        expired.map((task) => task.id),
      ),
    );
  const runs = new Set(
    expired
      .map((task) => (task.context as unknown as Context).runId)
      .filter((runId): runId is number => runId != null),
  );
  for (const runId of runs) await refreshRun(tx, runId, now);
  return expired.length;
}

/** Multiple author/reviewer batches share one run; finishing one child cannot
 * make the unfinished siblings disappear from its status or counters. */
async function refreshRun(tx: Tx, runId: number, now = Date.now()) {
  const runTasks = await tx
    .select()
    .from(tasks)
    .where(sql`${tasks.context}->>'runId' = ${String(runId)}`);
  const drafted = new Set<string>();
  const scheduled = new Set<string>();
  for (const task of runTasks) {
    const context = task.context as unknown as Context;
    const ids = Object.values(
      task.receipts as Record<string, Receipt>,
    ).flatMap((receipt) =>
      receipt.items.filter((item) => item.accepted).map((item) => item.id),
    );
    if (context.draftReview) ids.forEach((id) => drafted.add(id));
    if (context.draftReview)
      for (const receipt of Object.values(
        task.receipts as Record<string, Receipt>,
      )) {
        for (const item of receipt.items)
          if (
            item.accepted &&
            item.result &&
            typeof item.result === "object" &&
            "scheduled" in item.result &&
            item.result.scheduled === true
          )
            scheduled.add(item.id);
      }
  }
  const expiries = runTasks
    .filter(
      (task) =>
        task.status === "expired" ||
        (task.status === "awaiting_agent" && task.expiresAt <= now),
    )
    .map((task) => task.expiresAt);
  const state = expiries.length
    ? "expired"
    : runTasks.some((task) => task.status === "canceled")
      ? "canceled"
      : runTasks.some((task) => task.status === "awaiting_agent")
        ? "awaiting_agent"
        : "completed";
  await tx
    .update(workerRuns)
    .set({
      status: state === "completed" ? "succeeded" : "partial",
      agentTaskStatus: state,
      error: state === "completed" ? null : state,
      draftedCount: drafted.size,
      publishedCount: scheduled.size,
      // An expired run ended when its work ran out of time, not when a sweep
      // got round to noticing — so the record does not move with the tick.
      finishedAt: expiries.length ? Math.max(...expiries) : now,
    })
    .where(eq(workerRuns.id, runId));
}

/**
 * The tasks this org still owes judgment on — id and kind only.
 *
 * The index an in-session fallback needs and nothing more. A tool call that
 * outran its bound (`{started: true}`) prepares its task after the reply is
 * already gone, so SOMETHING has to surface it later, and `get_status` is
 * what an agent is already polling. Deliberately no context and no sources:
 * this is a pointer list, and `get_task` is the read.
 *
 * A stale one is settled here rather than listed. `get_status.next` tells
 * the owner's agent that nothing moves until the prepared tasks are submitted,
 * so a task nothing will ever accept must not be one of them — that is the
 * shape the 2026-09-15 measurement left behind: `voice_analysis` refused
 * `stale_context` on submit and still counted as owed work on every poll.
 */
export async function listOpenTasks(
  tx: Tx,
  now = Date.now(),
): Promise<{ id: string; taskKind: string; expiresAt: number }[]> {
  const rows = await tx
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.status, "awaiting_agent"),
        sql`${tasks.expiresAt} > ${now}`,
      ),
    )
    .orderBy(tasks.createdAt);
  const open: { id: string; taskKind: string; expiresAt: number }[] = [];
  for (const row of rows) {
    if (!TaskKind.safeParse(row.kind).success) {
      await markStale(tx, row, "task_kind_retired");
      continue;
    }
    const verdict = await taskStaleness(tx, row);
    if (verdict.stale) {
      await markStale(tx, row, verdict.reason ?? "stale_context");
      continue;
    }
    open.push({ id: row.id, taskKind: row.kind, expiresAt: row.expiresAt });
  }
  return open;
}

/** Why words asked for a waiting comment join nothing: it was approved,
 *  skipped, redrafted or swapped after the ask. */
export const ASKED_DRAFT_INACTIVE = "asked_draft_inactive";

/**
 * The waiting comment an ask names, as the ask froze it: an agent's draft on
 * the asked-about post, still waiting for a yes, with no Redraft open — with
 * the angle and the move a draft written for it joins its set with. Null
 * where there is no such comment now.
 */
async function askedComment(
  tx: Tx,
  ask: AskedDraft,
  snap: Snapshot,
): Promise<Context["asked"] | null> {
  if (snap.posts.length !== 1) return null;
  const [comment] = await tx
    .select({ id: messages.id, requestVersion: messages.redraftRequestVersion })
    .from(messages)
    .where(waitingComment(ask.messageId, snap.posts[0]!));
  if (!comment) return null;
  const key = boxKey({ kind: "comment", discoveredPostId: ask.discoveredPostId });
  const box = ask.angle ? (await composerFor(tx, [key])).get(key) : null;
  return {
    messageId: comment.id,
    requestVersion: comment.requestVersion,
    angle: ask.angle,
    move: ask.angle ? (box?.angles.find((angle) => angle.why === ask.angle)?.move ?? "") : "",
  };
}

/** The comment, while it is still an agent's draft on `post` waiting for a
 *  yes, with no Redraft open. */
function waitingComment(messageId: number, post: { id: number; campaignId: number }) {
  return and(
    eq(messages.id, messageId),
    eq(messages.campaignId, post.campaignId),
    eq(messages.discoveredPostId, post.id),
    eq(messages.kind, "comment"),
    eq(messages.status, "proposed"),
    eq(messages.publishOrigin, "worker"),
    isNull(messages.redraftRequestId),
  );
}

/** Whether the owner's ask a requested task serves is still open: the post's
 *  draft request, or the waiting comment the words were asked for. */
async function askStillOpen(tx: Tx, context: Pick<Context, "asked">, snap: Snapshot): Promise<boolean> {
  const post = snap.posts.length === 1 ? snap.posts[0] : undefined;
  if (!post) return false;
  if (!context.asked) return post.status === "draft_requested";
  const [comment] = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(waitingComment(context.asked.messageId, post));
  return comment !== undefined;
}

/** App-owned angle exploration uses the same frozen post and authorization as
 * a requested draft. It cannot deliver comment text or publish anything. Each
 * angle is stored with the move it makes. */
export async function deliverRequestedAngles(
  ctx: McpCtx,
  input: { taskId: string; contextRevision: string; angles: { move: AssistMove; text: string }[] },
  signal: AbortSignal,
) {
  const angles = z
    .array(z.object({ move: z.enum(ASSIST_MOVES), text: z.string().trim().min(1).max(300) }).strict())
    .length(3)
    .parse(input.angles);
  if (new Set(angles.map((angle) => angle.move)).size !== 3) throw new Error("distinct_angle_moves_required");
  await withOrg(ctx.organizationId, async (tx) => {
    const task = await lockedTask(tx, ctx, input.taskId, signal);
    const context = task.context as unknown as Context;
    if (
      task.kind !== "draft" ||
      !context.input.requestedPostId ||
      context.input.workerId ||
      context.frozenIds.length !== 1 ||
      context.intent ||
      context.runId
    )
      throw new Error("requested_draft_only");
    if (task.status !== "awaiting_agent" || task.expiresAt <= Date.now())
      throw new Error("task_inactive");
    await lockBrainMutation(tx);
    const snap = await snapshot(
      tx,
      context.input,
      context.frozenIds,
      context.intent,
    );
    if (
      task.contextRevision !== input.contextRevision ||
      context.stale ||
      guardOf(task.kind, context, snap) !== context.guard ||
      !(await askStillOpen(tx, context, snap))
    )
      throw new Error("stale_context");
    signal.throwIfAborted();
    for (const angle of angles) {
      try {
        await putComposerIdea(tx, {
          box: boxKey({ kind: "comment", discoveredPostId: context.input.requestedPostId }),
          move: angle.move, why: angle.text, campaignId: context.input.campaignId,
        });
      } catch (error) {
        // A full box keeps the angles it holds; the rest have nowhere to land.
        if (error instanceof AppError && error.code === "composer_full") break;
        throw error;
      }
    }
    // The assist and this receipt commit together, which is what lets the
    // broker's recovery read the receipt as proof the delivery landed.
    const receipt: Receipt = {
      hash: hash(angles),
      acceptedCount: 1,
      incompleteIds: [],
      items: [
        {
          id: String(context.input.requestedPostId),
          accepted: true,
          result: { angles },
        },
      ],
    };
    await tx
      .update(tasks)
      .set({ status: "completed", receipts: { angles: receipt } })
      .where(eq(tasks.id, task.id));
  });
}

export async function getTask(
  ctx: McpCtx,
  taskId: string,
  cancel = false,
  signal = new AbortController().signal,
) {
  return withOrg(ctx.organizationId, async (tx) => {
    const task = await lockedTask(tx, ctx, taskId, signal);
    if (
      task.status === "awaiting_agent" &&
      (cancel || task.expiresAt <= Date.now())
    ) {
      task.status = cancel ? "canceled" : "expired";
      await tx
        .update(tasks)
        .set({ status: task.status })
        .where(eq(tasks.id, task.id));
      await closeRun(tx, task.context as unknown as Context, task.status);
    }
    // The read is where a task last held open on a binding that stopped
    // matching gets settled. Before this, `get_task` answered
    // `awaiting_agent` with the original `contextRevision` for a task whose
    // every submission was already refused. Unlocked, like the poll: this read
    // writes nothing but the task row `lockedTask` already holds, and taking
    // `FOR UPDATE` on the channel and the campaign here would queue an agent's
    // inspection behind the worker it is inspecting.
    if (task.status === "awaiting_agent") {
      const verdict = await taskStaleness(tx, task);
      if (verdict.stale)
        await markStale(tx, task, verdict.reason ?? "stale_context");
    }
    if (task.kind === "native_read")
      return {
        id: task.id,
        status: task.status,
        contextRevision: task.contextRevision,
        expiresAt: task.expiresAt,
        receipts: task.receipts,
        sources: task.context,
      };
    return view(task);
  });
}

/** Cancel unfinished work under the same revision and replay contract as a submission. */
export async function cancelTask(ctx: McpCtx, input: { taskId: string; contextRevision: string; idempotencyKey: string }, signal = new AbortController().signal) {
  return withOrg(ctx.organizationId, async (tx) => {
    const task = await lockedTask(tx, ctx, input.taskId, signal);
    const receipts = task.receipts as Record<string, Receipt>;
    const digest = hash({ ...input, cancel: true });
    const previous = receipts[input.idempotencyKey];
    if (previous) {
      if (previous.hash !== digest) throw new Error("task_receipt_conflict");
      return previous;
    }
    if (task.contextRevision !== input.contextRevision) throw new Error("stale_context");
    if (task.status !== "awaiting_agent" || task.expiresAt <= Date.now()) throw new Error("task_inactive");
    const context = task.context as unknown as Context;
    const accepted = new Set(Object.values(receipts).flatMap((receipt) => receipt.items.filter((item) => item.accepted).map((item) => item.id)));
    const receipt: Receipt = { hash: digest, items: [], incompleteIds: context.frozenIds.filter((id) => !accepted.has(id)), acceptedCount: 0 };
    receipts[input.idempotencyKey] = receipt;
    await tx.update(tasks).set({ status: "canceled", receipts }).where(eq(tasks.id, task.id));
    await closeRun(tx, context, "canceled");
    return receipt;
  });
}

/** How much of a mismatched submission a refusal carries: the first few ids,
 *  each clipped. Enough for the caller to see the shape it sent — the same
 *  discipline as `SCHEMA_DETAIL_ISSUES` above, and deliberately not the
 *  submission again. */
const UNFROZEN_DETAIL_IDS = 5;
const UNFROZEN_DETAIL_CHARS = 120;
const boundedIds = (ids: string[]) =>
  ids
    .slice(0, UNFROZEN_DETAIL_IDS)
    .map((item) => item.slice(0, UNFROZEN_DETAIL_CHARS));

/**
 * A submission named item ids this task never froze.
 *
 * `message` stays the stable `unfrozen_item` every direct caller already
 * branches on; `data` is what the MCP tool answers with, so the refusal can be
 * CORRECTED in one more call instead of guessed at. Every id in it belongs to
 * the task the caller already passed credential, revision, staleness and
 * status checks for — never a sibling's, another tenant's, or the source
 * corpus.
 */
export class UnfrozenItemError extends AppError {
  readonly data: {
    taskKind: string;
    expectedItemIds: string[];
    unexpectedItemIds: string[];
    unexpectedIncompleteIds: string[];
    duplicateItemIds: string[];
  };
  constructor(
    kind: string,
    frozenIds: readonly string[],
    itemIds: string[],
    incompleteIds: string[],
  ) {
    super("unfrozen_item", "unfrozen_item", 409);
    const frozen = new Set(frozenIds);
    this.data = {
      taskKind: kind,
      expectedItemIds: [...frozenIds],
      unexpectedItemIds: boundedIds(itemIds.filter((item) => !frozen.has(item))),
      unexpectedIncompleteIds: boundedIds(
        incompleteIds.filter((item) => !frozen.has(item)),
      ),
      duplicateItemIds: boundedIds(
        itemIds.filter((item, index) => itemIds.indexOf(item) !== index),
      ),
    };
  }
}

export async function finishTask(
  ctx: McpCtx,
  raw: unknown,
  signal = new AbortController().signal,
) {
  const input = TaskSubmission.parse(raw);
  if (Buffer.byteLength(JSON.stringify(input)) > 256 * 1024)
    throw new Error("task_input_oversized");
  // What this submission landed of a campaign's firsts, told once it commits.
  const landed: {
    campaign: Campaign | null;
    since: number;
    matched: number[];
    boxes: number[];
    comments: number[];
    /** The first look this submission settled the last task of. */
    firstLookDone: { campaignId: number; drafted: number } | null;
  } = { campaign: null, since: Date.now(), matched: [], boxes: [], comments: [], firstLookDone: null };
  const external = await withExternalJudgment(() =>
    withOrg(ctx.organizationId, async (tx) => {
      const task = await lockedTask(tx, ctx, input.taskId, signal);
      if (task.kind === "native_read")
        throw new Error("native_submission_required");
      const receipts = task.receipts as Record<string, Receipt>;
      const previous = receipts[input.idempotencyKey];
      if (previous) {
        const { taskId, ...rest } = input;
        if (previous.hash !== hash(input) && previous.hash !== hash({ stageId: taskId, ...rest }))
          throw new Error("task_receipt_conflict");
        return previous;
      }
      if (task.contextRevision !== input.contextRevision)
        throw new Error("stale_context");
      const context = task.context as unknown as Context;
      // A task already settled as stale answers with WHY it was settled, not
      // `task_inactive` — the row is `canceled`, but nobody cancelled it.
      if (context.stale) throw new Error("stale_context");
      if (task.status !== "awaiting_agent" || task.expiresAt <= Date.now())
        throw new Error("task_inactive");
      await lockBrainMutation(tx);
      const snap = await snapshot(
        tx,
        context.input,
        context.frozenIds,
        context.intent,
      );
      // Settled by the next READ, deliberately not here: this throw rolls the
      // transaction back, so a `canceled` written on the way out would go with
      // it. `get_task` and `get_status` both re-check.
      if (guardOf(task.kind, context, snap) !== context.guard)
        throw new Error("stale_context");
      const ids = input.items.map((item) => item.id);
      if (
        new Set(ids).size !== ids.length ||
        [...ids, ...input.incompleteIds].some(
          (item) => !context.frozenIds.includes(item),
        )
      )
        throw new UnfrozenItemError(
          task.kind,
          context.frozenIds,
          ids,
          input.incompleteIds,
        );
      if (task.kind === "voice_calibration" || task.kind === "angle_classification") {
        const accepted = new Set(Object.values(receipts).flatMap((receipt) => receipt.items.filter((item) => item.accepted).map((item) => item.id)));
        const items = input.items.filter((item) => !accepted.has(item.id));
        const evidence = new Set(Object.keys(wireSources(context.sources)));
        if (items.some((item) => !item.evidenceRefs.length || item.evidenceRefs.some((ref) => !evidence.has(ref)))) throw new Error("unknown_evidence");
        let applied: unknown = null;
        if (items.length && task.kind === "angle_classification") {
          const values = items.map((item) => ({ sampleId: Number(item.id), ...outputs.angle_classification.parse(item.result) }));
          const result = await submitAngleClassifications(tx, { expectedProfileRevision: snap.angleProfile!.profileRevision, classifications: values });
          if (!result.ok || result.classified !== items.length) throw new Error(result.ok ? "stale_context" : result.code);
          applied = result;
        } else if (items.length) {
          const values = items.map((item) => outputs.voice_calibration.parse(item.result));
          const value = values[0]!;
          if (values.some((other) => hash(other) !== hash(value))) throw new Error("calibration_results_differ");
          const [voice] = await tx.select().from(voices).where(eq(voices.id, snap.voice.id)).for("update");
          if (!voice || voice.revision !== snap.voice.revision) throw new Error("stale_context");
          const valid = await tx.select({ id: voiceSamples.id }).from(voiceSamples).where(and(inArray(voiceSamples.id, items.map((item) => Number(item.id))), voiceEvidence(voice), isNull(voiceSamples.usedInVoiceRevision)));
          if (valid.length !== items.length) throw new Error("stale_context");
          const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(voiceSamples).where(and(voiceEvidence(voice), isNotNull(voiceSamples.usedInVoiceRevision)));
          const total = (count?.n ?? 0) + valid.length;
          const voiceData = { persona: value.persona, houseStyle: value.houseStyle, learnedFrom: total, sources: ["voice_samples"] };
          if (voice.isDefault) await setChannelVoice(tx, "comment", voiceData);
          else await setVoiceChannel(tx, voice.id, "comment", voiceData);
          if (value.styleRules) {
            const rules: StyleRules = { emDashes: value.styleRules.emDashes ?? null, semicolons: value.styleRules.semicolons ?? null, emojiMax: value.styleRules.emojiMax ?? null, casing: value.styleRules.casing ?? null, bannedOpeners: value.styleRules.bannedOpeners ?? null, closerQuestionPolicy: value.styleRules.closerQuestionPolicy ?? null, shorthand: value.styleRules.shorthand ?? null, roughEdges: value.styleRules.roughEdges ?? null, extras: value.styleRules.extras ?? null };
            await mergeLearnedStyleRules(tx, voice.id, rules, { refine: valid.length >= 2 });
          }
          const [updated] = await tx.update(voices).set({ maturity: total >= 2 || voice.maturity === "calibrated" ? "calibrated" : "provisional", calibrationSampleCount: total, calibratedAt: Date.now(), revision: sql`${voices.revision} + 1`, updatedAt: Date.now() }).where(eq(voices.id, voice.id)).returning({ revision: voices.revision, maturity: voices.maturity });
          if (!updated) throw new Error("voice_not_found");
          const ids = valid.map((row) => row.id);
          const samplesConsumed = await consumeVoiceSamples(tx, { voiceId: voice.id, sampleIds: ids, revision: updated.revision });
          if (samplesConsumed !== ids.length) throw new Error("stale_context");
          await snapshotVoiceRevision(tx, { voiceId: voice.id, source: "client_calibration", consumedSampleIds: ids });
          applied = { voiceId: voice.id, revision: updated.revision, maturity: updated.maturity, samplesConsumed };
        }
        for (const item of items) accepted.add(item.id);
        const receipt: Receipt = { hash: hash(input), items: input.items.map((item) => accepted.has(item.id) && items.includes(item) ? { id: item.id, accepted: true, result: applied } : { id: item.id, accepted: false, reason: "item_already_committed" }), incompleteIds: context.frozenIds.filter((id) => !accepted.has(id)), acceptedCount: items.length };
        receipts[input.idempotencyKey] = receipt;
        context.guard = guardOf(task.kind, context, await snapshot(tx, context.input, context.frozenIds, context.intent));
        await tx.update(tasks).set({ receipts, context: { ...context }, status: receipt.incompleteIds.length ? "awaiting_agent" : "completed" }).where(eq(tasks.id, task.id));
        return receipt;
      }
      // Read BEFORE a single apply writes: whether each sibling was already
      // stale on its own account is the one fact `cancelStaleSiblings` cannot
      // recover afterwards, and it decides which reason lands on the row.
      const siblings = await openSiblings(tx, context, task.id);
      const staleBefore = new Map<string, string | undefined>();
      for (const sibling of siblings) {
        const verdict = await taskStaleness(tx, sibling);
        if (verdict.stale)
          staleBefore.set(sibling.id, verdict.reason ?? "stale_context");
      }
      const accepted = new Set(
        Object.values(receipts).flatMap((receipt) =>
          receipt.items.filter((item) => item.accepted).map((item) => item.id),
        ),
      );
      const receipt: Receipt = {
        hash: hash(input),
        items: [],
        incompleteIds: [],
        acceptedCount: 0,
      };
      // Evidence names what the AGENT read, so it is checked against the wire
      // form: a draft task advertises `draftingShared`, and citing it is
      // citing the bytes the hoist moved, not inventing a source.
      const evidence = new Set(Object.keys(wireSources(context.sources)));
      for (const item of input.items) {
        if (accepted.has(item.id)) {
          receipt.items.push({
            id: item.id,
            accepted: false,
            reason: "item_already_committed",
          });
          continue;
        }
        const schema = context.draftReview
          ? ReviewOutput
          : outputs[task.kind as keyof typeof outputs];
        const parsed = schema.safeParse(item.result);
        if (!parsed.success) {
          receipt.items.push({
            id: item.id,
            accepted: false,
            reason: "invalid_task_output",
            detail: schemaDetail(parsed.error),
          });
          continue;
        }
        if (item.evidenceRefs.some((ref) => !evidence.has(ref))) {
          receipt.items.push({
            id: item.id,
            accepted: false,
            reason: "unknown_evidence",
            detail: item.evidenceRefs
              .filter((ref) => !evidence.has(ref))
              .join(", "),
            allowedEvidence: [...evidence],
          });
          continue;
        }
        if (!item.evidenceRefs.length) {
          receipt.items.push({
            id: item.id,
            accepted: false,
            reason: "evidence_required",
          });
          continue;
        }
        const result = await applyResult(
          tx,
          task.kind as keyof typeof outputs,
          parsed.data,
          Number(item.id),
          context,
          snap,
        );
        if (result.ok) {
          accepted.add(item.id);
          receipt.acceptedCount++;
          if (snap.campaign) {
            landed.campaign = snap.campaign;
            if (typeof result.messageId === "number") landed.comments.push(result.messageId);
            if (result.assist) landed.boxes.push(Number(item.id));
          }
        }
        // A refused apply's own words are lifted to the ITEM, the way triage
        // lifts its `reason` above: the receipt's contract is
        // `items[].reason` and `items[].detail`, and a url that says which
        // source the evidence does not hold is no use to an agent that has to
        // know to go digging for it. `result` still carries the whole object.
        const refusal = result as { reason?: unknown; detail?: unknown };
        receipt.items.push({
          id: item.id,
          accepted: result.ok,
          result,
          ...(!result.ok && typeof refusal.reason === "string"
            ? { reason: refusal.reason }
            : {}),
          ...(!result.ok && typeof refusal.detail === "string"
            ? { detail: refusal.detail }
            : {}),
        });
      }
      receipt.incompleteIds = context.frozenIds.filter(
        (item) => !accepted.has(item),
      );
      if (
        task.kind === "draft" &&
        !context.draftReview &&
        receipt.acceptedCount
      ) {
        const draftReview: NonNullable<Context["draftReview"]> = {};
        for (const item of input.items.filter((item) =>
          receipt.items.some(
            (result) => result.id === item.id && result.accepted,
          ),
        )) {
          const post = snap.posts.find((post) => String(post.id) === item.id)!;
          const prepared = await getCommentDraftingContext(tx, snap.campaign!, {
            discoveredPostId: post.id,
            llm: null,
          });
          if (!prepared.ok) throw new Error("draft_context_unavailable");
          draftReview[item.id] = {
            draft: outputs.draft.parse(item.result),
            evidence: {
              post: post.contentText ?? "",
              postedAt: post.postedAt,
              authorName: post.authorName,
              knowledge: prepared.data.brain.knowledge,
              constraints: prepared.data.brain.constraints,
              writingInstructions: prepared.data.systemPrompt,
              productFacts: productEvidenceFacts(prepared.data.products),
              ...(prepared.data.research?.room ? { room: prepared.data.research.room } : {}),
            },
          };
        }
        const sources = {
          // A draft the owner asked for may come back with slips of style
          // named instead of refused; a worker's never does.
          reviewInstructions: snap.worker && context.runId ? EVIDENCE_SYSTEM : `${EVIDENCE_SYSTEM}\n${SLIPS_SYSTEM}`,
          drafts: draftReview,
        };
        const childContext: Context = {
          ...context,
          frozenIds: Object.keys(draftReview),
          sources,
          draftReview,
          bindingVersion: BINDING_VERSION,
          guard: boundGuard(
            "draft",
            await snapshot(
              tx,
              context.input,
              Object.keys(draftReview),
              context.intent,
            ),
          ),
        };
        const [child] = await tx
          .insert(tasks)
          .values({
            credentialBinding: credential(ctx),
            kind: "draft",
            context: { ...childContext },
            contextRevision: hash(sources),
            expiresAt: task.expiresAt,
          })
          .returning();
        receipt.nextRequiredTask = {
          id: child!.id,
          kind: "draft",
          phase: "evidence_review",
        };
      }
      const pending = pendingTasks();
      if (pending.length) receipt.pendingTasks = pending;
      receipts[input.idempotencyKey] = receipt;
      context.guard = guardOf(
        task.kind,
        context,
        await snapshot(tx, context.input, context.frozenIds, context.intent),
      );
      const completed = receipt.incompleteIds.length === 0;
      await tx
        .update(tasks)
        .set({
          receipts,
          context: { ...context },
          status: completed ? "completed" : "awaiting_agent",
        })
        .where(eq(tasks.id, task.id));
      // A first look is over when its evidence review settles with none of its
      // tasks left open: a draft still owed its other items is not the end.
      if (completed && context.draftReview && context.intent?.firstLook && snap.campaign) {
        const [open] = await tx
          .select({ id: tasks.id })
          .from(tasks)
          .where(
            and(
              ne(tasks.id, task.id),
              eq(tasks.credentialBinding, credential(ctx)),
              sql`${tasks.context}->'intent'->>'firstLook' = 'true'`,
              sql`${tasks.context}->'input'->>'campaignId' = ${String(snap.campaign.id)}`,
              eq(tasks.status, "awaiting_agent"),
              sql`${tasks.expiresAt} > ${Date.now()}`,
            ),
          )
          .limit(1);
        if (!open) {
          landed.firstLookDone = { campaignId: snap.campaign.id, drafted: landed.boxes.length };
        }
      }
      if (receipt.acceptedCount)
        await cancelStaleSiblings(tx, siblings, staleBefore);
      if (context.runId) await refreshRun(tx, context.runId);
      return receipt;
    }),
  );
  if (landed.campaign) {
    await trackFirstDraft(ctx.organizationId, landed.campaign, { boxes: { postIds: landed.boxes, since: landed.since } });
    await trackFirstDraft(ctx.organizationId, landed.campaign, { messageIds: landed.comments });
  }
  return external.result;
}

async function applyResult(
  tx: Tx,
  kind: keyof typeof outputs,
  raw: unknown,
  itemId: number,
  context: Context,
  snap: Awaited<ReturnType<typeof snapshot>>,
): Promise<{ ok: boolean; [key: string]: unknown }> {
  switch (kind) {
    case "voice_calibration":
    case "angle_classification":
      throw new Error("task_batch_required");
    case "product_facts": {
      const value = outputs.product_facts.parse(raw);
      // WHERE the bytes came from, when the deferring phase said so
      // (`url:<host>`, `file:<path>`, `text:<attribution>`): a product fact is
      // held to the same "go back and check it" rule a Brain note is. The
      // digest stays the fallback for a task nobody attributed — it still
      // distinguishes two submissions over two different corpora.
      const factSourcePath =
        context.intent?.sourcePath ?? `prepared:${hash(context.sources)}`;
      let inserted = 0;
      for (const fact of value.facts)
        if (
          await storeProductFact(tx, {
            productId: snap.product!.id,
            ...fact,
            source: "manual",
            sourcePath: factSourcePath,
          })
        )
          inserted++;
      // The same staleness signal every other product-fact writer sends. Under
      // the external judgment policy the recompile is DEFERRED, not queued: the
      // receipt says a campaign_brief task is owed, and no model job exists.
      if (inserted) await enqueueRecompileForProduct(tx, snap.product!.id);
      return { ok: true, inserted };
    }
    case "brain_notes": {
      const value = outputs.brain_notes.parse(raw);
      // The deferred seed's `replaceSource`, honoured HERE rather than where it
      // was promised. The background path archives before it extracts; a
      // prepared task has nothing to replace the old notes with until this
      // submission arrives, so a task that is never submitted must leave the
      // previous seed standing. Same tagging: a re-seed the owner's agent
      // extracted is still a LinkedIn seed, and readers keyed on the source
      // (archive, coverage, the next `replaceSource`) have to see it as one.
      const intent = context.intent ?? {};
      if (intent.replaceSource)
        await archiveSourceInTx(tx, intent.replaceSource as KnowledgeSource);
      const source = (intent.knowledgeSource ?? "manual") as KnowledgeSource;
      // Same provenance the background path stamps, carried across the
      // deferral: `linkedin:<account>` / `url:<host>` / `file:<path>` /
      // `text:<attribution>`. A note the owner's own agent extracted is no less
      // owed a source than one the worker extracted.
      const sourcePath = intent.sourcePath;
      const ids: number[] = [];
      for (const note of value.notes)
        ids.push(
          ...(
            await storeKnowledge(tx, {
              ...note,
              source,
              ...(sourcePath ? { sourcePath } : {}),
            })
          ).changedIds,
        );
      // Knowledge that changed moves every non-archived campaign's brief out of
      // date; deferred the same way, so the owner is told rather than charged.
      if (ids.length) await enqueueRecompileForCampaigns(tx);
      return { ok: true, ids };
    }
    case "voice_analysis": {
      const value = outputs.voice_analysis.parse(raw);
      // WHICH voice and WHICH of its two channels — the deferred phase decided
      // both, and the snapshot froze the row. a voice relearn request with voiceId 7,
      // channel: "post"}` used to arrive here as "the default voice's comment
      // channel", rewriting a voice the owner never named.
      const intent = context.intent ?? {};
      const voiceId = snap.voice.id;
      const channel = intent.voiceTarget ?? "comment";
      const [voice] = await tx
        .select()
        .from(voices)
        .where(eq(voices.id, voiceId))
        .for("update");
      // The fence a supplied-text analysis holds: a
      // voice learning from the owner's own comments is direct human evidence,
      // and a supplied-text analysis holds instead of overwriting it.
      if (
        !voice ||
        voice.maturity === "calibrating" ||
        voice.calibrationSampleCount > 0
      )
        return { ok: false, reason: "voice_calibration_hold" };
      // `persist: false` asked for a draft to read, not a save. The analysis IS
      // that draft and it is already on the receipt — writing it anyway is the
      // one thing the flag exists to prevent.
      if (intent.persist === false)
        return { ok: true, voiceId, channel, persisted: false };
      const written = {
        persona: value.persona,
        houseStyle: value.houseStyle,
        learnedFrom: 1,
        sources: [channel === "post" ? "own_posts" : "supplied_writing"],
      };
      // The default voice goes through the canonical dual-writer: the profile
      // half and the voice row cannot report different personas afterwards, and
      // `revision` increments in SQL rather than from a stale read. A NAMED
      // voice is its own row only — the profile is the legacy store for the
      // default voice and must not be touched.
      if (voiceId === (await ensureDefaultVoice(tx)).id)
        await setChannelVoice(tx, channel, written);
      else await setVoiceChannel(tx, voiceId, channel, written);
      await snapshotVoiceRevision(tx, {
        voiceId,
        source: "client_calibration",
      });
      return { ok: true, voiceId, channel, persisted: true };
    }
    case "campaign_brief": {
      const value = outputs.campaign_brief.parse(raw);
      const clean = sanitizeBrief(value.brief);
      if (!clean.ok) return { ok: false, reason: "invalid_brief" };
      const compiler = snap.compiler!;
      return {
        ok: await writeCompiledBrief(
          tx,
          snap.campaign!.id,
          compiler.knowledgeVersion,
          {
            brief: clean.text,
            preferredSlots: compiler.preferredSlots,
            anchorKnowledgeIds: compiler.anchorKnowledgeIds,
            sourceHash: compiler.sourceHash,
            compiledAt: Date.now(),
            basedOnFillScore: compiler.fillScore,
            coldStart: false,
          },
        ),
      };
    }
    case "draft": {
      if (!context.draftReview)
        return { ok: true, taskd: true, awaitingEvidenceReview: true };
      const frozen = context.draftReview[String(itemId)];
      if (!frozen) throw new Error("unfrozen_draft");
      // A draft the owner asked for is delivered with the slips of style it
      // has, named in `note`; a worker's has none to tolerate, and a claim the
      // sources do not establish blocks either.
      const reviewed = validateEvidenceVerdict(
        { ...ReviewOutput.parse(raw), discoveredPostId: itemId },
        frozen.evidence,
        { tolerateSlips: !(snap.worker && context.runId) },
      );
      if (!reviewed.supported)
        return { ok: false, reason: reviewed.reason ?? "unsupported_claim" };
      const note = reviewed.note ? { note: reviewed.note } : {};
      const value = frozen.draft;
      // A supplied source must be present in frozen content. A URL and a model's
      // assurance alone do not satisfy factual grounding.
      //
      // `sources[]` is WEB FACTS and nothing else — the same thing the client
      // intake means by the field (`submit_comment_drafts` stores it as
      // fact-check provenance under `trace.facts`), proved rather than
      // declared: intake takes the client's word for it, and a prepared task
      // holds the material, so it can require the citation to be IN it. Either
      // way the post being commented on is not one of them. It is the subject,
      // carried in this evidence as `post` and never as a source, and a draft
      // citing its own post's url was refused with a reason that reads "add
      // evidence" for material it already had (measured 2026-09-15). Naming
      // the url the evidence does not hold is what tells those two apart.
      //
      // KNOWN LIMIT, stated rather than papered over: `DraftEvidence` carries
      // the post, Brain knowledge, constraints and product facts, so the only
      // urls that can pass are ones already written into that material — a page
      // the agent fetched itself is not checkable here, which makes the rule
      // narrower than "web facts" sounds on a `webFacts` campaign. The fix is to
      // put that campaign's own web facts into `DraftEvidence` (see
      // `workers/evidenceReview.ts`), which is the drafting context's work and
      // not this refusal's.
      const evidence = JSON.stringify(frozen.evidence);
      const unsupported = value.sources.find(
        (source) =>
          !evidence.includes(source.url) || !evidence.includes(source.quote),
      );
      if (unsupported)
        return {
          ok: false,
          reason: "source_not_in_evidence",
          detail: evidence.includes(unsupported.url)
            ? `quote cited for ${unsupported.url}`
            : unsupported.url,
        };
      if (snap.campaign?.webFacts && value.sources.length === 0)
        return { ok: false, reason: "grounding_evidence_required" };
      const resolved = await resolveCampaignVoice(
        tx,
        snap.campaign!,
        await getProfile(tx),
        "comment",
      );
      const violations = intakeGateViolations(value.text, resolved.styleRules);
      if (violations.length)
        return { ok: false, reason: "draft_quality_hold", violations };
      if (snap.worker && context.runId) {
        const [run] = await tx
          .select()
          .from(workerRuns)
          .where(eq(workerRuns.id, context.runId))
          .for("update");
        if (
          !context.workerDemand ||
          !run ||
          run.draftedCount >= context.workerDemand.limit
        )
          return { ok: false, reason: "worker_demand_filled" };
        const channel = await channelCeilings(tx);
        const publish = (await modeFor(tx, { campaignId: snap.campaign!.id, capability: "publish_comment", target: "post" })).effective === "auto";
        const demand = channel
          ? await computeCommentDemand(
              tx,
              {
                channel,
                campaignId: snap.campaign!.id,
                publish,
              },
              Date.now(),
            )
          : { drafts: 0 };
        if (demand.drafts <= 0 && !context.workerDemand.floorOnly)
          return { ok: false, reason: "worker_demand_filled" };
        const result = await submitCommentDraftBatch(
          tx,
          snap.campaign!,
          {
            drafts: [
              {
                discoveredPostId: itemId,
                text: value.text,
                rationale: value.rationale,
                sources: value.sources,
              },
            ],
            model: "external:prepared-v1",
          },
          {
            forceProposal: false,
            worker: {
              workerAuthored: true,
              publish: context.workerDemand.publish && publish,
              runId: context.runId,
            },
          },
        );
        if (!result.ok) return { ok: false, receipt: result };
        const applied = result.data.items.find(
          (item) => item.discoveredPostId === itemId,
        );
        const inserted =
          applied &&
          "messageId" in applied &&
          applied.messageId != null &&
          !("alreadyExisted" in applied && applied.alreadyExisted)
            ? applied
            : null;
        return {
          ok: inserted !== null,
          scheduled: inserted !== null && "status" in inserted && inserted.status === "approved",
          ...(inserted ? { messageId: inserted.messageId } : {}),
          receipt: result,
        };
      }
      if (context.asked) {
        // Words asked for a waiting comment join ITS drafts, and only while
        // it is the same draft waiting for the same yes; never the post's
        // slot, which is Posts to join's.
        const added = await addAskedDraft(tx, {
          messageId: context.asked.messageId,
          expectedStatus: "proposed",
          expectedRequestVersion: context.asked.requestVersion,
          move: context.asked.move,
          angle: context.asked.angle,
          text: value.text,
        });
        if (!added.ok) return { ok: false, reason: ASKED_DRAFT_INACTIVE };
        return {
          ok: true,
          awaitingOwner: true,
          draft: value.text,
          asked: { messageId: context.asked.messageId, draft: added.draft },
          ...note,
        };
      }
      await putComposerAngle(tx, {
        box: boxKey({ kind: "comment", discoveredPostId: itemId }),
        text: value.text, why: value.rationale, campaignId: snap.campaign!.id,
      });
      return {
        ok: true,
        awaitingOwner: true,
        draft: value.text,
        assist: {
          ok: true,
          campaignId: snap.campaign!.id,
          discoveredPostId: itemId,
          draft: { text: value.text, angle: value.rationale },
        },
        ...note,
      };
    }
  }
}
