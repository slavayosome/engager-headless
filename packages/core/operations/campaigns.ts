import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import { audienceProfile, editableAudience, type AudienceProfileInput } from "../audience/model";
import { audiencePatch, audienceRevisionPatch, initializeAudience, type AudienceWriteMeta } from "../audience/write";
import {
  campaignProducts,
  campaigns,
  channels,
  discoveredPosts,
  organizations,
  messages,
  workers,
  SEARCH_DEPTHS,
  type ActiveHours,
  type AiFilterConfig,
  type AiPromptsConfig,
  type Campaign,
  type Channel,
  type DiscoveryConfig,
  type NewCampaign,
  type SearchDepth,
  type ToneConfig,
} from "@engager/database/schema";
import { afterCommit, type Tx } from "@engager/database/tenant";
import { track } from "@engager/observability/analytics";
import {
  CAMPAIGN_CREATE_DEFAULTS,
  PUBLIC_CAMPAIGN_NUMERIC_LIMITS,
} from "../campaigns/defaults";
import { isPublicObjectiveAvailable } from "../campaigns/objectives";
import { MAX_SEARCH_ORS, orOperators, quotesClose, REFUSED_BECAUSE } from "../linkedin/searchRefusal";
import {
  storableCommentGuidance,
  storableReplyGuidance,
  storableReplyPolicy,
} from "../ai/promptDefaults";
import { config } from "../config";
import {
  resolveJudgmentPolicy,
  type JudgmentPolicy,
} from "../tasks/policy";
import { enqueue } from "../jobs/queue";
import type { WorkerRunPayload } from "../jobs/handlers/workerRun";
import { DEFAULT_NETWORK } from "../network/registry";
import { projectWake } from "../strategy/project";
import { strategyInForce } from "../strategy/read";
import { seedBlankStrategy } from "../strategy/seed";
import { assertNotStrategyOwned } from "../strategy/writers";
import { computeLearningSignals } from "./learningSignals";
import { scheduleHeldSends } from "./schedule";
import { assertConnectorCanRunType, scoutIdFor, workerNameFor } from "./workers";

/**
 * Structured (JSON) campaign input — the Next-free twin of the dashboard's
 * FormData. Shared by New campaign's server action and the MCP campaign
 * tools so default-application lives in exactly one place.
 */
export type CampaignInput = {
  name?: string;
  status?: Campaign["status"];
  objective?: Campaign["objective"];
  /** DEPRECATED and inert. The mode ladder is retired: a campaign says what to
   *  hunt for, and what runs unattended is a worker. The value is still
   *  accepted so a shipped client does not fail validation, and it still
   *  writes nothing. */
  mode?: "auto" | "manual" | "curate" | "review";
  /** DEPRECATED and inert, for the same reason as `mode`. Declared as its own
   *  literal union rather than off a campaign column, so the type survived the
   *  column being dropped. */
  automation?: "discover" | "draft" | "autopilot";
  likeWhenCommenting?: boolean;
  premiumWriter?: boolean;
  webFacts?: boolean;
  webFactsRatio?: number;
  /** Verified triage: a match reaches the deck only once confirmed. */
  verifyStage?: boolean;
  maxPostAgeDays?: number;
  diversityRejectThreshold?: number;
  diversityStructuralThreshold?: number;
  discovery?: DiscoveryConfig;
  aiFilter?: Partial<AiFilterConfig>;
  audienceProfile?: AudienceProfileInput;
  baseRevision?: number;
  tone?: ToneConfig;
  prompts?: AiPromptsConfig;
  /** The Voice this campaign writes in. Null = detach (org default voice);
   *  omit = leave untouched (update) / org default (create). */
  voiceId?: number | null;
};

/** What a create takes: everything a campaign says except whether it runs and
 *  whether it is on its strategy — every campaign is created on its
 *  strategy, Paused and Not started (`createCampaignOp`) — and its search
 *  depth. A Deep create's Research is said on its draft by the caller
 *  (`setSearchDepth`, strategy/submit.ts); after the create, the depth only
 *  ever changes through `setSearchDepth`, never `updateCampaignOp`. */
export type CreateCampaignInput = Omit<CampaignInput, "status"> & {
  searchDepth?: SearchDepth;
};

/** Stable, actionable public-policy failures shared by dashboard and MCP. */
export class UnsupportedPublicCampaignFlowError extends AppError {
  readonly recovery: string;

  constructor(message: string, recovery: string) {
    super("unsupported_public_campaign_flow", message, 400);
    this.recovery = recovery;
  }
}

export class InvalidCampaignScheduleError extends AppError {
  readonly recovery =
    "Choose at least one active day before saving the campaign.";

  constructor() {
    super(
      "invalid_active_days",
      "activeDays cannot be empty; an empty schedule must never widen into seven-day posting.",
      400,
    );
  }
}

export class InvalidCampaignInputError extends AppError {
  readonly field: string;
  readonly recovery: string;

  constructor(field: string, allowed: readonly string[]) {
    super(
      "invalid_campaign_input",
      `Invalid ${field}; expected one of: ${allowed.join(", ")}.`,
      400,
    );
    this.field = field;
    this.recovery = `Retry with a supported ${field} value: ${allowed.join(", ")}.`;
  }
}

/** A search depth sent to `save_campaign` beside Research. Deep IS Research,
 *  so beside `verifyStage` the call would say one switch twice. */
export class SearchDepthNotAloneError extends AppError {
  readonly recovery =
    "Nothing was written. Send search_depth in a call of its own — deep turns Research on, quick and standard turn it off, so verifyStage is never needed beside it.";

  constructor() {
    super(
      "search_depth_not_alone",
      "search_depth changes Research, so it is not sent with verifyStage.",
      400,
    );
  }
}

/** Refuse a search depth the product does not know, before anything is
 *  written: a create's, and `setSearchDepth`'s (strategy/submit.ts), whose
 *  callers may be untyped. */
export function assertSearchDepth(depth: unknown): void {
  if (depth !== undefined && !(SEARCH_DEPTHS as readonly unknown[]).includes(depth)) {
    throw new InvalidCampaignInputError("searchDepth", SEARCH_DEPTHS);
  }
}

