import { LINKEDIN_ACTIONS, modeKeyOf, type ActionMode, type ModeKey, type NetworkCatalog } from "./catalog";
import type { CampaignAgentStrategy, StrategyStep } from "./contract";

/**
 * The spec's §14 example policy, as the contract stores it.
 *
 * Verbatim except where Phase 37's contract deliberately differs from the
 * spec, each a decision rather than a drift:
 *
 * - `campaign_id` is null: the example carries `budgets` and `schedule`, which
 *   are exposure, so they live on the ACCOUNT DEFAULT only (INV-28 resolved
 *   against INV-4). The same document under a campaign id fails.
 * - `like` is `like_target`, the catalog's key for Like post and Like reply,
 *   in the budgets.
 * - Its `modes` are gone: an action's mode is its step's binding alone, and
 *   the account default binds no step.
 * - `publish_comment` and `public_reply` have no rolling-24h budget: their
 *   ceiling is the channel's day plan, so the keys are gone.
 * - `grant_ids` is `grants`, and `policy_id`, `account_id` and
 *   `execution_control_id` are gone: the row is the policy's identity and its
 *   channel is the account.
 */
export function section14AccountDefault(): CampaignAgentStrategy {
  return {
    schema_version: 6,
    capability_groups: ["conversation", "conversion"],
    campaign_id: null,
    version: 3,
    previous_version: 2,
    effective_at: "2026-10-10T14:00:00Z",
    grants: ["grant_like", "grant_invite", "grant_accept", "grant_dm", "grant_followup"],
    observation: {
      source_scopes: ["own_comments"],
      direct_replies_only: true,
      replay_lookback_hours: 168,
      catchup_requires_review: true,
    },
    eligibility: {
      neutral_relevant: "eligible",
      negative: "skip",
      spam: "skip",
      unknown: "review",
      exclusion_set_id: "exclusions_demo",
    },
    invite: { note_required: true, no_repeat_invite: true },
    dm: { outgoing_acceptance: "wait_for_interest", incoming_linked_opener: true },
    cta: { after_relevant_exchanges: 1, cta_asset_id: "engager_beta_offer_v1" },
    followup: { max_count: 1, delay_hours: 72, requires_explicit_interest: true },
    budgets: {
      max_outbound_dms_per_person_per_30d: 3,
      action_budgets_per_rolling_24h: {
        like_target: null,
        invite: null,
        accept_invite: null,
        dm: null,
        followup: null,
      },
    },
    schedule: {
      timezone: "Europe/London",
      allowed_windows: [
        { weekdays: [1, 2, 3, 4, 5], start_local: "09:00", end_local: "17:00" },
      ],
      booking_link_id: "engager_beta_booking_v1",
      calendar_coverage_ids: [],
    },
    voice: {
      voice_profile_id: "voice_demo_v2",
      casing: "sentence",
      capital_i: true,
      sentence_target: 3,
      random_typos: false,
    },
    knowledge_profile_id: "engager_facts_v1",
    retention: { content_days: 90, audit_days: 365 },
    safety: {
      human_takeover_blocks_send: true,
      fresh_check_required: true,
      unknown_send: "reconcile_only",
    },
    memory_bindings: [],
  };
}

const STEP_DEFAULTS: Pick<
  StrategyStep,
  | "instructions"
  | "output_schema"
  | "model_override"
  | "budget"
  | "on_missing_context"
  | "on_no_progress"
  | "barriers"
> = {
  instructions: "",
  output_schema: "AgentStepResult.v1",
  model_override: null,
  budget: {
    iterations_per_wake: 4,
    tool_actions_per_wake: 3,
    elapsed_seconds_per_wake: 120,
    tokens_per_wake: 8000,
  },
  on_missing_context: "wait_or_review",
  on_no_progress: "escalate",
  barriers: [],
};

/**
 * A campaign with every Ambassador step the catalog has, each binding its
 * actions with no mode — so each is Off until a suite sets it
 * (`withActionModes`). A suite edits the copy it gets.
 */
