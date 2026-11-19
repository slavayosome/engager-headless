ALTER TABLE "campaigns" ADD COLUMN "channel_id" bigint;--> statement-breakpoint
ALTER TABLE "rate_limit_ledger" ADD COLUMN "channel_id" bigint;--> statement-breakpoint
-- The same-org composite FK, against `channels_org_id_key`. Validated inline
-- rather than deferred to applyPostConcurrentConstraints: the column is
-- entirely NULL at this instant and MATCH SIMPLE skips any row with a NULL
-- member, so the scan passes trivially, and `campaigns` holds roughly one row
-- per org. It is added BEFORE the backfill below on purpose — that way the rows
-- the backfill writes are checked by the constraint as they are written,
-- instead of trusting the join that produced them.
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_org_channel_fk" FOREIGN KEY ("organization_id","channel_id") REFERENCES "public"."channels"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- The two channel-scoped ledger indexes this migration would otherwise create
-- are built CONCURRENTLY by migrate.ts (CONCURRENT_INDEX_DEFINITIONS). An
-- existing-table index built inside drizzle's wrapping transaction holds an
-- exclusive lock on the ledger for the whole build; the out-of-transaction path
-- owns it instead. Same reason, same treatment as 0055.
--
-- `campaigns`, `rate_limit_ledger` and `channels` are all FORCE ROW LEVEL
-- SECURITY with an `app.current_org` policy, so a role without BYPASSRLS
-- backfills ZERO rows IN SILENCE — indistinguishable from "there was nothing to
-- attribute". migrate.ts documents this path as the DB owner/superuser and
-- refuses to run as the app role; 0120 makes the same assumption explicit for
-- the same reason, and this block is its twin.
DO $channel_backfill_guard$
BEGIN
  IF current_setting('is_superuser') <> 'on'
     AND NOT EXISTS (
       SELECT 1
       FROM pg_roles r
       WHERE (r.rolsuper OR r.rolbypassrls)
         AND pg_has_role(current_user, r.oid, 'USAGE')
     )
  THEN
    RAISE EXCEPTION
      'this migration must run as the migration owner: role % cannot bypass row level security and would silently attribute zero rows to their channel',
      current_user;
  END IF;
END
$channel_backfill_guard$;--> statement-breakpoint
-- Attribution, stated once and permanently: existing rows are attributed to
-- channel one BY CONSTRUCTION, NOT BY EVIDENCE. Every row below this line was
-- written while exactly one connected account existed, so the attribution is
-- correct today and permanently unverifiable later — the rows carry no account
-- marker to audit against, so there is nothing to re-derive this backfill from.
-- The same construction covers rows written between this migration and the task
-- that makes the ledger's writers stamp the column, which is why the predicate
-- is `channel_id IS NULL` and the statement is re-runnable. `channels` holds
-- exactly one row per org (0122's per-org seed, plus bootstrapLocalOrg's mint,
-- which is idempotent on (org, network) EXISTENCE), so the org join names one
-- id, not a choice.
UPDATE "campaigns"
   SET "channel_id" = "channels"."id"
  FROM "channels"
 WHERE "channels"."organization_id" = "campaigns"."organization_id"
   AND "campaigns"."channel_id" IS NULL;--> statement-breakpoint
UPDATE "rate_limit_ledger"
   SET "channel_id" = "channels"."id"
  FROM "channels"
 WHERE "channels"."organization_id" = "rate_limit_ledger"."organization_id"
   AND "rate_limit_ledger"."channel_id" IS NULL;
