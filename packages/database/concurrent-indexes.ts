import type { PoolClient, QueryResultRow } from "pg";

type MigrationClient = Pick<PoolClient, "query">;

export interface ConcurrentIndexDefinition {
  name: string;
  createSql: string;
  expectedIndexDef: string;
}

interface IndexState extends QueryResultRow {
  isValid: boolean;
  isReady: boolean;
  indexDef: string;
}

interface ConstraintState extends QueryResultRow {
  isValidated: boolean;
}

interface ColumnState extends QueryResultRow {
  isNullable: "YES" | "NO";
}

interface DuplicateActiveSubscriptionState extends QueryResultRow {
  organizationId: string;
  count: number;
}

const INDEX_MAINTENANCE_LOCK = "engager:concurrent-index-maintenance:v1";

/**
 * Keep the tenant-safe discovered-post key first: candidate_feedback,
 * candidate_actions, and the daily Radar cohort composite foreign keys are
 * installed only after this whole list has completed.
 */
export const CONCURRENT_INDEX_DEFINITIONS: readonly ConcurrentIndexDefinition[] =
  [
    {
      name: "discovered_posts_org_campaign_id_unq",
      createSql:
        `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "discovered_posts_org_campaign_id_unq" ` +
        `ON "public"."discovered_posts" ("organization_id","campaign_id","id")`,
      expectedIndexDef:
        "CREATE UNIQUE INDEX discovered_posts_org_campaign_id_unq ON public.discovered_posts USING btree (organization_id, campaign_id, id)",
    },
    {
      name: "candidate_feedback_org_id_uidx",
      createSql:
        `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "candidate_feedback_org_id_uidx" ` +
        `ON "public"."candidate_feedback" ("organization_id","id")`,
      expectedIndexDef:
        "CREATE UNIQUE INDEX candidate_feedback_org_id_uidx ON public.candidate_feedback USING btree (organization_id, id)",
    },
    {
      name: "voices_org_id_unq",
      createSql:
        `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "voices_org_id_unq" ` +
        `ON "public"."voices" ("organization_id","id")`,
      expectedIndexDef:
        "CREATE UNIQUE INDEX voices_org_id_unq ON public.voices USING btree (organization_id, id)",
    },

    {
      name: "exemplars_org_source_ref_uidx",
      createSql:
        `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "exemplars_org_source_ref_uidx" ` +
        `ON "public"."exemplars" ("organization_id","source_ref") ` +
        `WHERE "source_ref" IS NOT NULL`,
      expectedIndexDef:
        "CREATE UNIQUE INDEX exemplars_org_source_ref_uidx ON public.exemplars USING btree (organization_id, source_ref) WHERE (source_ref IS NOT NULL)",
    },
    {
      name: "device_auth_rate_limits_updated_at_idx",
      createSql:
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "device_auth_rate_limits_updated_at_idx" ` +
        `ON "public"."device_auth_rate_limits" ("updated_at")`,
      expectedIndexDef:
        "CREATE INDEX device_auth_rate_limits_updated_at_idx ON public.device_auth_rate_limits USING btree (updated_at)",
    },
    {
      name: "messages_org_campaign_kind_status_betscore_idx",
      createSql:
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "messages_org_campaign_kind_status_betscore_idx" ` +
        `ON "public"."messages" ("organization_id","campaign_id","kind","status","bet_score_at_post" DESC)`,
      expectedIndexDef:
        "CREATE INDEX messages_org_campaign_kind_status_betscore_idx ON public.messages USING btree (organization_id, campaign_id, kind, status, bet_score_at_post DESC)",
    },
    {
      name: "messages_org_id_unq",
      createSql:
        `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "messages_org_id_unq" ` +
        `ON "public"."messages" ("organization_id","id")`,
      expectedIndexDef:
        "CREATE UNIQUE INDEX messages_org_id_unq ON public.messages USING btree (organization_id, id)",
    },
    {
      name: "incoming_comments_org_id_unq",
      createSql:
        `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "incoming_comments_org_id_unq" ` +
        `ON "public"."incoming_comments" ("organization_id","id")`,
      expectedIndexDef:
        "CREATE UNIQUE INDEX incoming_comments_org_id_unq ON public.incoming_comments USING btree (organization_id, id)",
    },
    {
      name: "messages_org_discovered_post_unq",
      createSql:
        `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "messages_org_discovered_post_unq" ` +
        `ON "public"."messages" ("organization_id","discovered_post_id") ` +
        `WHERE "discovered_post_id" IS NOT NULL`,
      expectedIndexDef:
        "CREATE UNIQUE INDEX messages_org_discovered_post_unq ON public.messages USING btree (organization_id, discovered_post_id) WHERE (discovered_post_id IS NOT NULL)",
    },
    {
      name: "messages_org_incoming_comment_unq",
      createSql:
        `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "messages_org_incoming_comment_unq" ` +
        `ON "public"."messages" ("organization_id","incoming_comment_id") ` +
        `WHERE "incoming_comment_id" IS NOT NULL`,
      expectedIndexDef:
        "CREATE UNIQUE INDEX messages_org_incoming_comment_unq ON public.messages USING btree (organization_id, incoming_comment_id) WHERE (incoming_comment_id IS NOT NULL)",
    },
    {
      name: "messages_org_discovered_post_idx",
      createSql:
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "messages_org_discovered_post_idx" ` +
        `ON "public"."messages" ("organization_id","discovered_post_id") ` +
        `WHERE "discovered_post_id" IS NOT NULL`,
      expectedIndexDef:
        "CREATE INDEX messages_org_discovered_post_idx ON public.messages USING btree (organization_id, discovered_post_id) WHERE (discovered_post_id IS NOT NULL)",
    },
    {
      name: "messages_org_target_profile_engagement_idx",
      createSql:
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "messages_org_target_profile_engagement_idx" ` +
        `ON "public"."messages" ("organization_id","target_profile_id","status","posted_at" DESC) ` +
        `WHERE "target_profile_id" IS NOT NULL AND "status" IN ('approved','proposed','posted')`,
      expectedIndexDef:
        "CREATE INDEX messages_org_target_profile_engagement_idx ON public.messages USING btree (organization_id, target_profile_id, status, posted_at DESC) WHERE ((target_profile_id IS NOT NULL) AND (status = ANY (ARRAY['approved'::text, 'proposed'::text, 'posted'::text])))",
    },
    {
      name: "discovered_posts_org_campaign_status_betscore_idx",
      createSql:
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "discovered_posts_org_campaign_status_betscore_idx" ` +
        `ON "public"."discovered_posts" ("organization_id","campaign_id","status","bet_score" DESC)`,
      expectedIndexDef:
        "CREATE INDEX discovered_posts_org_campaign_status_betscore_idx ON public.discovered_posts USING btree (organization_id, campaign_id, status, bet_score DESC)",
    },
    {
      name: "discovered_posts_org_campaign_status_reach_idx",
      createSql:
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "discovered_posts_org_campaign_status_reach_idx" ` +
        `ON "public"."discovered_posts" ("organization_id","campaign_id","status","reach_score" DESC)`,
      expectedIndexDef:
        "CREATE INDEX discovered_posts_org_campaign_status_reach_idx ON public.discovered_posts USING btree (organization_id, campaign_id, status, reach_score DESC)",
    },
    {
      name: "discovered_posts_org_status_selected_at_idx",
      createSql:
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "discovered_posts_org_status_selected_at_idx" ` +
        `ON "public"."discovered_posts" ("organization_id","status","selected_at")`,
      expectedIndexDef:
        "CREATE INDEX discovered_posts_org_status_selected_at_idx ON public.discovered_posts USING btree (organization_id, status, selected_at)",
    },
    {
      name: "discovered_posts_org_campaign_status_id_idx",
      createSql:
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "discovered_posts_org_campaign_status_id_idx" ` +
        `ON "public"."discovered_posts" ("organization_id","campaign_id","status","id")`,
      expectedIndexDef:
        "CREATE INDEX discovered_posts_org_campaign_status_id_idx ON public.discovered_posts USING btree (organization_id, campaign_id, status, id)",
    },
    {
      name: "discovered_posts_org_campaign_discovered_id_idx",
      createSql:
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "discovered_posts_org_campaign_discovered_id_idx" ` +
        `ON "public"."discovered_posts" ("organization_id","campaign_id","discovered_at" DESC,"id" DESC)`,
      expectedIndexDef:
        "CREATE INDEX discovered_posts_org_campaign_discovered_id_idx ON public.discovered_posts USING btree (organization_id, campaign_id, discovered_at DESC, id DESC)",
    },
    {
      name: "discovered_posts_org_discovered_id_idx",
      createSql:
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "discovered_posts_org_discovered_id_idx" ` +
        `ON "public"."discovered_posts" ("organization_id","discovered_at" DESC,"id" DESC)`,
      expectedIndexDef:
        "CREATE INDEX discovered_posts_org_discovered_id_idx ON public.discovered_posts USING btree (organization_id, discovered_at DESC, id DESC)",
    },
    {
      name: "discovered_posts_org_status_discovered_id_idx",
      createSql:
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "discovered_posts_org_status_discovered_id_idx" ` +
        `ON "public"."discovered_posts" ("organization_id","status","discovered_at" DESC,"id" DESC)`,
      expectedIndexDef:
        "CREATE INDEX discovered_posts_org_status_discovered_id_idx ON public.discovered_posts USING btree (organization_id, status, discovered_at DESC, id DESC)",
    },
    {
      name: "discovered_posts_untriaged_id_idx",
      createSql:
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "discovered_posts_untriaged_id_idx" ` +
        `ON "public"."discovered_posts" ("organization_id","campaign_id","id") ` +
        `WHERE "status" IN ('new','held') AND "agent_score" IS NULL`,
      expectedIndexDef:
        "CREATE INDEX discovered_posts_untriaged_id_idx ON public.discovered_posts USING btree (organization_id, campaign_id, id) WHERE ((status = ANY (ARRAY['new'::text, 'held'::text])) AND (agent_score IS NULL))",
    },
    {
      name: "discovered_posts_untriaged_reach_idx",
      createSql:
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "discovered_posts_untriaged_reach_idx" ` +
        `ON "public"."discovered_posts" ("organization_id","campaign_id","reach_score" DESC NULLS LAST,"posted_at" DESC NULLS LAST,"id") ` +
        `WHERE "status" IN ('new','held') AND "agent_score" IS NULL`,
      expectedIndexDef:
        "CREATE INDEX discovered_posts_untriaged_reach_idx ON public.discovered_posts USING btree (organization_id, campaign_id, reach_score DESC NULLS LAST, posted_at DESC NULLS LAST, id) WHERE ((status = ANY (ARRAY['new'::text, 'held'::text])) AND (agent_score IS NULL))",
    },
    {
      name: "candidate_actions_org_active_save_created_id_idx",
      createSql:
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "candidate_actions_org_active_save_created_id_idx" ` +
        `ON "public"."candidate_actions" ("organization_id","created_at" DESC,"id" DESC) ` +
        `WHERE "action" = 'save' AND "reverted_at" IS NULL`,
      expectedIndexDef:
        "CREATE INDEX candidate_actions_org_active_save_created_id_idx ON public.candidate_actions USING btree (organization_id, created_at DESC, id DESC) WHERE ((action = 'save'::text) AND (reverted_at IS NULL))",
    },
    {
      name: "candidate_actions_org_campaign_active_save_created_id_idx",
      createSql:
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "candidate_actions_org_campaign_active_save_created_id_idx" ` +
        `ON "public"."candidate_actions" ("organization_id","campaign_id","created_at" DESC,"id" DESC) ` +
        `WHERE "action" = 'save' AND "reverted_at" IS NULL`,
      expectedIndexDef:
        "CREATE INDEX candidate_actions_org_campaign_active_save_created_id_idx ON public.candidate_actions USING btree (organization_id, campaign_id, created_at DESC, id DESC) WHERE ((action = 'save'::text) AND (reverted_at IS NULL))",
    },
    {
      name: "candidate_feedback_org_client_mutation_unq",
      createSql:
        `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "candidate_feedback_org_client_mutation_unq" ` +
        `ON "public"."candidate_feedback" ("organization_id","client_mutation_id")`,
      expectedIndexDef:
        "CREATE UNIQUE INDEX candidate_feedback_org_client_mutation_unq ON public.candidate_feedback USING btree (organization_id, client_mutation_id)",
    },

    {
      name: "subscriptions_org_id_unq",
      createSql:
        `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "subscriptions_org_id_unq" ` +
        `ON "public"."subscriptions" ("organization_id","id")`,
      expectedIndexDef:
        "CREATE UNIQUE INDEX subscriptions_org_id_unq ON public.subscriptions USING btree (organization_id, id)",
    },
    {
      name: "subscriptions_active_org_uidx",
      createSql:
        `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "subscriptions_active_org_uidx" ` +
        `ON "public"."subscriptions" ("organization_id") WHERE "active" = true`,
      expectedIndexDef:
        "CREATE UNIQUE INDEX subscriptions_active_org_uidx ON public.subscriptions USING btree (organization_id) WHERE (active = true)",
    },
    {
      name: "subscriptions_checkout_session_unq",
      createSql:
        `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "subscriptions_checkout_session_unq" ` +
        `ON "public"."subscriptions" ("checkout_session_id") ` +
        `WHERE "checkout_session_id" IS NOT NULL`,
      expectedIndexDef:
        "CREATE UNIQUE INDEX subscriptions_checkout_session_unq ON public.subscriptions USING btree (checkout_session_id) WHERE (checkout_session_id IS NOT NULL)",
    },
    {
      name: "ledger_org_channel_action_ts_idx",
      createSql:
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "ledger_org_channel_action_ts_idx" ` +
        `ON "public"."rate_limit_ledger" ("organization_id","channel_id","action","ts")`,
      expectedIndexDef:
        "CREATE INDEX ledger_org_channel_action_ts_idx ON public.rate_limit_ledger USING btree (organization_id, channel_id, action, ts)",
    },
    {
      name: "ledger_org_channel_profile_ts_idx",
      createSql:
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "ledger_org_channel_profile_ts_idx" ` +
        `ON "public"."rate_limit_ledger" ("organization_id","channel_id","target_profile_id","ts")`,
      expectedIndexDef:
        "CREATE INDEX ledger_org_channel_profile_ts_idx ON public.rate_limit_ledger USING btree (organization_id, channel_id, target_profile_id, ts)",
    },
  ];

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe migration identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

/**
 * CREATE INDEX CONCURRENTLY can leave a same-name index with indisvalid=false
 * or indisready=false when the process is interrupted. PostgreSQL's IF NOT
 * EXISTS considers that broken index to exist, so explicitly remove it before
 * retrying the canonical definition.
 */
export async function ensureConcurrentIndex(
  client: MigrationClient,
  definition: ConcurrentIndexDefinition,
): Promise<void> {
  const readState = async (): Promise<IndexState | undefined> => {
    const state = await client.query<IndexState>(
      `SELECT index_state.indisvalid AS "isValid",
              index_state.indisready AS "isReady",
              pg_catalog.pg_get_indexdef(index_state.indexrelid) AS "indexDef"
       FROM pg_catalog.pg_index AS index_state
       JOIN pg_catalog.pg_class AS index_class
         ON index_class.oid = index_state.indexrelid
       JOIN pg_catalog.pg_namespace AS index_namespace
         ON index_namespace.oid = index_class.relnamespace
      WHERE index_namespace.nspname = 'public'
        AND index_class.relname = $1`,
      [definition.name],
    );
    return state.rows[0];
  };
  const existing = await readState();

  if (
    existing &&
    (!existing.isValid ||
      !existing.isReady ||
      existing.indexDef !== definition.expectedIndexDef)
  ) {
    await client.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "public".${quoteIdentifier(definition.name)}`,
    );
  }

  await client.query(definition.createSql);

  const confirmed = await readState();
  if (
    !confirmed?.isValid ||
    !confirmed.isReady ||
    confirmed.indexDef !== definition.expectedIndexDef
  ) {
    throw new Error(
      `Concurrent index ${definition.name} was not created with the expected valid, ready definition`,
    );
  }
}

