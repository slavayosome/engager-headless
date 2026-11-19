CREATE TABLE "composer_drafts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"box_key" text NOT NULL,
	"campaign_id" bigint,
	"position" integer NOT NULL,
	"angle" text NOT NULL,
	"angle_why" text,
	"move" text,
	"text" text,
	"state" text DEFAULT 'ready' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"offered" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requested_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "composer_drafts_values_check" CHECK ("composer_drafts"."position" >= 1 and "composer_drafts"."revision" >= 1
    and char_length("composer_drafts"."angle") between 1 and 24 and ("composer_drafts"."angle_why" is null or char_length("composer_drafts"."angle_why") <= 160)
    and "composer_drafts"."box_key" ~ '^(comment|reply|room|invite|dm):.+'),
	CONSTRAINT "composer_drafts_state_check" CHECK (("composer_drafts"."state" = 'ready' and "composer_drafts"."text" is not null)
    or ("composer_drafts"."state" = 'writing' and "composer_drafts"."text" is null) or "composer_drafts"."state" = 'failed')
);
--> statement-breakpoint
ALTER TABLE "composer_drafts" ADD CONSTRAINT "composer_drafts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "composer_drafts" ADD CONSTRAINT "composer_drafts_org_campaign_fk" FOREIGN KEY ("organization_id","campaign_id") REFERENCES "public"."campaigns"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "composer_drafts_org_box_position_unq" ON "composer_drafts" USING btree ("organization_id","box_key","position");
--> statement-breakpoint
-- Generated tenant policies from packages/database/rls.ts
ALTER TABLE "composer_drafts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "composer_drafts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "composer_drafts";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_read ON "composer_drafts";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_append ON "composer_drafts";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_update ON "composer_drafts";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_retention_delete ON "composer_drafts";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "composer_drafts" USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
