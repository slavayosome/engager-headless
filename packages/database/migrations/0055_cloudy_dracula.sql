CREATE TABLE "onboarding_radar_previews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"campaign_id" bigint NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"candidate_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"proof_candidate_id" bigint,
	"setup_proof_work_order_id" uuid,
	"discovered_count" integer DEFAULT 0 NOT NULL,
	"evaluated_count" integer DEFAULT 0 NOT NULL,
	"matched_count" integer DEFAULT 0 NOT NULL,
	"rejected_count" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_detail" text,
	"started_at" bigint,
	"first_rendered_at" bigint,
	"completed_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "onboarding_radar_previews_counts_check" CHECK ("onboarding_radar_previews"."discovered_count" >= 0 and "onboarding_radar_previews"."evaluated_count" >= 0 and "onboarding_radar_previews"."matched_count" >= 0 and "onboarding_radar_previews"."rejected_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "subscription_activations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"subscription_id" text NOT NULL,
	"source" text NOT NULL,
	"runner_work_event_id" bigint,
	"approved_by_user_id" uuid,
	"created_at" bigint NOT NULL,
	CONSTRAINT "subscription_activations_source_check" CHECK (("subscription_activations"."source" = 'setup_proof' and "subscription_activations"."runner_work_event_id" is not null and "subscription_activations"."approved_by_user_id" is null) or ("subscription_activations"."source" = 'interactive' and "subscription_activations"."runner_work_event_id" is null and "subscription_activations"."approved_by_user_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "onboarding_radar_previews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "onboarding_radar_previews" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "onboarding_radar_previews"
	USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "subscription_activations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "subscription_activations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_read ON "subscription_activations" FOR SELECT
	USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_append ON "subscription_activations" FOR INSERT
	WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "cancel_at" bigint;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "cancel_at_period_end" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "checkout_session_id" text;--> statement-breakpoint
ALTER TABLE "onboarding_radar_previews" ADD CONSTRAINT "onboarding_radar_previews_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_radar_previews" ADD CONSTRAINT "onboarding_radar_previews_org_campaign_fk" FOREIGN KEY ("organization_id","campaign_id") REFERENCES "public"."campaigns"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_radar_previews" ADD CONSTRAINT "onboarding_radar_previews_org_setup_proof_order_fk" FOREIGN KEY ("organization_id","setup_proof_work_order_id") REFERENCES "public"."runner_work_orders"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- The preview proof-Candidate FK is installed after the concurrent
-- discovered_posts tenant key so fresh databases and live upgrades share the
-- same safe ordering.
ALTER TABLE "subscription_activations" ADD CONSTRAINT "subscription_activations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- The subscription and runner-event tenant keys plus these two dependent FKs
-- are installed by migrate.ts after a preflight and concurrent index build.
-- This keeps existing billing and receipt tables writable during deployment.
ALTER TABLE "subscription_activations" ADD CONSTRAINT "subscription_activations_approved_by_user_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "onboarding_radar_previews_org_created_idx" ON "onboarding_radar_previews" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_radar_previews_org_open_unq" ON "onboarding_radar_previews" USING btree ("organization_id") WHERE "onboarding_radar_previews"."status" in ('requested','discovering','ranking');--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_activations_subscription_unq" ON "subscription_activations" USING btree ("subscription_id");--> statement-breakpoint
CREATE INDEX "subscription_activations_org_created_idx" ON "subscription_activations" USING btree ("organization_id","created_at");--> statement-breakpoint
-- Existing-table unique indexes are built CONCURRENTLY by migrate.ts. The
-- active-subscription key is preceded by an explicit duplicate preflight.
