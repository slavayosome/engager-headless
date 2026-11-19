CREATE TABLE "person_reads" (
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"person_key" text NOT NULL,
	"read_at" bigint,
	"archived_at" bigint,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "person_reads_organization_id_person_key_pk" PRIMARY KEY("organization_id","person_key"),
	CONSTRAINT "person_reads_person_key_check" CHECK ("person_reads"."person_key" ~ '^[pm][.]')
);
--> statement-breakpoint
ALTER TABLE "person_reads" ADD CONSTRAINT "person_reads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Generated tenant policies from packages/database/rls.ts
ALTER TABLE "person_reads" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "person_reads" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "person_reads";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_read ON "person_reads";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_append ON "person_reads";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_update ON "person_reads";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_retention_delete ON "person_reads";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "person_reads" USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
