CREATE TABLE "lead_source_reads" (
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"campaign_id" bigint NOT NULL,
	"run_id" bigint NOT NULL,
	"phrase_id" bigint NOT NULL,
	"read_at" bigint NOT NULL,
	CONSTRAINT "lead_source_reads_organization_id_campaign_id_run_id_phrase_id_pk" PRIMARY KEY("organization_id","campaign_id","run_id","phrase_id")
);
--> statement-breakpoint
ALTER TABLE "lead_signals" ADD COLUMN "expired_at" bigint;--> statement-breakpoint
ALTER TABLE "lead_thread_reads" ADD COLUMN "run_id" bigint;--> statement-breakpoint
ALTER TABLE "lead_thread_reads" ADD COLUMN "author_company_ref" text;--> statement-breakpoint
ALTER TABLE "lead_thread_reads" ADD COLUMN "author_company_name" text;--> statement-breakpoint
ALTER TABLE "lead_source_reads" ADD CONSTRAINT "lead_source_reads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_source_reads" ADD CONSTRAINT "lead_source_reads_org_campaign_fk" FOREIGN KEY ("organization_id","campaign_id") REFERENCES "public"."campaigns"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_source_reads" ADD CONSTRAINT "lead_source_reads_org_phrase_fk" FOREIGN KEY ("organization_id","phrase_id") REFERENCES "public"."listening_phrases"("organization_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Generated tenant policies from packages/database/rls.ts
ALTER TABLE "lead_source_reads" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "lead_source_reads" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "lead_source_reads";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_read ON "lead_source_reads";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_append ON "lead_source_reads";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_update ON "lead_source_reads";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_retention_delete ON "lead_source_reads";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "lead_source_reads" USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