export async function applyConcurrentIndexes(
  client: MigrationClient,
): Promise<void> {
  for (const definition of CONCURRENT_INDEX_DEFINITIONS) {
    await ensureConcurrentIndex(client, definition);
  }
}

/**
 * A provider or historical import can predate the one-active-subscription
 * invariant. Refuse the cutover with an actionable org id instead of letting a
 * concurrent UNIQUE build fail opaquely (or, worse, guessing which paid row to
 * deactivate during an automated deploy).
 */
export async function assertNoDuplicateActiveSubscriptions(
  client: MigrationClient,
): Promise<void> {
  const duplicate = await client.query<DuplicateActiveSubscriptionState>(
    `SELECT "organization_id" AS "organizationId", count(*)::int AS "count"
       FROM "public"."subscriptions"
      WHERE "active" = true
      GROUP BY "organization_id"
     HAVING count(*) > 1
      ORDER BY "organization_id"
      LIMIT 1`,
  );
  const row = duplicate.rows[0];
  if (row) {
    throw new Error(
      `Cannot enforce one active subscription for organization ${row.organizationId}: found ${row.count}. Reconcile Stripe ownership before retrying migration.`,
    );
  }
}

/**
 * Upgrade the pre-Radar feedback table without a volatile-default rewrite.
 * Migration 0053 adds the UUID column nullable, then sets the default for new
 * writes. Existing rows are filled in small, independently committed batches;
 * a validated CHECK lets PostgreSQL make SET NOT NULL a short metadata lock.
 */
