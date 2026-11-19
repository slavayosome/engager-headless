/**
 * The declaration of what an owner's export contains, physical table by
 * physical table (INV-16: the gate blocks unattended work only, and destroys
 * nothing — that promise is unfalsifiable until something in the repo says
 * what the owner's data IS). This module is not an exporter — it writes no
 * bytes and touches no connection — and it is not RLS: `rls.ts#RLS_TABLES`
 * answers "does this table carry `organization_id` and get isolated by it",
 * a narrower and different question than "does this table's content belong
 * to the owner and travel in a portable export". It has no runtime imports
 * on purpose, so its test stays connectionless the way
 * `migration-guards.test.ts` does.
 *
 * Every physical table in the schema is accounted for below in exactly one
 * of three buckets, keyed on the PHYSICAL table name (never the exported
 * const name — `publicAuthRateLimits` and `deviceAuthRateLimits` are two
 * consts for the one physical `device_auth_rate_limits` table, and
 * `scoutDailyOpportunities` declares the physical table
 * `radar_daily_opportunities`, so only the physical name is a safe key):
 *
 * - `EXPORT_TENANT_TABLES` — the org-scoped rows an owner's export must
 *   carry: every table RLS isolates on `organization_id`, plus
 *   `organizations`, `users`, `memberships`, and `invitations`, which are
 *   the owner's own identity, org, roster, and pending invites even though
 *   none of the four is an RLS-isolated table (`organizations` is keyed on
 *   `id`, not `organization_id`, and the other three sit outside
 *   `RLS_TABLES` for reasons unrelated to whether the rows are the owner's).
 * - `EXPORT_BILLING_GLOBAL_TABLES` — `subscriptions`,
 *   `billing_checkout_claims`, `commercial_offer_intents`, and `ai_usage`:
 *   rows keyed to the org but living on a table outside tenant isolation.
 * - `EXPORT_EXCLUDED_TABLES` — everything else, with a declared reason and a
 *   one-line note saying why those rows are not the owner's content.
 */

export const EXPORT_TENANT_TABLES = [
  "voices",
  "voice_samples",
  "voice_revisions",
  "voice_questions",
  "angle_profile_revisions",
  "channels",
  "campaigns",
  "campaign_strategies",
  "campaign_audience_revisions",
  "audience_themes",
  "discovered_posts",
  "search_lookalikes",
  "discovery_author_dismissals",
  "messages",
  "message_draft_revisions",
  "message_status_events",
  "incoming_comments",
  "engagement_events",
  "comment_watches",
  "engaged_profiles",
  "author_profiles",
  "leads",
  "searches",
  "lead_signals",
  "lead_thread_reads",
  "lead_source_reads",
  "search_changes",
  "search_plans",
  "company_reads",
  "lead_ratings",
  "person_reads",
  "conversations",
  "conversation_events",
  "conversation_sources",
  "incoming_invitations",
  "outcome_events",
  "dm_threads",
  "inbox_reads",
  "memory_records",
  "feedback",
  "exemplars",
  "campaign_guidance",
  "prompts",
  "rate_limit_ledger",
  "email_delivery_receipts",
  "pacing_state",
  "secrets",
  "profile",
  "system_state",
  "mcp_app_card_sessions",
  "chat_sessions",
  "tasks",
  "chat_broker_turns",
  "chat_messages",
  "chat_pending_changes",
  "worker_runs",
  "workers",
  "step_runs",
  "step_tool_calls",
  "actions",
  "action_approvals",
  "pause_controls",
  "live_checks",
  "subscription_activations",
  "candidate_feedback",
  "candidate_actions",
  "candidate_research",
  "room_snapshots",
  "room_members",
  "room_exclusions",
  "room_reply_drafts",
  "room_reply_assists",
  "composer_drafts",
  "compiled_writing_rules",
  "draft_plans",
  "draft_attempts",
  "brain_questions",
  "brain_state",
  "brain_vault_mirror",
  "products",
  "product_facts",
  "campaign_products",
  "offers",
  "cloud_provider_circuits",
  "supervision_state",
  "supervision_events",
  "worker_missed_runs",
  "maintenance_receipts",
  "runtime_heartbeats",
  "bug_reports",
  "organizations",
  "users",
  "memberships",
  "invitations",
] as const;

export const EXPORT_BILLING_GLOBAL_TABLES = [
  "subscriptions",
  "billing_checkout_claims",
  "commercial_offer_intents",
  "ai_usage",
] as const;

export const EXPORT_EXCLUSION_REASONS = [
  "credential",
  "runtime",
  "provider",
] as const;

export type ExportExclusionReason = (typeof EXPORT_EXCLUSION_REASONS)[number];

export type ExportExcludedTable = {
  table: string;
  reason: ExportExclusionReason;
  note: string;
};

export const EXPORT_EXCLUDED_TABLES: readonly ExportExcludedTable[] = [

  {
    table: "license_device_requests",
    reason: "credential",
    note: "A short-lived hosted-license device auth artifact, not owner content.",
  },
  {
    table: "database_finalisation",
    reason: "runtime",
    note: "This install's boot-finalisation fingerprint; a restore re-finalises against its own database.",
  },
  {
    table: "report_relays",
    reason: "runtime",
    note: "The cloud relay's idempotency record for a problem report — an id, an install and a message id, never the report itself.",
  },
  {
    table: "license_refresh_tokens",
    reason: "credential",
    note: "A hosted license refresh token, secret material that must not leave in a portable file.",
  },

  {
    table: "accounts",
    reason: "credential",
    note: "Provider refresh tokens for a linked identity, secret material.",
  },
  {
    table: "verification_tokens",
    reason: "credential",
    note: "Single-use email/sign-in verification tokens, secret material.",
  },
  {
    table: "jobs",
    reason: "runtime",
    note: "The cross-org work queue the worker scans to claim jobs before entering an org scope — runtime scheduling state, not the owner's data.",
  },
  {
    table: "device_auth_rate_limits",
    reason: "runtime",
    note: "A shared public-endpoint abuse budget counter, not scoped to one org and not owner content.",
  },
  {
    table: "deployment_metadata",
    reason: "runtime",
    note: "The install's own release and environment markers, server bookkeeping.",
  },
  {
    table: "owner_initial_trial_claims",
    reason: "runtime",
    note: "A one-time trial-claim ledger keyed on owner_user_id recording an allowance already spent — a fact about the server's accounting, not authored content.",
  },
  {
    table: "stripe_projection_leases",
    reason: "runtime",
    note: "A lease token and expiry keyed on subscription_id that serializes Stripe event projection — runtime coordination state, not owner content.",
  },
  {
    table: "transfer_intents",
    reason: "runtime",
    note: "This installation's own record of a handoff — which side it is, what it proved, and which epoch it activated. Placement-specific coordination state: a destination writes its own row and must never inherit the source's.",
  },
  {
    table: "license_seats",
    reason: "credential",
    note: "The device key hashes registered against a paid account — seat credentials whose copy would be a second Mac authority, not the owner's content.",
  },
  {
    table: "stripe_events",
    reason: "provider",
    note: "Stripe's own event id and provider idempotency bookkeeping, not owner content.",
  },
];
