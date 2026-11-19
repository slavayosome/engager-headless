CREATE TABLE "workers" (
	"id" bigint PRIMARY KEY DEFAULT nextval('automations_id_seq') NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"campaign_id" bigint,
	"channel_id" bigint,
	"name" text NOT NULL,
	"kind" text DEFAULT 'comment' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"agent_id" text,
	"model" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sweep_enabled" boolean DEFAULT true NOT NULL,
	"draft_enabled" boolean DEFAULT false NOT NULL,
	"publish_enabled" boolean DEFAULT false NOT NULL,
	"last_run_at" bigint,
	"next_run_at" bigint,
	"paused_reason" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "workers_org_name_key" UNIQUE("organization_id","name"),
	CONSTRAINT "workers_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "workers_stage_ladder_check" CHECK (not "workers"."publish_enabled" or "workers"."draft_enabled"),
	CONSTRAINT "workers_enabled_does_something_check" CHECK (not "workers"."enabled" or "workers"."sweep_enabled" or "workers"."draft_enabled" or "workers"."publish_enabled")
);
--> statement-breakpoint
ALTER TABLE "workers" ADD CONSTRAINT "workers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workers" ADD CONSTRAINT "workers_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workers" ADD CONSTRAINT "workers_org_channel_fk" FOREIGN KEY ("organization_id","channel_id") REFERENCES "public"."channels"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workers_org_campaign_idx" ON "workers" USING btree ("organization_id","campaign_id");--> statement-breakpoint
CREATE INDEX "workers_org_channel_idx" ON "workers" USING btree ("organization_id","channel_id");--> statement-breakpoint
CREATE INDEX "workers_org_next_run_idx" ON "workers" USING btree ("organization_id","next_run_at");--> statement-breakpoint
-- `workers` is a tenant table: enable + FORCE RLS and install its isolation
-- policy INSIDE the transaction that creates it, so the table is never readable
-- across orgs for even one statement. `applyRls` re-applies this idempotently on
-- every migrate; this block is what makes the pre-commit firebreak true.
ALTER TABLE "workers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "workers"
	USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
-- Both `automations` and `workers` are FORCE ROW LEVEL SECURITY, so a role
-- without BYPASSRLS copies ZERO rows IN SILENCE — indistinguishable from "there
-- was nothing to copy", and the silence would only surface later as an org whose
-- worker page is empty. migrate.ts documents this path as the DB owner and
-- refuses to run as the app role; 0125's and 0130's guards are this one's twins.
DO $worker_backfill_guard$
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
      'this migration must run as the migration owner: role % cannot bypass row level security and would silently copy zero automations into workers',
      current_user;
  END IF;
END
$worker_backfill_guard$;--> statement-breakpoint
-- THE IDS ARE COPIED, not minted. `automation_runs.automation_id` is the run
-- log's pointer and it is not being rewritten — the physical column keeps its
-- name forever — so the only way the log stays true across both tables is for
-- one integer to name the same worker in both. No sequence advance follows,
-- because there is nothing to advance: `workers.id` defaults from
-- `automations_id_seq` itself, so the two tables share ONE id space and a
-- worker minted without a source can never collide with a copied id.
--
-- `channel_id` comes through `campaigns.channelId` — where channel scope has
-- ridden since Phase 4 — by evidence, not by construction: it is the very
-- column the target already carries, re-derivable at any time.
--
-- Idempotent by the NOT EXISTS: a re-run copies nothing.
INSERT INTO "workers" (
  "id", "organization_id", "campaign_id", "channel_id", "name", "kind",
  "enabled", "sweep_enabled", "draft_enabled", "publish_enabled",
  "last_run_at", "next_run_at", "paused_reason", "created_at", "updated_at"
)
SELECT a."id", a."organization_id", a."campaign_id", c."channel_id", a."name",
       a."kind", a."enabled", a."sweep_enabled", a."draft_enabled",
       a."publish_enabled", a."last_run_at", a."next_run_at", a."paused_reason",
       a."created_at", a."updated_at"
  FROM "automations" a
  LEFT JOIN "campaigns" c ON c."id" = a."campaign_id"
 WHERE NOT EXISTS (SELECT 1 FROM "workers" w WHERE w."id" = a."id");