export async function prepareCandidateFeedbackMutationIds(
  client: MigrationClient,
): Promise<void> {
  await client.query(
    `ALTER TABLE "public"."candidate_feedback" ` +
      `ALTER COLUMN "client_mutation_id" SET DEFAULT gen_random_uuid()`,
  );
  const column = await client.query<ColumnState>(
    `SELECT is_nullable AS "isNullable"
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'candidate_feedback'
        AND column_name = 'client_mutation_id'`,
  );
  if (column.rows[0]?.isNullable === "NO") {
    await client.query(
      `ALTER TABLE "public"."candidate_feedback" ` +
        `DROP CONSTRAINT IF EXISTS "candidate_feedback_client_mutation_id_nn"`,
    );
    return;
  }

  for (;;) {
    const batch = await client.query(
      `WITH batch AS (
         SELECT ctid
           FROM "public"."candidate_feedback"
          WHERE "client_mutation_id" IS NULL
          LIMIT 1000
          FOR UPDATE SKIP LOCKED
       )
       UPDATE "public"."candidate_feedback" AS feedback
          SET "client_mutation_id" = gen_random_uuid()
         FROM batch
        WHERE feedback.ctid = batch.ctid`,
    );
    if ((batch.rowCount ?? 0) === 0) break;
  }

  const constraintName = "candidate_feedback_client_mutation_id_nn";
  const constraint = await client.query<ConstraintState>(
    `SELECT constraint_state.convalidated AS "isValidated"
       FROM pg_catalog.pg_constraint AS constraint_state
       JOIN pg_catalog.pg_class AS relation
         ON relation.oid = constraint_state.conrelid
       JOIN pg_catalog.pg_namespace AS relation_namespace
         ON relation_namespace.oid = relation.relnamespace
      WHERE relation_namespace.nspname = 'public'
        AND relation.relname = 'candidate_feedback'
        AND constraint_state.conname = $1`,
    [constraintName],
  );
  if (!constraint.rows[0]) {
    await client.query(
      `ALTER TABLE "public"."candidate_feedback" ` +
        `ADD CONSTRAINT "${constraintName}" ` +
        `CHECK ("client_mutation_id" IS NOT NULL) NOT VALID`,
    );
  }
  if (!constraint.rows[0]?.isValidated) {
    await client.query(
      `ALTER TABLE "public"."candidate_feedback" ` +
        `VALIDATE CONSTRAINT "${constraintName}"`,
    );
  }
  await client.query(
    `ALTER TABLE "public"."candidate_feedback" ` +
      `ALTER COLUMN "client_mutation_id" SET NOT NULL`,
  );
  await client.query(
    `ALTER TABLE "public"."candidate_feedback" ` +
      `DROP CONSTRAINT "${constraintName}"`,
  );
}