export class UnsupportedPublicCampaignObjectiveError extends AppError {
  readonly recovery =
    "Choose one of the available commenting goals (engage, visibility, audience, nurture, thought, product). An existing legacy objective may remain unchanged while other fields are edited.";

  constructor() {
    super(
      "unsupported_public_campaign_objective",
      "This goal is not available on the public surface.",
      400,
    );
  }
}

export class CampaignProductRequiredError extends AppError {
  readonly recovery: string;

  constructor(
    message = "Public Product campaigns require at least one attached product at creation.",
    recovery = "Create or select a product, then retry public campaign creation with at least one productId. Existing product-less legacy campaigns may still be edited to recover.",
  ) {
    super("campaign_product_required", message, 409);
    this.recovery = recovery;
  }
}

/** Surface-level product selection guard. Product links are reconciled outside
 *  CampaignInput, so dashboard and MCP call this before the campaign insert. */
/** Only the product objective requires an attached product — the other goals
 *  engage without one (visibility/thought never mention products at all). */
export function assertPublicCampaignProductSelection(
  productIds: readonly number[],
  objective: Campaign["objective"] | null | undefined,
): void {
  const effective = objective ?? CAMPAIGN_CREATE_DEFAULTS.objective;
  if (effective === "product" && productIds.length === 0) {
    throw new CampaignProductRequiredError();
  }
}

export class InvalidCampaignNumericError extends AppError {
  readonly field: string;
  readonly recovery: string;

  constructor(field: string, rule: string) {
    super(
      "invalid_campaign_numeric",
      `Invalid ${field}; expected ${rule}.`,
      400,
    );
    this.field = field;
    this.recovery = `Choose ${field} that is ${rule}.`;
  }
}

/** A search in the campaign's discovery that LinkedIn would not answer
 *  (`discovery/refused.ts`) — more ORs than it allows, or a quote left open,
 *  which hides the rest from the count — refused where it is written rather
 *  than parked at its first sweep. */
export class CampaignSearchRefusedError extends AppError {
  readonly field: string;
  readonly recovery: string;

  constructor(field: string, code: "too_many_ors" | "unbalanced_query") {
    super(
      code,
      `${field}: ${code === "too_many_ors" ? REFUSED_BECAUSE.too_many_ors : "the quotes do not close."}`,
      400,
    );
    this.field = field;
    this.recovery =
      code === "too_many_ors"
        ? `Split ${field} into shorter searches, each with at most ${MAX_SEARCH_ORS} ORs.`
        : `Close or remove the open quote in ${field}.`;
  }
}

/** Who moved a campaign's status (`campaigns.status_changed_by`). */
export type CampaignStatusActor = NonNullable<Campaign["statusChangedBy"]>;

/** The stamp a status change writes beside the status, and only a change:
 *  a call that leaves the status as it was writes neither. */
function statusStamp(
  before: Campaign["status"],
  after: Campaign["status"] | undefined,
  now: number,
  actor: CampaignStatusActor = "system",
): Pick<NewCampaign, "statusChangedAt" | "statusChangedBy"> {
  return after === undefined || after === before
    ? {}
    : { statusChangedAt: now, statusChangedBy: actor };
}

export type CampaignOperationOptions = {
  audienceWrite?: AudienceWriteMeta;
  /** Public is fail-closed by default. Internal callers must opt in explicitly
   *  to create or reconfigure a hosted-writer campaign. */
  surface?: "public" | "internal";
  /** Deterministic policy clock for tests and server-controlled calls. */
  now?: number;
  /** CREATE ONLY: the account the campaign lives on, chosen by the owner when
   *  the org has more than one (INV-34). Omitted, it is the org's one
   *  channel. No update path reads it — a campaign is never moved. */
  channelId?: number;
  /** CREATE ONLY: where the campaign came from, for usage data (the funnel's
   *  `campaign_created`). Every production creator states it; a test helper
   *  that does not creates nothing the funnel hears of. */
  source?: "onboarding" | "form" | "chat" | "duplicate";
  /** Who made the change (dashboard callers pass ctx.userId) — recorded as
   *  the revoker when it revokes a scheduled credential. */
  actorUserId?: string;
  /** Who changed the campaign's status, stamped beside it when it moves: the
   *  owner in Engager, their agent over MCP, or Engager itself — a Start, a
   *  delete. Omitted, Engager itself. A create reads it as who set the
   *  campaign's search depth: their agent, or else the owner's own press. */
  actor?: CampaignStatusActor;
  /** Resulting product links supplied by a public orchestration that updates
   *  the objective and product selection atomically. Omit when links are not
   *  part of the request; the operation then reads the persisted links. */
  productIds?: readonly number[];
  /** Who does the thinking behind this campaign's first discovery. Omit and the
   *  operation resolves it (`resolveJudgmentPolicy`); a caller that already
   *  resolved it passes its own answer so ONE resolution governs both the row
   *  this operation writes and the receipt the caller builds from it. */
  judgmentPolicy?: JudgmentPolicy;
  /** How the exactly-once first discovery went, for the caller's receipt:
   *  `queued` wrote the Scout's `worker:<scout>:first` run, `owed` wrote none
   *  because the judgment belongs to the caller's own agent. Not called at all
   *  when the campaign is not a supported runtime or has no Scout — there is no
   *  first sweep to report. */
  onFirstDiscovery?: (outcome: "queued" | "owed") => void;
  /** Shallow-merge `input.discovery` over the row this operation itself locks,
   *  instead of replacing the stored object with it. The broker's bounded
   *  campaign repair is the only caller: it sends a PARTIAL discovery patch, and
   *  merging at the operation's own `for update` read is what keeps a
   *  concurrent writer's unrelated source field from being overwritten by a
   *  copy read before the lock. Every other surface keeps the full-replacement
   *  semantics it has always had. */
  mergeDiscovery?: boolean;
};

