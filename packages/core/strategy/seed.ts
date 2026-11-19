import {
  campaignStrategies,
  type StrategyProvenance,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import {
  CATALOG_STEPS,
  GRANT_IDS,
  MODE_GRANTS,
  type ActionMode,
  type CapabilityGroup,
  type GrantId,
  type ReadMode,
} from "./catalog";
import {
  STRATEGY_SCHEMA_VERSION,
  type ActionBinding,
  type CampaignAgentStrategy,
  type StrategyStep,
} from "./contract";
import { FIND_LEADS_OBJECTIVE } from "./firstCampaignActions";

/**
 * THE SEEDER: a campaign's v1, said in the strategy's words, from the rows
 * that decide what its workers do today — so that resolving the seed
 * reproduces today's switches exactly and nothing else.
 *
 *   Scout's Find posts      ← the Scout's `sweepEnabled`
 *   Scout's Research        ← `campaigns.verifyStage`
 *   Ambassador's Comment    ← the Ambassador's `draftEnabled` (draft ⇒ Ask me)
 *   Ambassador's Like post  ← `campaigns.likeWhenCommenting` (on ⇒ Ask me:
 *                             a Like ships review-only, so the owner's
 *                             "like when commenting" keeps its likes, each
 *                             waiting for a yes; off ⇒ Off)
 *
 * Two rows of one type take the STRICTER of their switches (INV-28's
 * stricter-wins): a campaign with two CommentAuthors seeds one Comment on posts
 * step. A worker's `auto` — whether the server wakes it — is not seeded and
 * the document has no field for it: the wake becomes a projection of the
 * campaign's Active/Paused status, never a strategy value.
 *
 * Seeding writes a strategy row and nothing else — no projection, no
 * switch. A campaign whose org has no channel seeds a `draft`: there is no
 * network to validate its actions against, so it cannot activate.
 */

export const SEED_COMPILER_VERSION = "strategy-seed/1";

/** Illustrative per-wake product budgets (spec §04), not LinkedIn limits. */
export const DEFAULT_STEP_BUDGET = {
  iterations_per_wake: 4,
  tool_actions_per_wake: 3,
  elapsed_seconds_per_wake: 120,
  tokens_per_wake: 8000,
} as const;

/** Pilot retention (spec §14), in days. */
export const DEFAULT_RETENTION = { content_days: 90, audit_days: 365 } as const;

const SAFETY = {
  human_takeover_blocks_send: true,
  fresh_check_required: true,
  unknown_send: "reconcile_only",
} as const;

/** The campaign's own voice (`campaigns.voice_id`), with length left to it. */
const OWN_VOICE = {
  voice_profile_id: null,
  casing: "preserve_user",
  capital_i: true,
  sentence_target: null,
  random_typos: false,
} as const;

/** The blank v1 of a campaign created on its strategy. */
export const BLANK_COMPILER_VERSION = "strategy-blank/1";

const SEED_PROVENANCE: StrategyProvenance = {
  source: "seed",
  instruction: null,
  intent: null,
  scope: null,
  changes: [],
  compilerVersion: SEED_COMPILER_VERSION,
  approver: null,
};

/**
 * The v1 of a campaign CREATED on its strategy: a strategy with no steps yet,
 * which the owner designs in chat (`templates.ts`). It is a `draft` — the
 * campaign is Paused and Not started, and nothing in it wakes until the owner's
 * Start campaign activates the version that design writes (`patch.ts`). Pure.
 */
export function blankDocument(campaignId: number, now: number): CampaignAgentStrategy {
  return {
    schema_version: STRATEGY_SCHEMA_VERSION,
    // The contract wants one group; discovery is the one every campaign's
    // Scout belongs to, and it brings no policy fields of its own.
    capability_groups: ["discovery"],
    campaign_id: campaignId,
    version: 1,
    previous_version: null,
    effective_at: new Date(now).toISOString(),
    grants: [],
    steps: [],
    action_bindings: [],
    voice: OWN_VOICE,
    knowledge_profile_id: null,
    retention: DEFAULT_RETENTION,
    safety: SAFETY,
    memory_bindings: [],
  };
}

/**
 * What an account with no default strategy already resolves as, said as
 * one — the base the owner's first account-policy change is drawn against
 * (`accountPolicy.ts`). Every grant, so no campaign loses a send it has; no
 * `max_mode`, so every step keeps the mode it has; every rolling-24h
 * ceiling and the per-person DM cap null, so no new kind reaches Automatic;
 * and no sending window, so the channel's active hours alone decide when
 * what is allowed goes out — each exactly as the absence of a default reads
 * to the resolver and the gate.
 * Pure.
 */
export function accountDefaultSeed(timezone: string, now: number): CampaignAgentStrategy {
  return {
    schema_version: STRATEGY_SCHEMA_VERSION,
    capability_groups: ["public_engagement"],
    campaign_id: null,
    version: 1,
    previous_version: null,
    effective_at: new Date(now).toISOString(),
    grants: [...GRANT_IDS],
    budgets: {
      max_outbound_dms_per_person_per_30d: null,
      action_budgets_per_rolling_24h: {
        like_target: null,
        invite: null,
        accept_invite: null,
        dm: null,
        followup: null,
      },
    },
    schedule: { timezone, allowed_windows: [], booking_link_id: null, calendar_coverage_ids: [] },
    voice: OWN_VOICE,
    knowledge_profile_id: null,
    retention: DEFAULT_RETENTION,
    safety: SAFETY,
    memory_bindings: [],
  };
}

/**
 * Write a campaign-on-its-strategy's blank v1 as a `draft`. Writes nothing
 * else — no projection, no switch, no wake. Idempotent on the version key.
 */
export async function seedBlankStrategy(
  tx: Tx,
  campaignId: number,
  now: number,
): Promise<void> {
  await tx
    .insert(campaignStrategies)
    .values({
      campaignId,
      channelId: null,
      version: 1,
      status: "draft",
      baseVersion: null,
      document: blankDocument(campaignId, now),
      patchProvenance: { ...SEED_PROVENANCE, compilerVersion: BLANK_COMPILER_VERSION },
      effectiveAt: now,
      createdAt: now,
    })
    .onConflictDoNothing();
}

function step(
  stepId: StrategyStep["catalog_step"],
  worker: StrategyStep["worker"],
  fields: Pick<
    StrategyStep,
    | "objective"
    | "context_refs"
    | "allowed_tools"
    | "action_binding_refs"
    | "entry"
    | "barriers"
  >,
): StrategyStep {
  return {
    step_id: stepId,
    catalog_step: stepId,
    worker,
    label: CATALOG_STEPS[stepId].label,
    instructions: "",
    output_schema: "AgentStepResult.v1",
    model_override: null,
    budget: DEFAULT_STEP_BUDGET,
    on_missing_context: "wait_or_review",
    on_no_progress: "escalate",
    ...fields,
  };
}

/**
 * One catalog step as the seed writes it: the step, the bindings it owns, the
 * grants its sends need and the capability group they belong to. Exported for
 * the one other writer of a whole step — an old writer redirected into a
 * `strategy.patch` (`redirect.ts`) that has to give a strategy back a step
 * it no longer has — so both write the same thing.
 */
export type SeedStep = {
  step: StrategyStep;
  bindings: ActionBinding[];
  grants: GrantId[];
  group: CapabilityGroup;
};

/** The Scout's Find leads, with Research and the Company page read beside
 *  it: three reads, On or Off. The Company page read is Deep, and Off unless
 *  asked for. It stands where Find posts would — a strategy holds one of
 *  them. */
export function findLeadsStep(modes: { find: ReadMode; research: ReadMode; company?: ReadMode }): SeedStep {
  return {
    step: step("find_leads", "scout", {
      objective: FIND_LEADS_OBJECTIVE,
      context_refs: ["audience_spec", "campaign_brief"],
      allowed_tools: ["find_leads", "research_lead", "read_company", "read_thread", "read_profile"],
      action_binding_refs: ["find_leads", "lead_research", "lead_company"],
      entry: { event: "campaign_wake" },
      barriers: [],
    }),
    bindings: [
      {
        action_binding_id: "find_leads",
        owner_step_id: "find_leads",
        capability_ref: "find_leads",
        mode: modes.find,
      },
      {
        action_binding_id: "lead_research",
        owner_step_id: "find_leads",
        capability_ref: "research_lead",
        mode: modes.research,
      },
      {
        action_binding_id: "lead_company",
        owner_step_id: "find_leads",
        capability_ref: "read_company",
        mode: modes.company ?? "off",
      },
    ],
    grants: [],
    group: "discovery",
  };
}

/** The Ambassador's Comment on posts: Comment and Like post, at the modes
 *  given — Off where none is. */
export function commentOnPostsStep(modes: { comment?: ActionMode; like?: ActionMode } = {}): SeedStep {
  return {
    step: step("comment_on_posts", "ambassador", {
      objective:
        "Join the conversation on each post Scout matched, in the owner's voice.",
      context_refs: [
        "research_snapshot",
        "campaign_brief",
        "campaign_voice",
        "product_facts",
      ],
      allowed_tools: [
        "read_thread",
        "read_profile",
        "draft_comment",
        "publish_comment",
        "like_target",
      ],
      action_binding_refs: ["comment", "like_post"],
      entry: { event: "lead_served" },
      barriers: [{ type: "requires_step", step_id: "find_leads" }],
    }),
    bindings: [
      {
        action_binding_id: "comment",
        owner_step_id: "comment_on_posts",
        capability_ref: "publish_comment",
        ...(modes.comment ? { mode: modes.comment } : {}),
      },
      {
        action_binding_id: "like_post",
        owner_step_id: "comment_on_posts",
        capability_ref: "like_target",
        target: "post",
        ...(modes.like ? { mode: modes.like } : {}),
      },
    ],
    grants: [MODE_GRANTS.publish_comment, MODE_GRANTS.like_target],
    group: "public_engagement",
  };
}

/** The Ambassador's Reply when they answer: Reply, at the mode given — Off where
 *  none is. */
export function handleReplyStep(reply?: ActionMode): SeedStep {
  return {
    step: step("handle_reply", "ambassador", {
      objective:
        "Answer a reply under one of your comments or room replies, briefly and in your voice.",
      context_refs: ["verified_thread", "campaign_voice", "product_facts"],
      allowed_tools: ["read_thread", "draft_comment", "reply_public"],
      action_binding_refs: ["reply"],
      entry: { event: "direct_reply" },
      barriers: [],
    }),
    bindings: [
      {
        action_binding_id: "reply",
        owner_step_id: "handle_reply",
        capability_ref: "reply_public",
        ...(reply ? { mode: reply } : {}),
      },
    ],
    grants: [MODE_GRANTS.public_reply],
    group: "public_engagement",
  };
}
