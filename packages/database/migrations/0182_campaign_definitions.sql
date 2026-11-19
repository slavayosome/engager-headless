CREATE TABLE "campaign_definitions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"campaign_id" bigint,
	"channel_id" bigint,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"base_version" integer,
	"document" jsonb NOT NULL,
	"patch_provenance" jsonb NOT NULL,
	"effective_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "campaign_definitions_scope_version_key" UNIQUE NULLS NOT DISTINCT("organization_id","campaign_id","channel_id","version"),
	CONSTRAINT "campaign_definitions_scope_check" CHECK (("campaign_definitions"."campaign_id" is null) = ("campaign_definitions"."channel_id" is not null)),
	CONSTRAINT "campaign_definitions_version_check" CHECK ("campaign_definitions"."version" >= 1 and ("campaign_definitions"."base_version" is null or ("campaign_definitions"."base_version" >= 1 and "campaign_definitions"."base_version" < "campaign_definitions"."version"))),
	CONSTRAINT "campaign_definitions_status_check" CHECK ("campaign_definitions"."status" in ('draft', 'active', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "agentic_workflow" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_definitions" ADD CONSTRAINT "campaign_definitions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_definitions" ADD CONSTRAINT "campaign_definitions_org_campaign_fk" FOREIGN KEY ("organization_id","campaign_id") REFERENCES "public"."campaigns"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_definitions" ADD CONSTRAINT "campaign_definitions_org_channel_fk" FOREIGN KEY ("organization_id","channel_id") REFERENCES "public"."channels"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_definitions_active_campaign_unq" ON "campaign_definitions" USING btree ("organization_id","campaign_id") WHERE "campaign_definitions"."status" = 'active' and "campaign_definitions"."campaign_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_definitions_active_channel_unq" ON "campaign_definitions" USING btree ("organization_id","channel_id") WHERE "campaign_definitions"."status" = 'active' and "campaign_definitions"."channel_id" is not null;--> statement-breakpoint
ALTER TABLE "campaign_definitions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "campaign_definitions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "campaign_definitions"
	USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