function assertPublicInputWellFormed(input: CampaignInput): void {
  const check = (field: string, value: unknown, allowed: readonly string[]) => {
    if (value !== undefined && !allowed.includes(String(value))) {
      throw new InvalidCampaignInputError(field, allowed);
    }
  };
  check("status", input.status, ["active", "paused", "archived"]);
  check("objective", input.objective, [
    "engage",
    "visibility",
    "audience",
    "nurture",
    "thought",
    "product",
  ]);
  check("mode", input.mode, ["auto", "manual", "curate", "review"]);
  check("automation", input.automation, ["discover", "draft", "autopilot"]);

  const number = (
    field: string,
    value: unknown,
    opts: { min?: number; max?: number; integer?: boolean },
  ) => {
    if (value === undefined) return;
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (opts.integer && !Number.isSafeInteger(value)) ||
      (opts.min !== undefined && value < opts.min) ||
      (opts.max !== undefined && value > opts.max)
    ) {
      const rule = `${opts.integer ? "an integer " : "a finite number "}${
        opts.min !== undefined ? `>= ${opts.min}` : ""
      }${opts.min !== undefined && opts.max !== undefined ? " and " : ""}${
        opts.max !== undefined ? `<= ${opts.max}` : ""
      }`.trim();
      throw new InvalidCampaignNumericError(field, rule);
    }
  };
  number("maxPostAgeDays", input.maxPostAgeDays, {
    ...PUBLIC_CAMPAIGN_NUMERIC_LIMITS.maxPostAgeDays,
    integer: true,
  });
  if (input.voiceId !== null) {
    number("voiceId", input.voiceId, {
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      integer: true,
    });
  }
  number("webFactsRatio", input.webFactsRatio, { min: 0, max: 1 });
  number("diversityRejectThreshold", input.diversityRejectThreshold, {
    min: 0,
    max: 1,
  });
  number("diversityStructuralThreshold", input.diversityStructuralThreshold, {
    min: 0,
    max: 1,
  });
  number("discovery.limit", input.discovery?.limit, {
    ...PUBLIC_CAMPAIGN_NUMERIC_LIMITS.discoveryLimit,
    integer: true,
  });
  number(
    "discovery.min_author_followers",
    input.discovery?.min_author_followers,
    {
      ...PUBLIC_CAMPAIGN_NUMERIC_LIMITS.minAuthorFollowers,
      integer: true,
    },
  );
  number("aiFilter.min_confidence", input.aiFilter?.min_confidence, {
    min: 0,
    max: 3,
    integer: true,
  });
  number("aiFilter.min_meaningfulness", input.aiFilter?.min_meaningfulness, {
    min: 0,
    max: 1,
  });
  number("tone.promo_ratio", input.tone?.promo_ratio, { min: 0, max: 1 });
  const searches: [string, string | undefined][] = [
    ["discovery.boolean_query", input.discovery?.boolean_query],
    ["discovery.search_query", input.discovery?.search_query],
    ...(input.discovery?.keywords ?? []).map(
      (keyword, index): [string, string] => [`discovery.keywords[${index}]`, keyword],
    ),
    ...(input.discovery?.hashtags ?? []).map(
      (hashtag, index): [string, string] => [`discovery.hashtags[${index}]`, hashtag],
    ),
  ];
  for (const [field, term] of searches) {
    if (term === undefined) continue;
    if (!quotesClose(term)) throw new CampaignSearchRefusedError(field, "unbalanced_query");
    if (orOperators(term) > MAX_SEARCH_ORS) {
      throw new CampaignSearchRefusedError(field, "too_many_ors");
    }
  }
  if (typeof input.tone?.slop_strictness === "number") {
    number("tone.slop_strictness", input.tone.slop_strictness, {
      min: 0,
      max: 1,
    });
  }
}

/* The `mode` and `automation` wire fields stay accepted and inert: a client
 * still sending one must not fail validation, even though nothing this repo
 * ships sends either. What posts without a per-draft approval is a Comment or
 * Reply the strategy sets to Automatic (`modeFor`), never a campaign column. */

