CREATE TABLE "listening_map_plans" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"campaign_id" bigint NOT NULL,
	"run_id" bigint,
	"note" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listening_phrase_changes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"campaign_id" bigint NOT NULL,
	"phrase_id" bigint,
	"run_id" bigint,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"term" text NOT NULL,
	"rationale" text,
	"refusal" text,
	"created_at" bigint NOT NULL,
	CONSTRAINT "listening_phrase_changes_values_check" CHECK ("listening_phrase_changes"."actor" in ('scout', 'owner')
        and "listening_phrase_changes"."action" in ('add', 'retire', 'restore', 'pin', 'unpin', 'edit', 'refused')
        and ("listening_phrase_changes"."action" = 'refused') = ("listening_phrase_changes"."refusal" is not null))
);
--> statement-breakpoint
ALTER TABLE "listening_phrases" ADD COLUMN "empty_reads" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "listening_map_plans" ADD CONSTRAINT "listening_map_plans_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listening_map_plans" ADD CONSTRAINT "listening_map_plans_org_campaign_fk" FOREIGN KEY ("organization_id","campaign_id") REFERENCES "public"."campaigns"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listening_phrase_changes" ADD CONSTRAINT "listening_phrase_changes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listening_phrase_changes" ADD CONSTRAINT "listening_phrase_changes_org_campaign_fk" FOREIGN KEY ("organization_id","campaign_id") REFERENCES "public"."campaigns"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- A composite FK would null the required organization column too; only the phrase goes (PostgreSQL 15).
ALTER TABLE "listening_phrase_changes" ADD CONSTRAINT "listening_phrase_changes_org_phrase_fk" FOREIGN KEY ("organization_id","phrase_id") REFERENCES "public"."listening_phrases"("organization_id","id") ON DELETE set null ("phrase_id") ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "listening_map_plans_campaign_idx" ON "listening_map_plans" USING btree ("organization_id","campaign_id","created_at");--> statement-breakpoint
CREATE INDEX "listening_phrase_changes_campaign_idx" ON "listening_phrase_changes" USING btree ("organization_id","campaign_id","created_at");--> statement-breakpoint
CREATE INDEX "listening_phrase_changes_run_idx" ON "listening_phrase_changes" USING btree ("organization_id","run_id");--> statement-breakpoint
ALTER TABLE "listening_phrases" ADD CONSTRAINT "listening_phrases_empty_reads_check" CHECK ("listening_phrases"."empty_reads" >= 0);
--> statement-breakpoint
-- Generated tenant policies from packages/database/rls.ts
ALTER TABLE "listening_map_plans" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "listening_map_plans" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "listening_map_plans";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_read ON "listening_map_plans";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_append ON "listening_map_plans";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_update ON "listening_map_plans";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_retention_delete ON "listening_map_plans";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "listening_map_plans" USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "listening_phrase_changes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "listening_phrase_changes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "listening_phrase_changes";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_read ON "listening_phrase_changes";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_append ON "listening_phrase_changes";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_update ON "listening_phrase_changes";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_retention_delete ON "listening_phrase_changes";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "listening_phrase_changes" USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