/**
 * The schema's one foreign-key cycle: a message answering an incoming comment,
 * and a comment left under one of our messages. Both halves are DEFERRABLE
 * INITIALLY IMMEDIATE — behaviour unchanged for every ordinary statement, but a
 * transaction that says `SET CONSTRAINTS ALL DEFERRED` (`copy-org.ts`) can
 * insert both sides and be checked once, at commit.
 * The installer below is the only place either half is ever created — both are
 * out of band, after the migrations — so a fresh database gets them deferrable
 * from here; `0149_deferrable_comment_cycle.sql` converges a database that
 * already carries them.
 */
const DEFERRABLE_CYCLE_CONSTRAINTS = new Set([
  "incoming_comments_org_parent_message_fk",
  "messages_org_incoming_comment_fk",
]);

/**
 * Foreign keys whose parent keys are maintained concurrently follow the index
 * phase. Existing-table checks are emitted NOT VALID by their migrations and
 * completed here. This keeps initial table locks short; validation is
 * retriable and does not block ordinary reads/writes.
 */
export async function applyPostConcurrentConstraints(
  client: MigrationClient,
): Promise<void> {
  for (const definition of [
    {
      table: "candidate_feedback",
      constraint: "candidate_feedback_org_campaign_post_fk",
    },
    {
      table: "candidate_actions",
      constraint: "candidate_actions_org_campaign_post_fk",
    },
    {
      table: "candidate_research",
      constraint: "candidate_research_org_campaign_post_fk",
    },
    {
      table: "room_snapshots",
      constraint: "room_snapshots_org_campaign_post_fk",
    },
  ] as const) {
    const result = await client.query<ConstraintState>(
      `SELECT constraint_state.convalidated AS "isValidated"
       FROM pg_catalog.pg_constraint AS constraint_state
       JOIN pg_catalog.pg_class AS relation
         ON relation.oid = constraint_state.conrelid
      JOIN pg_catalog.pg_namespace AS relation_namespace
         ON relation_namespace.oid = relation.relnamespace
      WHERE relation_namespace.nspname = 'public'
        AND relation.relname = $1
        AND constraint_state.conname = $2`,
      [definition.table, definition.constraint],
    );
    let state = result.rows[0];

    if (!state) {
      await client.query(
        `ALTER TABLE "public"."${definition.table}"
         ADD CONSTRAINT "${definition.constraint}"
         FOREIGN KEY ("organization_id","campaign_id","discovered_post_id")
         REFERENCES "public"."discovered_posts"("organization_id","campaign_id","id")
         ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID`,
      );
      state = { isValidated: false };
    }

    if (!state.isValidated) {
      await client.query(
        `ALTER TABLE "public"."${definition.table}"
         VALIDATE CONSTRAINT "${definition.constraint}"`,
      );
    }
  }

  for (const definition of [
    {
      table: "live_checks",
      constraint: "live_checks_org_message_fk",
      columns: `"organization_id","message_id"`,
      parentTable: "messages",
      parentColumns: `"organization_id","id"`,
      onDelete: "NO ACTION",
      validate: true,
    },

    {
      table: "subscription_activations",
      constraint: "subscription_activations_org_subscription_fk",
      columns: `"organization_id","subscription_id"`,
      parentTable: "subscriptions",
      parentColumns: `"organization_id","id"`,
      onDelete: "NO ACTION",
      validate: true,
    },

    {
      table: "message_draft_revisions",
      constraint: "message_draft_revisions_org_message_fk",
      columns: `"organization_id","message_id"`,
      parentTable: "messages",
      parentColumns: `"organization_id","id"`,
      onDelete: "CASCADE",
      validate: true,
    },
    {
      table: "incoming_comments",
      constraint: "incoming_comments_org_parent_message_fk",
      columns: `"organization_id","parent_message_id"`,
      parentTable: "messages",
      parentColumns: `"organization_id","id"`,
      onDelete: "NO ACTION",
      validate: true,
    },
    {
      table: "incoming_comments",
      constraint: "incoming_comments_org_campaign_post_fk",
      columns: `"organization_id","campaign_id","discovered_post_id"`,
      parentTable: "discovered_posts",
      parentColumns: `"organization_id","campaign_id","id"`,
      onDelete: "NO ACTION",
      validate: true,
    },
    {
      table: "messages",
      constraint: "messages_org_incoming_comment_fk",
      columns: `"organization_id","incoming_comment_id"`,
      parentTable: "incoming_comments",
      parentColumns: `"organization_id","id"`,
      onDelete: "NO ACTION",
      validate: false,
    },
  ] as const) {
    const result = await client.query<ConstraintState>(
      `SELECT constraint_state.convalidated AS "isValidated"
         FROM pg_catalog.pg_constraint AS constraint_state
         JOIN pg_catalog.pg_class AS relation
           ON relation.oid = constraint_state.conrelid
         JOIN pg_catalog.pg_namespace AS relation_namespace
           ON relation_namespace.oid = relation.relnamespace
        WHERE relation_namespace.nspname = 'public'
          AND relation.relname = $1
          AND constraint_state.conname = $2`,
      [definition.table, definition.constraint],
    );
    let state = result.rows[0];
    if (!state) {
      await client.query(
        `ALTER TABLE "public"."${definition.table}"
         ADD CONSTRAINT "${definition.constraint}"
         FOREIGN KEY (${definition.columns})
         REFERENCES "public"."${definition.parentTable}"(${definition.parentColumns})
         ON DELETE ${definition.onDelete} ON UPDATE NO ACTION ${
           DEFERRABLE_CYCLE_CONSTRAINTS.has(definition.constraint)
             ? "DEFERRABLE INITIALLY IMMEDIATE "
             : ""
         }NOT VALID`,
      );
      state = { isValidated: false };
    }
    if (!state.isValidated && definition.validate) {
      await client.query(
        `ALTER TABLE "public"."${definition.table}"
         VALIDATE CONSTRAINT "${definition.constraint}"`,
      );
    }
  }

  for (const definition of [

    {
      table: "feedback",
      constraint: "feedback_final_text_hash_check",
      expression: `"final_text_hash" IS NULL OR "final_text_hash" ~ '^[0-9a-f]{64}$'`,
    },
    {
      table: "organizations",
      constraint: "organizations_onboarding_radar_level_check",
      expression: `"onboarding_radar_level" IS NULL OR "onboarding_radar_level" IN ('curate', 'review')`,
    },
    {
      table: "organizations",
      constraint: "organizations_onboarding_execution_mode_check",
      expression:
        `("onboarding_execution_mode" IS NULL AND "onboarding_first_run_choice" IS NULL AND "onboarding_host_approval_state" IS NULL) OR ` +
        `("onboarding_execution_mode" = 'manual' AND "onboarding_first_run_choice" = 'manual' AND "onboarding_host_approval_state" IS NULL) OR ` +
        `("onboarding_execution_mode" = 'scheduled' AND ("onboarding_first_run_choice" IS NULL OR "onboarding_first_run_choice" IN ('run_now', 'next_schedule')) AND ("onboarding_host_approval_state" IS NULL OR "onboarding_host_approval_state" IN ('pending', 'enabled', 'declined', 'unsupported')))`,
    },
    {
      table: "voices",
      constraint: "voices_revision_check",
      expression: `"revision" >= 0 AND "calibration_sample_count" >= 0`,
    },
    {
      table: "voices",
      constraint: "voices_maturity_check",
      expression: `"maturity" IN ('provisional', 'calibrating', 'calibrated', 'failed')`,
    },
  ] as const) {
    const result = await client.query<ConstraintState>(
      `SELECT constraint_state.convalidated AS "isValidated"
         FROM pg_catalog.pg_constraint AS constraint_state
         JOIN pg_catalog.pg_class AS relation
           ON relation.oid = constraint_state.conrelid
         JOIN pg_catalog.pg_namespace AS relation_namespace
           ON relation_namespace.oid = relation.relnamespace
        WHERE relation_namespace.nspname = 'public'
          AND relation.relname = $1
          AND constraint_state.conname = $2`,
      [definition.table, definition.constraint],
    );
    let state = result.rows[0];
    if (!state) {
      await client.query(
        `ALTER TABLE "public"."${definition.table}"
         ADD CONSTRAINT "${definition.constraint}"
         CHECK (${definition.expression}) NOT VALID`,
      );
      state = { isValidated: false };
    }
    if (!state.isValidated) {
      await client.query(
        `ALTER TABLE "public"."${definition.table}"
         VALIDATE CONSTRAINT "${definition.constraint}"`,
      );
    }
  }
}

/**
 * Session advisory locking serializes multiple deploy processes without placing
 * CREATE/DROP INDEX CONCURRENTLY inside a forbidden transaction block.
 */
export async function applyConcurrentMigrationMaintenance(
  client: PoolClient,
): Promise<void> {
  await client.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [
    INDEX_MAINTENANCE_LOCK,
  ]);
  try {
    await assertNoDuplicateActiveSubscriptions(client);
    await applyConcurrentIndexes(client);
    await applyPostConcurrentConstraints(client);
  } finally {
    await client.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [
      INDEX_MAINTENANCE_LOCK,
    ]);
  }
}

export const concurrentFinalisationInputs = [
  CONCURRENT_INDEX_DEFINITIONS, [...DEFERRABLE_CYCLE_CONSTRAINTS],
  quoteIdentifier.toString(), ensureConcurrentIndex.toString(),
  applyConcurrentIndexes.toString(), assertNoDuplicateActiveSubscriptions.toString(),
  prepareCandidateFeedbackMutationIds.toString(), applyPostConcurrentConstraints.toString(),
  applyConcurrentMigrationMaintenance.toString(),
];