function assertPublicCreateFlow(input: CampaignInput): void {
  if (
    input.objective !== undefined &&
    !isPublicObjectiveAvailable(input.objective)
  ) {
    throw new UnsupportedPublicCampaignObjectiveError();
  }
  // Creating a campaign that publishes unattended used to be refused outright.
  // It is not gated any more — but a campaign does not publish on its own
  // regardless: only a worker does, and creating one is a separate act.
  // An Automatic reply lane is not fenced either (INV-6): what it sends carries
  // worker authorship, so `pacingPolicy` caps it.
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

/** When a positive-length, activated warm-up completes. An account never
 *  armed, or with warm-up Off (zero weeks), has no ramp to complete: null. */
export function completedWarmupAt(
  channel: Pick<Channel, "warmupStartedAt" | "warmupWeeks">,
): number | null {
  if (
    channel.warmupStartedAt == null ||
    !Number.isSafeInteger(channel.warmupStartedAt) ||
    channel.warmupStartedAt <= 0 ||
    !Number.isSafeInteger(channel.warmupWeeks) ||
    channel.warmupWeeks <= 0
  ) {
    return null;
  }
  const completedAt = channel.warmupStartedAt + channel.warmupWeeks * WEEK_MS;
  return Number.isSafeInteger(completedAt) &&
    Number.isFinite(new Date(completedAt).getTime())
    ? completedAt
    : null;
}

async function assertPublicUpdateFlow(
  tx: Tx,
  existing: Campaign,
  input: CampaignInput,
  now: number,
): Promise<void> {
  if (
    input.objective !== undefined &&
    !isPublicObjectiveAvailable(input.objective) &&
    input.objective !== existing.objective
  ) {
    throw new UnsupportedPublicCampaignObjectiveError();
  }
  // No Auto-post promotion gate any more. There is no calibration-cycle
  // requirement, no warm-up precondition, and no one-shot typed confirmation:
  // the owner decides what to automate, and the act of arming a worker is
  // the explicit act. Warm-up survives as a ramp on the daily cap rather than a
  // fence, and every unattended send is capped by `pacingPolicy` because it
  // carries `publishOrigin: "worker"`.
}

/**
 * Canonical launch-runtime predicate used by every work-producing entry point.
 * A campaign is supported when it is the thing a worker hunts for — active.
 * STATUS, and nothing else: drafting is a step on an Ambassador, and what
 * a send may do is its mode (`modeFor`).
 */
export function isSupportedPublicCampaignRuntime(
  campaign: Pick<Campaign, "status">,
): boolean {
  return campaign.status === "active";
}

/**
 * Serialize public create/activate per org, including the empty-table case
 * where a row lock cannot protect two concurrent first creates.
 *
 * It outlived the one-primary check it was named for (T-8.11). What it still
 * guards is every check-then-insert on this path — `workerNameFor` reads a name
 * as free and inserts against `workers_org_name_key` — and those are unsafe to
 * interleave whatever the campaign roster looks like.
 */
async function lockPublicCampaignPolicy(tx: Tx): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(coalesce(current_setting('app.current_org', true), '')))`,
  );
}

/*
 * THE ONE-ACTIVE-CAMPAIGN POLICY IS LIFTED, and `assertNoOtherActiveCampaign`
 * went with it. Every reason to refuse a second campaign died in Phases 4–7: the
 * exposure budget, the day plan, the one-running lease and demand are all
 * channel-scoped, so N campaigns already draw one plan and spend one budget.
 * T-4.7 deleted the compensating send-gate refusal after a soak release; this
 * removes the refusal that made it necessary.
 *
 * What spaces one campaign's sends against another's is `channel_min_gap`, and
 * after the lift that is the WHOLE of it — correct, because the day plan's
 * anchors are seeded per channel rather than per campaign (`schedule.ts`), so two
 * campaigns consume one sequence of anchors rather than two overlapping ones.
 *
 * The advisory lock stays. It serializes activation for other reasons — the
 * empty-table case a row lock cannot protect — and nothing about lifting a
 * count makes concurrent activation safe to interleave.
 */

/** Apply the canonical defaults to a structured input → a full insert payload.
 *  The public product has one drafting owner: the user's agent. Internal callers
 *  may still explicitly choose the hidden hosted-writer fallback. */
export function campaignValuesFromInput(
  input: CampaignInput & Pick<CreateCampaignInput, "searchDepth">,
): Partial<NewCampaign> {
  const discovery: DiscoveryConfig = {
    keywords: input.discovery?.keywords ?? [],
    hashtags: input.discovery?.hashtags ?? [],
    boolean_query: input.discovery?.boolean_query,
    search_query: input.discovery?.search_query,
    target_author_urns: input.discovery?.target_author_urns ?? [],
    limit: input.discovery?.limit ?? CAMPAIGN_CREATE_DEFAULTS.discoveryLimit,
    // Launch default "any": fastest first candidate value with no extra author-
    // profile lookup budget. Reach-aware enrichment remains an explicit opt-in.
    author_targeting:
      input.discovery?.author_targeting ??
      CAMPAIGN_CREATE_DEFAULTS.discoveryAuthorTargeting,
    min_author_followers: input.discovery?.min_author_followers,
  };
  const aiFilter: AiFilterConfig = {
    instruction: input.aiFilter?.instruction ?? "",
    target_language: input.aiFilter?.target_language,
    min_confidence:
      input.aiFilter?.min_confidence ??
      CAMPAIGN_CREATE_DEFAULTS.filterMinConfidence,
    min_meaningfulness: input.aiFilter?.min_meaningfulness,
  };
  const tone: ToneConfig = {
    angle: input.tone?.angle,
    product_name: input.tone?.product_name,
    product_description: input.tone?.product_description,
    usp: input.tone?.usp,
    // voice: intentionally NOT defaulted — the learned profile voice is the single
    // style authority; a per-campaign tone word only survives if explicitly set
    // (legacy rows; the C1 migration strips it).
    voice: input.tone?.voice,
    // "auto" (per-post adaptive tier) is the default for NEW campaigns; an explicit
    // tier pins every draft. Existing rows keep whatever they stored.
    length: input.tone?.length ?? "auto",
    // Unset = auto at draft time (per-post jittered strictness); a number pins it.
    slop_strictness: input.tone?.slop_strictness,
    // promo_ratio: unset = "objective default" (see effectivePromoRatio). Defaulting
    // to 0 here made 0 ambiguous — it silently meant 30% for product campaigns.
    promo_ratio: input.tone?.promo_ratio,
    promo_include_link:
      input.tone?.promo_include_link ??
      CAMPAIGN_CREATE_DEFAULTS.promoIncludeLink,
    do: input.tone?.do ?? [],
    avoid: input.tone?.avoid ?? [],
  };
  // Default-equal guidance never persists: a frozen byte-copy of the default
  // would pin the campaign to an old prompt generation (see promptDefaults.ts).
  const prompts: AiPromptsConfig = {
    comment_guidance: storableCommentGuidance(input.prompts?.comment_guidance),
    reply_guidance: storableReplyGuidance(input.prompts?.reply_guidance),
    reply_policy: storableReplyPolicy(input.prompts?.reply_policy),
  };

  return {
    name: input.name ?? "Untitled",
    status: input.status ?? "active",
    // New campaigns default to useful conversations; existing saved goals stay intact.
    objective: input.objective ?? CAMPAIGN_CREATE_DEFAULTS.objective,
    likeWhenCommenting:
      input.likeWhenCommenting ?? CAMPAIGN_CREATE_DEFAULTS.likeWhenCommenting,
    premiumWriter:
      input.premiumWriter ?? CAMPAIGN_CREATE_DEFAULTS.premiumWriter,
    // Fact-checked drafting (web search) — drafts that actually searched cost 3
    // credits instead of 1. Launch default is OFF so hosted web egress and its
    // surcharge are always an explicit campaign choice.
    webFacts: input.webFacts ?? CAMPAIGN_CREATE_DEFAULTS.webFacts,
    // ~1 in 3 drafts gets the search path by default: always-on citation is its
    // own AI tell, and avg cost stays ≈ 1.6 credits/draft. Pre-ratio campaigns
    // keep the DB default (1 = always).
    webFactsRatio:
      input.webFactsRatio ?? CAMPAIGN_CREATE_DEFAULTS.webFactsRatio,
    maxPostAgeDays:
      input.maxPostAgeDays ?? CAMPAIGN_CREATE_DEFAULTS.maxPostAgeDays,
    // Standard is how Scout has always worked, and a create that names no
    // depth keeps it. Deep is the draft's Research, never a stored value.
    searchDepth: input.searchDepth === "quick" ? "quick" : "standard",
    diversityRejectThreshold:
      input.diversityRejectThreshold ??
      CAMPAIGN_CREATE_DEFAULTS.diversityRejectThreshold,
    diversityStructuralThreshold:
      input.diversityStructuralThreshold ??
      CAMPAIGN_CREATE_DEFAULTS.diversityStructuralThreshold,
    discovery,
    aiFilter,
    tone,
    prompts,
    // Null/omitted = the org's default voice (resolveCampaignVoice ladder).
    voiceId: input.voiceId ?? null,
  };
}

/**
 * The DB ops run inside the caller's org-scoped `withOrg` transaction (RLS + the
 * GUC default supply organization_id), so no query carries an organizationId.
 */
export async function listCampaigns(tx: Tx): Promise<Campaign[]> {
  return tx
    .select()
    .from(campaigns)
    .where(isNull(campaigns.deletedAt))
    .orderBy(desc(campaigns.updatedAt));
}

export type CampaignWithMeta = Campaign & { productCount: number };

/** Campaigns plus their attached-product count (for the campaign list). */
export async function listCampaignsWithMeta(
  tx: Tx,
): Promise<CampaignWithMeta[]> {
  const rows = await listCampaigns(tx);
  const counts = await tx
    .select({
      campaignId: campaignProducts.campaignId,
      n: sql<number>`count(*)::int`,
    })
    .from(campaignProducts)
    .groupBy(campaignProducts.campaignId);
  const byId = new Map(counts.map((r) => [r.campaignId, r.n]));
  return rows.map((c) => ({ ...c, productCount: byId.get(c.id) ?? 0 }));
}

/** One campaign by id — none for a deleted one, which no surface shows
 *  again (`operations/deleteCampaign.ts`). */
export async function getCampaign(
  tx: Tx,
  id: number,
): Promise<Campaign | undefined> {
  const [row] = await tx
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, id), isNull(campaigns.deletedAt)));
  return row;
}

/** Create a campaign from a structured input (defaults applied). Returns its id. */
/*
 * The two campaign->channel dual-writes are DELETED here, not at the contract
 * release. `mirrorPacingToChannel` projected the campaign row's nine pacing
 * values onto the account on create, update and activation;
 * `writeChannelWarmupShape` did the same for the warm-up shape.
 *
 * They were the expand half of the move, and the move is over: `update_channel`
 * is now the write surface for all eleven. Leaving either one alive would make
 * the next campaign edit or activation silently revert the account's caps to a
 * campaign row's frozen values — the caps a model just set through the account
 * surface, overwritten by a create that names none of them. `createCampaignOp`'s
 * `channelId` stamp is NOT part of the mirror and stays.
 */
export async function createCampaignOp(
  tx: Tx,
  input: CreateCampaignInput,
  now = Date.now(),
  options: CampaignOperationOptions = {},
): Promise<number> {
  const isPublic = options.surface !== "internal";
  assertSearchDepth(input.searchDepth);
  if (isPublic) {
    assertPublicInputWellFormed(input);
    assertPublicCreateFlow(input);
    await lockPublicCampaignPolicy(tx);
  }
  const values = campaignValuesFromInput(input);
  // Creating a campaign arms NOTHING, so it starts no warm-up ramp. INV-1
  // makes warm-up a ramp on the cap, and the volume it ramps is unattended
  // publishing — which is armed by a Comment that is Automatic, not here. The
  // stamp therefore lives with that arming (`stampChannelWarmupStart`,
  // operations/workers.ts).
  //
  // A GUARANTEE, not an accident: the ramp anchor is the CHANNEL's, so no
  // campaign lifecycle event may move it. Creating a campaign on a warmed
  // account inherits the account's elapsed ramp rather than starting a fresh
  // one, and there is no column on the row being inserted for a fresh clock to
  // live in.
  //
  // Stamp the account this campaign feeds (INV-4), inside the caller's
  // transaction so the campaign and its attribution land together. The stamp
  // sits AFTER the spread so no `CampaignInput` field can shadow it — the
  // resolve is the server's, never the caller's.
  //
  // The binding is for LIFE (INV-34): this insert and `backfillCampaignChannels`
  // are the column's only writers, and no update path names it. Moving a campaign
  // is duplicating it onto another channel.
  //
  // EVERY CAMPAIGN IS CREATED ON ITS STRATEGY, whoever creates it — setup,
  // the owner's agent, the dashboard — told where by the owner whenever there
  // is a choice to make, and Paused: its strategy is designed next, and nothing
  // in it wakes until the owner's Start campaign activates that design
  // (`strategy/patch.ts`). Active and Paused alone then decide when it wakes,
  // as on every other campaign; no create can leave a campaign on its workers'
  // own switches.
  //
  // Every campaign is created finding leads.
  const channelId = await newCampaignChannelId(tx, options.channelId);
  const [row] = await tx
    .insert(campaigns)
    .values({
      name: values.name ?? "Untitled",
      ...values,
      channelId,
      status: "paused",
    })
    .returning();
  // EVERY CAMPAIGN HAS A SCOUT, and this is the one seam every path crosses.
  // `bootstrapLocalOrg` creates org, channel, user and membership and nothing
  // else; the campaign comes from setup, the owner's agent or the dashboard,
  // and every one of them lands here. Provisioning anywhere else would give a
  // fresh install a Scout page bound to nothing.
  //
  // ARMS NOTHING. `auto: false` means the server never wakes it, and a scout
  // has no publish step to arm. Its find is a projection of the strategy,
  // and no version that gives it a step is in force yet: it finds nothing
  // until the Start.
  //
  // NO AMBASSADOR. A worker that drafts is a decision the owner takes by giving
  // the Ambassador a step. Scout merely looks.
  if (row) {
    await initializeAudience(tx, row, input.audienceProfile, now, "created", options.source === "duplicate");
    // THE SAME CHECK THE HIRE TAKES. This is the only Scout-minting path a real
    // install uses, so skipping it would have the product mint, on the seam
    // every path crosses, exactly the row it refuses the owner.
    await assertConnectorCanRunType(tx, channelId, "scout");
    await tx.insert(workers).values({
      organizationId: row.organizationId,
      campaignId: row.id,
      // The account this campaign spends against, resolved exactly as the
      // campaign's own stamp above resolved it — one read, one answer.
      channelId,
      name: await workerNameFor(tx, "Scout", row.name),
      type: "scout",
      auto: false,
      sweepEnabled: false,
      draftEnabled: false,
      // The campaign's own clock, not the op's: a scout and the campaign it points
      // at were created by one statement pair and should say so.
      createdAt: row.createdAt,
      updatedAt: row.createdAt,
    });
    // Its v1: a blank draft the owner's design replaces. A Deep create's
    // Research is said on it by the caller (`setSearchDepth`): the
    // strategy's patch path sits above this operation, as it does for
    // `duplicateCampaignOp`.
    await seedBlankStrategy(tx, row.id, now);
  }
  // No first discovery here: a Paused campaign finds nothing. Its first
  // activation — the Start — carries the exactly-once kick
  // (`setCampaignStatusOp`).
  const { source } = options;
  if (source) {
    // The depth it was created at, Deep included, which its caller says on
    // the draft next.
    const depth = input.searchDepth ?? "standard";
    const by = options.actor === "agent" ? "agent" : "owner";
    afterCommit(tx, () => {
      track("campaign_created", { source, depth });
      track("campaign_depth_set", { depth, source: "create", by });
    });
  }
  return row!.id;
}

/**
 * The channel a campaign created before its org had one is bound to: the org's
 * oldest channel on the default network, or null when the org has none.
 *
 * Filtered and ordered even though the invariant says there is exactly one
 * row: `bootstrap-local-org.ts` guards its mint on (org, network) existence,
 * so a duplicate is not reachable today — but a second entry in
 * `network/registry.ts` will legitimately put a SECOND row here, and a bare
 * unordered `limit(1)` would turn this stamp silently nondeterministic on the
 * day that lands rather than obviously wrong. Oldest row wins until a
 * network-aware resolve replaces it.
 *
 * Read by the backfill below; a new campaign is bound by
 * `newCampaignChannelId`, which asks the owner when there is a choice.
 */
async function defaultCampaignChannelId(tx: Tx): Promise<number | null> {
  const [channel] = await tx
    .select({ id: channels.id })
    .from(channels)
    .where(eq(channels.network, DEFAULT_NETWORK))
    .orderBy(asc(channels.id))
    .limit(1);
  return channel?.id ?? null;
}

/** One account a new campaign could live on, as the owner is asked about it. */
export type ChannelChoice = Pick<Channel, "id" | "network" | "displayName">;

/** Every account this organization has connected, oldest first — the answers
 *  to "where" when there is more than one. */
export async function campaignChannelChoices(tx: Tx): Promise<ChannelChoice[]> {
  return tx
    .select({ id: channels.id, network: channels.network, displayName: channels.displayName })
    .from(channels)
    .orderBy(asc(channels.id));
}

/** A campaign created on its strategy, in an org with several accounts,
 *  that did not say which one it lives on. */
export class ChannelChoiceRequiredError extends AppError {
  readonly recovery: string;

  constructor(choices: readonly ChannelChoice[]) {
    super(
      "channel_choice_required",
      `This organization has ${choices.length} connected accounts, and a campaign lives on one of them for life, so it was not created.`,
      409,
    );
    this.recovery = `Ask the owner which account it is for, then create it again with channelId: ${choices
      .map((choice) => `${choice.id} (${choice.network} · ${choice.displayName ?? "unnamed account"})`)
      .join(", ")}.`;
  }
}

export class UnknownChannelError extends AppError {
  readonly recovery =
    "Nothing was created. Use a channelId this organization has — the accounts are on Channels.";

  constructor(channelId: number) {
    super("channel_not_found", `channel ${channelId} is not an account this organization has`, 404);
  }
}

/**
 * The account a new campaign is bound to for life (INV-34): the one the
 * owner chose; else the org's only account — and when there are several, the
 * create refuses until the owner says which. Null in an org with no account
 * yet, as the backfill binds it later.
 */
async function newCampaignChannelId(
  tx: Tx,
  chosen: number | undefined,
): Promise<number | null> {
  const choices = await campaignChannelChoices(tx);
  if (chosen !== undefined) {
    if (!choices.some((choice) => choice.id === chosen)) throw new UnknownChannelError(chosen);
    return chosen;
  }
  if (choices.length > 1) throw new ChannelChoiceRequiredError(choices);
  return choices[0]?.id ?? null;
}

/** A campaign created on its strategy turned Active before its strategy
 *  started: the Start campaign card is the only yes that does that. */
export class CampaignNotStartedError extends AppError {
  readonly recovery =
    "Nothing changed. It becomes Active when the owner answers Start campaign on the card that proposes its strategy — propose one in Engager's chat (engager-campaigns).";

  constructor() {
    super("campaign_not_started", "This campaign has not started, so its status does not turn it on.", 409);
  }
}

/** Refuse turning a not-started campaign Active from anywhere but its Start
 *  (`strategy/patch.ts`), which activates a version first. */
async function assertStartedBeforeActive(
  tx: Tx,
  campaign: Pick<Campaign, "id" | "status">,
  status: Campaign["status"] | undefined,
): Promise<void> {
  if (status !== "active" || campaign.status === "active") return;
  if (!(await strategyInForce(tx, campaign.id))) throw new CampaignNotStartedError();
}

/**
 * Bind every campaign that has no channel yet to the one `createCampaignOp`
 * would have chosen, and return how many it bound.
 *
 * The expand half of making `campaigns.channel_id` required (contraction
 * ticket [7]): a campaign in an org with no channel stays null — there is no
 * account to bind it to, so its strategy cannot activate — and every other
 * one is bound for life. Keyed on the null it clears, so a second run binds
 * nothing. Never rebinds: a campaign that already has a channel keeps it.
 *
 * Its workers are stamped with it in the same transaction, as
 * `createCampaignOp` stamps the Scout it mints: a worker names the account it
 * spends against, and one left null beside a bound campaign would imply its
 * account from the campaign again.
 */
export async function backfillCampaignChannels(tx: Tx): Promise<number> {
  const channelId = await defaultCampaignChannelId(tx);
  if (channelId === null) return 0;
  const bound = await tx
    .update(campaigns)
    .set({ channelId })
    .where(isNull(campaigns.channelId))
    .returning({ id: campaigns.id });
  if (bound.length > 0) {
    await tx
      .update(workers)
      .set({ channelId })
      .where(
        and(
          inArray(
            workers.campaignId,
            bound.map((row) => row.id),
          ),
          isNull(workers.channelId),
        ),
      );
  }
  return bound.length;
}

/**
 * Patch an existing campaign. Scalar fields override when provided; nested config
 * objects are shallow-merged over the existing ones (so an agent can tweak one
 * field — e.g. `tone.promo_ratio` — without resending the whole config).
 */
export async function updateCampaignOp(
  tx: Tx,
  id: number,
  input: CampaignInput,
  options: CampaignOperationOptions = {},
): Promise<{ ok: boolean }> {
  const isPublic = options.surface !== "internal";
  const now = options.now ?? Date.now();
  if (isPublic) {
    assertPublicInputWellFormed(input);
    await lockPublicCampaignPolicy(tx);
  }
  const [existing] = await tx
    .select()
    .from(campaigns)
    // A deleted campaign is final: no update or status brings it back.
    .where(and(eq(campaigns.id, id), isNull(campaigns.deletedAt)))
    .for("update");
  if (!existing) return { ok: false };
  await assertStartedBeforeActive(tx, existing, input.status);
  // Research is the strategy's projection (INV-25), so the arm that writes it
  // refuses and nothing is written; so does "like when commenting", which the
  // strategy's Like post replaces and nothing reads, and the retired mode
  // inputs.
  assertNotStrategyOwned({
    switches:
      input.verifyStage !== undefined ||
      input.likeWhenCommenting !== undefined ||
      input.mode !== undefined ||
      input.automation !== undefined,
    wake: false,
  });
  if (isPublic) {
    if (existing.objective !== "product" && input.objective === "product") {
      const resultingProductIds =
        options.productIds ??
        (
          await tx
            .select({ productId: campaignProducts.productId })
            .from(campaignProducts)
            .where(eq(campaignProducts.campaignId, id))
        ).map((row) => row.productId);
      if (resultingProductIds.length === 0) {
        throw new CampaignProductRequiredError(
          `Campaign ${id} cannot switch to the Product objective without an attached product.`,
          "Select at least one product in the same update, then retry the objective change.",
        );
      }
    }
    await assertPublicUpdateFlow(tx, existing, input, now);
  }

  const {
    mode,
    automation,
    discovery,
    aiFilter,
    audienceProfile: nextAudience,
    baseRevision,
    tone,
    prompts,
    ...scalars
  } = input;
  const patch: Partial<NewCampaign> = { ...scalars };
  if (nextAudience && aiFilter?.instruction !== undefined) throw new Error("Send the audience profile or a relevance test, not both.");
  if (nextAudience !== undefined) {
    Object.assign(patch, await audienceRevisionPatch(tx, existing, nextAudience, baseRevision, options.audienceWrite ?? { reason: "agent", changedBy: "agent" }, now));
  }
  // No mode down-shift teardown. It fired when a request NAMED a Review →
  // Curate move on the retired ladder, and revoked the campaign's scheduled
  // credential plus the org-level own-post reply consent for it. Neither rung
  // exists, so the request names nothing and the teardown had no trigger left
  // that was not an accident of a frozen column. Real authority changes
  // (status, drafting owner) still revoke, below.
  if (discovery !== undefined)
    // The merge, when asked for, happens HERE — against `existing`, the row
    // locked above — and never against a copy some caller read before the lock.
    // A partial repair merged from a pre-lock read silently reverts whatever a
    // concurrent writer committed to a field the patch does not name.
    patch.discovery = options.mergeDiscovery
      ? { ...(existing.discovery ?? {}), ...discovery }
      : discovery;
  if (aiFilter !== undefined) {
    const projected = patch.aiFilter?.instruction;
    patch.aiFilter = {
      ...(existing.aiFilter ?? { instruction: "" }),
      ...aiFilter,
      ...(projected === undefined ? {} : { instruction: projected }),
    };
    if (!nextAudience && aiFilter.instruction !== undefined && aiFilter.instruction !== (existing.aiFilter?.instruction ?? "")) {
      const revision = await audiencePatch(tx, existing, {
        ...editableAudience(audienceProfile(existing)), testSource: "owner", ownerRule: aiFilter.instruction,
      }, options.audienceWrite ?? { reason: "agent", changedBy: "agent" }, now);
      Object.assign(patch, revision, { aiFilter: { ...patch.aiFilter, instruction: revision.aiFilter?.instruction ?? aiFilter.instruction } });
    }
  }
  if (tone !== undefined) patch.tone = { ...(existing.tone ?? {}), ...tone };
  // Key-presence preserved (an absent key never clears the other field);
  // default-equal text normalizes to undefined so the spread clears any frozen
  // copy and the row inherits the live default again.
  if (prompts !== undefined)
    patch.prompts = {
      ...(existing.prompts ?? {}),
      ...prompts,
      ...("comment_guidance" in prompts
        ? {
            comment_guidance: storableCommentGuidance(prompts.comment_guidance),
          }
        : {}),
      ...("reply_guidance" in prompts
        ? { reply_guidance: storableReplyGuidance(prompts.reply_guidance) }
        : {}),
      ...("reply_policy" in prompts
        ? { reply_policy: storableReplyPolicy(prompts.reply_policy) }
        : {}),
    };
  Object.assign(patch, statusStamp(existing.status, scalars.status, now, options.actor));
  const [patched] = await tx
    .update(campaigns)
    .set({
      ...patch,
      // No warm-up stamp here: activation, pause and archive arm nothing. The
      // ramp starts on the first Automatic Comment
      // (`stampChannelWarmupStart`, operations/workers.ts) and its anchor
      // is the CHANNEL's. Archive can no longer take the clock with it: the
      // clock is not on the row being archived, so the account keeps the ramp
      // it has already carried.
      updatedAt: now,
    })
    .where(eq(campaigns.id, id))
    .returning();
  // Nothing arms a comment from a campaign column any more, and the
  // one control that RETRACTS already-armed work is the kill switch.
  // A status that moved projects the wake — the status IS it.
  if (patched && patched.status !== existing.status) {
    await projectWake(tx, id, now);
  }

  return { ok: true };
}

/**
 * KEEP QUICK — the owner's answer to Overview's offer to run a Quick campaign
 * every day at Standard once its first look finished: remembered on the
 * campaign, so the offer does not come back. Its stamp alone: keeping Quick
 * changes nothing the campaign says, so `updatedAt` — the list's order —
 * stays. False for a campaign that no longer stands.
 */
export async function dismissDepthOffer(tx: Tx, id: number, now: number): Promise<boolean> {
  const [row] = await tx
    .update(campaigns)
    .set({ depthOfferDismissedAt: now })
    .where(and(eq(campaigns.id, id), isNull(campaigns.deletedAt)))
    .returning({ id: campaigns.id });
  return row !== undefined;
}

/**
 * KEEP IT AS IT IS — the owner's answer to the Inbox's suggestion of a wider
 * line after a Quick first look that found no one: remembered on the
 * campaign, so the suggestion does not come back. Its stamp alone, as Keep
 * Quick's (`dismissDepthOffer`). False for a campaign that no longer stands.
 */
export async function dismissWidenOffer(tx: Tx, id: number, now: number): Promise<boolean> {
  const [row] = await tx
    .update(campaigns)
    .set({ widenOfferDismissedAt: now })
    .where(and(eq(campaigns.id, id), isNull(campaigns.deletedAt)))
    .returning({ id: campaigns.id });
  return row !== undefined;
}

export async function setCampaignStatusOp(
  tx: Tx,
  id: number,
  status: Campaign["status"],
  now = Date.now(),
  options: CampaignOperationOptions = {},
): Promise<boolean> {
  // Same order as updateCampaignOp: the org policy lock, then the row lock.
  if (options.surface !== "internal") await lockPublicCampaignPolicy(tx);
  const [existing] = await tx
    .select()
    .from(campaigns)
    // A deleted campaign is final: no update or status brings it back.
    .where(and(eq(campaigns.id, id), isNull(campaigns.deletedAt)))
    .for("update");
  if (!existing) return false;
  await assertStartedBeforeActive(tx, existing, status);
  if (options.surface !== "internal") {
    assertPublicInputWellFormed({ status });
    if (status === "active") {
      await assertPublicUpdateFlow(tx, existing, { status }, now);
    }
  }
  // No warm-up stamp: a status change arms no publishing, so it ramps nothing
  // (INV-1). The clock starts on the first Automatic Comment — see
  // `stampChannelWarmupStart` in operations/workers.ts — and its anchor is
  // the CHANNEL's. Activating, pausing or archiving any
  // campaign therefore leaves the account's ramp exactly where it was; archiving
  // cannot clear a clock that never lived on the campaign row.
  const patch = { status, updatedAt: now, ...statusStamp(existing.status, status, now, options.actor) };
  const [updated] = await tx
    .update(campaigns)
    .set(patch)
    .where(eq(campaigns.id, id))
    .returning();
  // The status IS the wake: every worker's `auto` follows it in this
  // transaction, so a paused campaign leaves `dueWorkers` nothing to find
  // (INV-25).
  if (updated) await projectWake(tx, id, now);
  // The Resume plans what the pause held: sends approved while it was Paused,
  // and any whose slot passed meanwhile (`heldForResume`).
  if (updated && status === "active" && existing.status === "paused") {
    await scheduleHeldSends(tx, updated, now);
  }
  // First activation — a create is always Paused, so this is where a
  // campaign's first find comes from: the exactly-once kick, keyed `:first`
  // so a later re-activation never doubles it.
  if (
    updated &&
    status === "active" &&
    existing.status !== "active" &&
    isSupportedPublicCampaignRuntime({ ...existing, status })
  ) {
    await kickFirstDiscovery(tx, id, options);
  }
  return updated !== undefined;
}

/**
 * The campaign's one exactly-once first sweep, routed.
 *
 * It is a run of the campaign's SCOUT — the job `discoverNow` enqueues — rather
 * than a bare `discover_posts` job. That job wrote no run row, so the sweep
 * that filled a new campaign's pool never appeared on its Scout's Runs page,
 * which said "no runs" over 131 posts it had found. `agent` because the
 * owner's agent is what creates or activates a campaign with a background agent
 * alive —
 * the setup first sweep the run log's own `trigger` names — and a press, not a
 * schedule, is floored like one.
 *
 * A job is still a JOB, and on an install with no agent process nothing will
 * ever claim it: `save_campaign` left a row sitting `queued` forever while
 * the receipt said the first discovery was on its way. Under the external
 * judgment policy no row is written and the outcome is reported as `owed` — the
 * first sweep waits for a background agent.
 *
 * The `:first` key is untouched in the owed case, so a campaign first activated
 * with no agent process and activated again against a healthy one still gets
 * exactly one kick.
 */
async function kickFirstDiscovery(
  tx: Tx,
  campaignId: number,
  options: CampaignOperationOptions,
): Promise<void> {
  if (
    (await resolveJudgmentPolicy(tx, options.judgmentPolicy)) ===
    "interactive_external"
  ) {
    options.onFirstDiscovery?.("owed");
    return;
  }
  // Every campaign is created with its Scout, but a strategy change can remove it,
  // and a paused campaign activated after that has nothing to run the sweep.
  // Refusing would block the activation over a sweep nobody can do.
  const workerId = await scoutIdFor(tx, campaignId);
  if (workerId == null) return;
  const payload: WorkerRunPayload = { workerId, trigger: "agent" };
  await enqueue(tx, {
    type: "worker_run",
    payload,
    idempotencyKey: `worker:${workerId}:first`,
  });
  options.onFirstDiscovery?.("queued");
}

// `startWarmupOp` is deleted. It described itself as a compatibility backfill
// for "activation paths [that] start the ramp themselves", and its only
// importer was its own test — a backfill that has never backfilled. Now that
// the ramp starts on the publish-arm edge there is nothing left for it to
// stand in for.
