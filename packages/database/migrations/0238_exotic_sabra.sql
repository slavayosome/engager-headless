CREATE TABLE "discovery_author_dismissals" (
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"campaign_id" bigint NOT NULL,
	"author_identity" text NOT NULL,
	"dismissed_at" bigint NOT NULL,
	CONSTRAINT "discovery_author_dismissals_organization_id_campaign_id_author_identity_pk" PRIMARY KEY("organization_id","campaign_id","author_identity"),
	CONSTRAINT "discovery_author_dismissals_identity" CHECK (length("discovery_author_dismissals"."author_identity") between 1 and 300)
);
--> statement-breakpoint
ALTER TABLE "discovery_author_dismissals" ADD CONSTRAINT "discovery_author_dismissals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_author_dismissals" ADD CONSTRAINT "discovery_author_dismissals_org_campaign_fk" FOREIGN KEY ("organization_id","campaign_id") REFERENCES "public"."campaigns"("organization_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Generated tenant policies from packages/database/rls.ts
ALTER TABLE "discovery_author_dismissals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "discovery_author_dismissals" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "discovery_author_dismissals";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_read ON "discovery_author_dismissals";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_append ON "discovery_author_dismissals";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_update ON "discovery_author_dismissals";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_retention_delete ON "discovery_author_dismissals";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "discovery_author_dismissals" USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
