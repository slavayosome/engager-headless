import { sql, type SQL } from "drizzle-orm";
import { db } from "./client";

/**
 * Domain tables that hold tenant data and are isolated by RLS on `organization_id`.
 * Excluded on purpose: identity/billing-global tables (organizations/users/
 * accounts/memberships/invitations/subscriptions/billing_checkout_claims/
 * license_seats/commercial_offer_intents (the cloud binds a Mac seat and
 * records an offer-change intent from a token it signed itself, before any
 * tenant scope exists — and an intent predates the subscription it changes)/
 * transfer_intents (an installation's own record of which side of a handoff it
 * is; coordination state that a FENCED source must still be able to advance,
 * so it deliberately carries no tenant policy and no write-fence trigger)/
 * owner_initial_trial_claims/
 * device_auth_rate_limits (shared public-endpoint abuse budget)/deployment_metadata/
 * ai_usage (hosted-extras spend metering, resolved cloud-side before any
 * tenant scope exists; retires with the hosted extras)/
 * license_device_requests/license_refresh_tokens (hosted license device and
 * refresh flow resolves an opaque code or token hash before tenant scope
 * exists)/
 * report_relays (the cloud's idempotency record for a relayed problem report,
 * written for an install that may carry no credential at all)/
 * stripe_events/stripe_projection_leases) and `jobs`,
 * which the worker scans cross-org to claim before entering an org scope.
 */
export const RLS_TABLES = [
  "voices",
  "voice_samples",
  "voice_revisions",
  "voice_questions",
  "angle_profile_revisions",
  "channels",
  "campaigns",
  "campaign_audience_revisions",
  "audience_themes",
  "campaign_strategies",
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
] as const;

/**
 * Tenant tables whose runtime role deliberately has narrower permissions than
 * the ordinary read/write tenant policy. Keep this exported so migration
 * firebreak tests can prove that pre-commit SQL and the recurring RLS installer
 * assign the same policy family.
 */
export const LIMITED_WRITE_RLS_TABLES = [
  "subscription_activations",
  "email_delivery_receipts",
  "message_draft_revisions",
  "message_status_events",
  // A conversation's log and its conversion evidence are append-only: a
  // correction is a superseding row.
  "conversation_events",
  "outcome_events",
  // Each attempt to read an account's inbox, kept for its coverage.
  "inbox_reads",
  // What the server did with each tool call a step proposed, written once.
  "step_tool_calls",
] as const satisfies readonly (typeof RLS_TABLES)[number][];

const LIMITED_WRITE_RLS_TABLE_SET = new Set<string>(LIMITED_WRITE_RLS_TABLES);

export const LIMITED_WRITE_UPDATE_TABLES = [
  "email_delivery_receipts",
] as const satisfies readonly (typeof LIMITED_WRITE_RLS_TABLES)[number][];

const LIMITED_WRITE_UPDATE_TABLE_SET = new Set<string>(
  LIMITED_WRITE_UPDATE_TABLES,
);

/** Tables the application reads, appends to and updates but never deletes from:
 *  the provider circuit is state a worker advances, not a record it discards. */
export const NO_DELETE_RLS_TABLES = [
  "cloud_provider_circuits",
] as const satisfies readonly (typeof RLS_TABLES)[number][];

const NO_DELETE_RLS_TABLE_SET = new Set<string>(NO_DELETE_RLS_TABLES);

/**
 * Enable + FORCE row-level security on every tenant table and (re)create the
 * isolation policy keyed on the `app.current_org` GUC. Idempotent — safe to run on
 * every migrate. FORCE makes even the table owner (our app's role) subject to RLS,
 * so a query made outside a `withOrg` scope sees nothing and writes are rejected.
 */
export function rlsStatementsForTable(t: (typeof RLS_TABLES)[number]): SQL[] {
  const statements: SQL[] = [];
  statements.push(sql.raw(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`));
  statements.push(sql.raw(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`));
  statements.push(sql.raw(`DROP POLICY IF EXISTS tenant_isolation ON "${t}"`));
  statements.push(sql.raw(`DROP POLICY IF EXISTS tenant_read ON "${t}"`));
  statements.push(sql.raw(`DROP POLICY IF EXISTS tenant_append ON "${t}"`));
  statements.push(sql.raw(`DROP POLICY IF EXISTS tenant_update ON "${t}"`));
  statements.push(
    sql.raw(`DROP POLICY IF EXISTS tenant_retention_delete ON "${t}"`),
  );

  if (NO_DELETE_RLS_TABLE_SET.has(t)) {
    const predicate =
      "organization_id = nullif(current_setting('app.current_org', true), '')::uuid";
    statements.push(
      sql.raw(
        `CREATE POLICY tenant_read ON "${t}" FOR SELECT USING (${predicate})`,
      ),
    );
    statements.push(
      sql.raw(
        `CREATE POLICY tenant_append ON "${t}" FOR INSERT WITH CHECK (${predicate})`,
      ),
    );
    statements.push(
      sql.raw(
        `CREATE POLICY tenant_update ON "${t}" FOR UPDATE ` +
          `USING (${predicate}) WITH CHECK (${predicate})`,
      ),
    );
    return statements;
  }

  // Receipts and finite Radar cohorts are append-only sources of truth. Work
  // orders are state machines, never app-deleted records (otherwise ON DELETE
  // CASCADE could erase receipts). Tenant isolation still gates every permitted
  // operation despite broad grants.
  if (LIMITED_WRITE_RLS_TABLE_SET.has(t)) {
    statements.push(
      sql.raw(
        `CREATE POLICY tenant_read ON "${t}" FOR SELECT ` +
          `USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)`,
      ),
    );
    statements.push(
      sql.raw(
        `CREATE POLICY tenant_append ON "${t}" FOR INSERT ` +
          `WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)`,
      ),
    );
    if (LIMITED_WRITE_UPDATE_TABLE_SET.has(t)) {
      statements.push(
        sql.raw(
          `CREATE POLICY tenant_update ON "${t}" FOR UPDATE ` +
            `USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid) ` +
            `WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)`,
        ),
      );
    }
    return statements;
  }

  statements.push(
    sql.raw(
      `CREATE POLICY tenant_isolation ON "${t}" ` +
        `USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid) ` +
        `WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)`,
    ),
  );
  return statements;
}

/** Each parameter-free batch is one implicit PostgreSQL transaction. A failed
 * policy replacement keeps that table's previous policies and RLS flags intact. */
export async function applyRls(client: typeof db = db): Promise<void> {
  for (const table of RLS_TABLES) {
    await client.execute(
      sql.join(rlsStatementsForTable(table), sql.raw(";\n")),
    );
  }
}
