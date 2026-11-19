-- THE SCOUT LEARNS WHICH SEARCHES LAND. Three new tables, each with its RLS
-- family installed in this same file — `discovered_post_sources` (which source
-- surfaced each post, the attribution a source's yield is counted from),
-- `discovery_plans` (one row per plan the Scout made, with its note or why it
-- failed) and `discovery_source_changes` (every change to a campaign's
-- searches and every refusal, with whose it was) — and four nullable or
-- defaulted columns on `discovery_sources`: `pinned`, `rationale`,
-- `retired_at`, `retired_by`. Expand-only: no existing column, constraint or
-- row moves, and every existing source reads unpinned with no rationale.
CREATE TABLE "discovered_post_sources" (
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"campaign_id" bigint NOT NULL,
	"discovered_post_id" bigint NOT NULL,
	"source_key" text NOT NULL,
	"first_seen_at" bigint NOT NULL,
	CONSTRAINT "discovered_post_sources_organization_id_discovered_post_id_source_key_pk" PRIMARY KEY("organization_id","discovered_post_id","source_key")
);
--> statement-breakpoint
CREATE TABLE "discovery_plans" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"campaign_id" bigint NOT NULL,
	"run_id" bigint,
	"status" text NOT NULL,
	"working" text,
	"error" text,
	"created_at" bigint NOT NULL,
	CONSTRAINT "discovery_plans_status_check" CHECK (("discovery_plans"."status" = 'applied' and "discovery_plans"."error" is null) or ("discovery_plans"."status" = 'failed' and "discovery_plans"."error" is not null))
);
--> statement-breakpoint
CREATE TABLE "discovery_source_changes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"campaign_id" bigint NOT NULL,
	"plan_id" bigint,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"source_key" text,
	"source_type" text,
	"term" text NOT NULL,
	"rationale" text,
	"refusal" text,
	"created_at" bigint NOT NULL,
	CONSTRAINT "discovery_source_changes_refusal_check" CHECK (("discovery_source_changes"."action" = 'refused') = ("discovery_source_changes"."refusal" is not null) and ("discovery_source_changes"."action" = 'refused' or "discovery_source_changes"."source_key" is not null))
);
--> statement-breakpoint
ALTER TABLE "discovery_sources" ADD COLUMN "pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "discovery_sources" ADD COLUMN "rationale" text;--> statement-breakpoint
ALTER TABLE "discovery_sources" ADD COLUMN "retired_at" bigint;--> statement-breakpoint
ALTER TABLE "discovery_sources" ADD COLUMN "retired_by" text;--> statement-breakpoint
ALTER TABLE "discovered_post_sources" ADD CONSTRAINT "discovered_post_sources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- discovered_post_sources_org_campaign_post_fk is installed by migrate.ts after
-- the concurrent discovered_posts tenant key exists, matching
-- candidate_research: that parent key is built CONCURRENTLY, so it does not
-- exist yet inside this transaction.--> statement-breakpoint
ALTER TABLE "discovery_plans" ADD CONSTRAINT "discovery_plans_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_plans" ADD CONSTRAINT "discovery_plans_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_source_changes" ADD CONSTRAINT "discovery_source_changes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_source_changes" ADD CONSTRAINT "discovery_source_changes_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "discovered_post_sources_source_idx" ON "discovered_post_sources" USING btree ("organization_id","campaign_id","source_key");--> statement-breakpoint
CREATE INDEX "discovery_plans_campaign_idx" ON "discovery_plans" USING btree ("organization_id","campaign_id","created_at");--> statement-breakpoint
CREATE INDEX "discovery_source_changes_campaign_idx" ON "discovery_source_changes" USING btree ("organization_id","campaign_id","created_at");--> statement-breakpoint
ALTER TABLE "discovered_post_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "discovered_post_sources" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "discovered_post_sources"
	USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "discovery_plans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "discovery_plans" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "discovery_plans"
	USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "discovery_source_changes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "discovery_source_changes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "discovery_source_changes"
	USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);