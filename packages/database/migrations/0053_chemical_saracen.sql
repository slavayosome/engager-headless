CREATE TABLE "candidate_actions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"client_mutation_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" bigint NOT NULL,
	"discovered_post_id" bigint NOT NULL,
	"action" text NOT NULL,
	"actor" text NOT NULL,
	"prior_status" text NOT NULL,
	"prior_filter_reason" text,
	"prior_selected_at" bigint,
	"expected_status" text NOT NULL,
	"expected_filter_reason" text,
	"expected_selected_at" bigint,
	"created_at" bigint NOT NULL,
	"reverted_at" bigint,
	"reverted_by" text
);
--> statement-breakpoint
CREATE TABLE "candidate_mutation_receipts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"client_mutation_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"campaign_id" bigint NOT NULL,
	"discovered_post_id" bigint NOT NULL,
	"request_fingerprint" text NOT NULL,
	"mutation_source" text NOT NULL,
	"mutation_id" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "candidate_mutation_receipts_source_check" CHECK (("candidate_mutation_receipts"."operation" = 'feedback' AND "candidate_mutation_receipts"."mutation_source" = 'feedback') OR ("candidate_mutation_receipts"."operation" <> 'feedback' AND "candidate_mutation_receipts"."mutation_source" = 'action'))
);
--> statement-breakpoint
CREATE TABLE "radar_daily_opportunities" (
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"campaign_id" bigint NOT NULL,
	"local_day" text NOT NULL,
	"discovered_post_id" bigint NOT NULL,
	"rank" integer NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "radar_daily_opportunities_rank_check" CHECK ("radar_daily_opportunities"."rank" between 1 and 10),
	CONSTRAINT "radar_daily_opportunities_local_day_check" CHECK ("radar_daily_opportunities"."local_day" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
);
--> statement-breakpoint
-- Online cutover: do not add a volatile UUID default and NOT NULL together,
-- which rewrites the existing feedback table under ACCESS EXCLUSIVE lock.
-- migrate.ts backfills in bounded batches, validates NOT NULL, and builds the
-- tenant idempotency index concurrently after this transaction commits.
ALTER TABLE "candidate_feedback" ADD COLUMN "client_mutation_id" uuid;--> statement-breakpoint
ALTER TABLE "candidate_feedback" ALTER COLUMN "client_mutation_id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "candidate_feedback" ADD COLUMN "prior_status" text;--> statement-breakpoint
ALTER TABLE "candidate_feedback" ADD COLUMN "prior_filter_reason" text;--> statement-breakpoint
ALTER TABLE "candidate_feedback" ADD COLUMN "prior_selected_at" bigint;--> statement-breakpoint
ALTER TABLE "candidate_feedback" ADD COLUMN "expected_status" text;--> statement-breakpoint
ALTER TABLE "candidate_feedback" ADD COLUMN "expected_filter_reason" text;--> statement-breakpoint
ALTER TABLE "candidate_feedback" ADD COLUMN "expected_selected_at" bigint;--> statement-breakpoint
ALTER TABLE "candidate_feedback" ADD COLUMN "reverted_by" text;--> statement-breakpoint
ALTER TABLE "candidate_actions" ADD CONSTRAINT "candidate_actions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- candidate_actions_org_campaign_post_fk is installed by migrate.ts after the
-- concurrent discovered_posts tenant key exists, matching candidate_feedback.
ALTER TABLE "candidate_mutation_receipts" ADD CONSTRAINT "candidate_mutation_receipts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- candidate_mutation_receipts_org_campaign_post_fk is installed by migrate.ts
-- after the concurrent discovered_posts tenant key exists.
ALTER TABLE "radar_daily_opportunities" ADD CONSTRAINT "radar_daily_opportunities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- radar_daily_opportunities_org_campaign_post_fk is installed by migrate.ts
-- after the concurrent discovered_posts tenant key exists.
CREATE INDEX "candidate_actions_org_campaign_created_idx" ON "candidate_actions" USING btree ("organization_id","campaign_id","created_at");--> statement-breakpoint
CREATE INDEX "candidate_actions_org_post_created_idx" ON "candidate_actions" USING btree ("organization_id","discovered_post_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_actions_org_campaign_post_action_active_unq" ON "candidate_actions" USING btree ("organization_id","campaign_id","discovered_post_id","action") WHERE "candidate_actions"."reverted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_actions_org_client_mutation_unq" ON "candidate_actions" USING btree ("organization_id","client_mutation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_mutation_receipts_org_client_mutation_unq" ON "candidate_mutation_receipts" USING btree ("organization_id","client_mutation_id");--> statement-breakpoint
CREATE INDEX "candidate_mutation_receipts_org_canonical_idx" ON "candidate_mutation_receipts" USING btree ("organization_id","mutation_source","mutation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "radar_daily_opportunities_org_campaign_day_post_unq" ON "radar_daily_opportunities" USING btree ("organization_id","campaign_id","local_day","discovered_post_id");--> statement-breakpoint
CREATE UNIQUE INDEX "radar_daily_opportunities_org_campaign_day_rank_unq" ON "radar_daily_opportunities" USING btree ("organization_id","campaign_id","local_day","rank");--> statement-breakpoint
-- candidate_feedback_org_client_mutation_unq is built CONCURRENTLY by
-- migrate.ts after batched UUID backfill and the short validated NOT NULL cutover.
