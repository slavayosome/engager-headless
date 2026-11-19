CREATE TABLE "compiled_writing_rules" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"campaign_id" bigint NOT NULL,
	"channel" text NOT NULL,
	"revision" text NOT NULL,
	"rules" jsonb NOT NULL,
	"conflicts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"compiled_at" bigint NOT NULL,
	CONSTRAINT "compiled_writing_rules_channel_check" CHECK ("compiled_writing_rules"."channel" in ('comment', 'reply', 'dm'))
);
--> statement-breakpoint
CREATE TABLE "draft_attempts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"plan_id" bigint NOT NULL,
	"attempt" integer NOT NULL,
	"text" text NOT NULL,
	"verdicts" jsonb NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"created_at" bigint NOT NULL,
	CONSTRAINT "draft_attempts_values_check" CHECK ("draft_attempts"."attempt" between 1 and 2
    and "draft_attempts"."outcome" in ('admitted', 'rewrite', 'withheld')
    and ("draft_attempts"."outcome" = 'admitted') = ("draft_attempts"."reason" is null))
);
--> statement-breakpoint
CREATE TABLE "draft_plans" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"campaign_id" bigint NOT NULL,
	"run_id" bigint,
	"surface" text NOT NULL,
	"discovered_post_id" bigint,
	"rules_revision" text NOT NULL,
	"engine" integer NOT NULL,
	"plan" jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "draft_plans_values_check" CHECK ("draft_plans"."engine" >= 1
    and "draft_plans"."surface" in ('comment', 'reply', 'room_reply', 'invitation', 'dm', 'followup', 'angle'))
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "draft_plan_id" bigint;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "draft_dispatcher" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- The composite FK from draft_attempts needs this unique index to exist first.
CREATE UNIQUE INDEX "draft_plans_org_id_unq" ON "draft_plans" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "compiled_writing_rules" ADD CONSTRAINT "compiled_writing_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compiled_writing_rules" ADD CONSTRAINT "compiled_writing_rules_org_campaign_fk" FOREIGN KEY ("organization_id","campaign_id") REFERENCES "public"."campaigns"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_attempts" ADD CONSTRAINT "draft_attempts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_attempts" ADD CONSTRAINT "draft_attempts_org_plan_fk" FOREIGN KEY ("organization_id","plan_id") REFERENCES "public"."draft_plans"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_plans" ADD CONSTRAINT "draft_plans_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_plans" ADD CONSTRAINT "draft_plans_org_campaign_fk" FOREIGN KEY ("organization_id","campaign_id") REFERENCES "public"."campaigns"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "compiled_writing_rules_org_campaign_channel_revision_unq" ON "compiled_writing_rules" USING btree ("organization_id","campaign_id","channel","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "draft_attempts_org_plan_attempt_unq" ON "draft_attempts" USING btree ("organization_id","plan_id","attempt");--> statement-breakpoint
CREATE INDEX "draft_plans_org_run_idx" ON "draft_plans" USING btree ("organization_id","run_id");
--> statement-breakpoint
-- Generated tenant policies from packages/database/rls.ts
ALTER TABLE "compiled_writing_rules" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "compiled_writing_rules" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "compiled_writing_rules";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_read ON "compiled_writing_rules";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_append ON "compiled_writing_rules";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_update ON "compiled_writing_rules";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_retention_delete ON "compiled_writing_rules";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "compiled_writing_rules" USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "draft_attempts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "draft_attempts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "draft_attempts";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_read ON "draft_attempts";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_append ON "draft_attempts";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_update ON "draft_attempts";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_retention_delete ON "draft_attempts";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "draft_attempts" USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "draft_plans" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "draft_plans" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "draft_plans";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_read ON "draft_plans";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_append ON "draft_plans";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_update ON "draft_plans";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_retention_delete ON "draft_plans";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "draft_plans" USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
