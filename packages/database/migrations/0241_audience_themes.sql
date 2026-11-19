CREATE TABLE "audience_themes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"campaign_id" bigint NOT NULL,
	"audience_revision" integer NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"phrases" text[] DEFAULT '{}'::text[] NOT NULL,
	"pain_id" text,
	"rooms" integer NOT NULL,
	"comments" integer NOT NULL,
	"source_refs" jsonb NOT NULL,
	"status" text NOT NULL,
	"kept_at" bigint,
	"kept_knowledge_id" integer,
	"first_seen_at" bigint NOT NULL,
	"last_seen_at" bigint NOT NULL,
	"rolled_up_at" bigint NOT NULL,
	CONSTRAINT "audience_themes_bounds" CHECK (length("audience_themes"."text") between 1 and 120 and cardinality("audience_themes"."phrases") <= 3
    and "audience_themes"."rooms" >= 0 and "audience_themes"."comments" >= 0 and "audience_themes"."audience_revision" >= 0),
	CONSTRAINT "audience_themes_kind" CHECK ("audience_themes"."kind" in ('pain', 'objection', 'open_question')),
	CONSTRAINT "audience_themes_status" CHECK ("audience_themes"."status" in ('current', 'past'))
);
--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "audience_themes_rolled_up_at" bigint;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "audience_themes_input_hash" text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "audience_themes_result_hash" text;--> statement-breakpoint
ALTER TABLE "audience_themes" ADD CONSTRAINT "audience_themes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audience_themes" ADD CONSTRAINT "audience_themes_org_campaign_fk" FOREIGN KEY ("organization_id","campaign_id") REFERENCES "public"."campaigns"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audience_themes_org_campaign_status_idx" ON "audience_themes" USING btree ("organization_id","campaign_id","status");
--> statement-breakpoint
-- Generated tenant policies from packages/database/rls.ts
ALTER TABLE "audience_themes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "audience_themes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "audience_themes";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_read ON "audience_themes";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_append ON "audience_themes";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_update ON "audience_themes";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_retention_delete ON "audience_themes";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "audience_themes" USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