export function conversationCampaign(): CampaignAgentStrategy {
  return {
    schema_version: 6,
    capability_groups: ["public_engagement", "conversation", "conversion"],
    campaign_id: 7,
    version: 1,
    previous_version: null,
    effective_at: "2026-10-10T14:00:00Z",
    grants: [
      "grant_publish_comment",
      "grant_public_reply",
      "grant_like",
      "grant_invite",
      "grant_accept",
      "grant_dm",
      "grant_followup",
    ],
    steps: [
      {
        ...STEP_DEFAULTS,
        step_id: "comment_on_posts",
        catalog_step: "comment_on_posts",
        worker: "ambassador",
        label: "Comment on posts",
        objective: "Join the conversation.",
        context_refs: ["campaign_voice"],
        allowed_tools: ["draft_comment", "publish_comment", "like_target"],
        action_binding_refs: ["comment", "like_post"],
        entry: { event: "candidate_matched" },
      },
      {
        ...STEP_DEFAULTS,
        step_id: "handle_reply",
        catalog_step: "handle_reply",
        worker: "ambassador",
        label: "Reply when they answer",
        objective: "Answer their point.",
        context_refs: ["verified_thread"],
        allowed_tools: ["read_thread", "draft_comment", "reply_public", "like_target"],
        action_binding_refs: ["reply", "like_reply"],
        entry: { event: "direct_reply" },
      },
      {
        ...STEP_DEFAULTS,
        step_id: "connect",
        catalog_step: "connect",
        worker: "ambassador",
        label: "Invite to connect",
        objective: "Connect with people who engaged.",
        context_refs: ["relationship_state"],
        allowed_tools: ["read_profile", "send_invitation", "accept_invitation"],
        action_binding_refs: ["invite", "accept"],
        entry: { event: "invitation_status" },
      },
      {
        ...STEP_DEFAULTS,
        step_id: "continue_in_dms",
        catalog_step: "continue_in_dms",
        worker: "ambassador",
        label: "Message after they accept",
        objective: "Continue where they showed interest.",
        context_refs: ["relationship_state", "campaign_voice"],
        allowed_tools: ["draft_dm", "send_dm", "followup"],
        action_binding_refs: ["dm", "followup"],
        entry: { event: "inbound_dm" },
      },
      {
        ...STEP_DEFAULTS,
        step_id: "check_outcome",
        catalog_step: "check_outcome",
        worker: "ambassador",
        label: "Check outcome",
        objective: "Record what came of it.",
        context_refs: [],
        allowed_tools: ["record_outcome"],
        action_binding_refs: ["outcome"],
        entry: { event: "outcome_evidence" },
      },
    ],
    action_bindings: [
      { action_binding_id: "comment", owner_step_id: "comment_on_posts", capability_ref: "publish_comment" },
      { action_binding_id: "like_post", owner_step_id: "comment_on_posts", capability_ref: "like_target", target: "post" },
      { action_binding_id: "reply", owner_step_id: "handle_reply", capability_ref: "reply_public" },
      { action_binding_id: "like_reply", owner_step_id: "handle_reply", capability_ref: "like_target" },
      { action_binding_id: "invite", owner_step_id: "connect", capability_ref: "send_invitation" },
      { action_binding_id: "accept", owner_step_id: "connect", capability_ref: "accept_invitation" },
      { action_binding_id: "dm", owner_step_id: "continue_in_dms", capability_ref: "send_dm" },
      { action_binding_id: "followup", owner_step_id: "continue_in_dms", capability_ref: "followup" },
      { action_binding_id: "outcome", owner_step_id: "check_outcome", capability_ref: "record_outcome" },
    ],
    observation: {
      source_scopes: ["own_comments"],
      direct_replies_only: true,
      replay_lookback_hours: 168,
      catchup_requires_review: true,
    },
    eligibility: {
      neutral_relevant: "eligible",
      negative: "skip",
      spam: "skip",
      unknown: "review",
      exclusion_set_id: null,
    },
    invite: { note_required: true, no_repeat_invite: true },
    dm: { outgoing_acceptance: "wait_for_interest", incoming_linked_opener: true },
    cta: { after_relevant_exchanges: 1, cta_asset_id: "offer_v1" },
    followup: { max_count: 1, delay_hours: 72, requires_explicit_interest: true },
    voice: {
      voice_profile_id: null,
      casing: "preserve_user",
      capital_i: true,
      sentence_target: null,
      random_typos: false,
    },
    knowledge_profile_id: null,
    retention: { content_days: 90, audit_days: 365 },
    safety: {
      human_takeover_blocks_send: true,
      fresh_check_required: true,
      unknown_send: "reconcile_only",
    },
    memory_bindings: [],
  };
}

/**
 * `document` with every binding of each named key set to its mode — Like
 * post and Like reply both, for `like_target` — the way a suite says "invites
 * at Ask me" without naming each binding. Pure.
 */
export function withActionModes(
  document: CampaignAgentStrategy,
  modes: Partial<Record<ModeKey, ActionMode>>,
): CampaignAgentStrategy {
  if (!document.action_bindings) return document;
  return {
    ...document,
    action_bindings: document.action_bindings.map((binding) => {
      const key = modeKeyOf(binding.capability_ref);
      const mode = key === null ? undefined : modes[key];
      return mode === undefined ? binding : { ...binding, mode };
    }),
  };
}

/**
 * A second network that exists only in tests: LinkedIn's rows minus `connect`,
 * with its own label for the like — what X or Reddit would look like as rows.
 * It needs no schema change, which is the property it proves.
 */
export const FIXTURE_NETWORK: NetworkCatalog = {
  network: "fixture",
  actions: LINKEDIN_ACTIONS.filter((row) => row.kind !== "connect").map((row) =>
    row.kind === "react" && row.step === "comment_on_posts"
      ? { ...row, label: "Upvote" }
      : row,
  ),
};
