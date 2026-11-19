CREATE TABLE "company_reads" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"company_ref" text NOT NULL,
	"read" jsonb NOT NULL,
	"read_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "company_not_read" text;--> statement-breakpoint
ALTER TABLE "company_reads" ADD CONSTRAINT "company_reads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_reads_org_company_ref_unq" ON "company_reads" USING btree ("organization_id","company_ref");--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_company_not_read_check" CHECK ("leads"."company_not_read" is null or "leads"."company_not_read" in ('no_company_page', 'unsupported', 'reads_spent', 'failed'));
--> statement-breakpoint
-- Generated tenant policies from packages/database/rls.ts
ALTER TABLE "company_reads" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "company_reads" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "company_reads";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_read ON "company_reads";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_append ON "company_reads";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_update ON "company_reads";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_retention_delete ON "company_reads";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "company_reads" USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
