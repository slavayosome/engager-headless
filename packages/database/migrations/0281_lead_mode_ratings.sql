CREATE TABLE "lead_ratings" (
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"lead_id" integer NOT NULL,
	"campaign_id" bigint,
	"verdict" text NOT NULL,
	"phrase_id" bigint,
	"scout_role" text NOT NULL,
	"rated_at" bigint NOT NULL,
	CONSTRAINT "lead_ratings_organization_id_lead_id_pk" PRIMARY KEY("organization_id","lead_id"),
	CONSTRAINT "lead_ratings_values_check" CHECK ("lead_ratings"."verdict" in ('right_person', 'a_peer', 'not_a_fit', 'wrong_intent')
        and "lead_ratings"."scout_role" in ('buyer', 'peer', 'competitor', 'partner', 'noise'))
);
--> statement-breakpoint
ALTER TABLE "lead_ratings" ADD CONSTRAINT "lead_ratings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_ratings" ADD CONSTRAINT "lead_ratings_org_lead_fk" FOREIGN KEY ("organization_id","lead_id") REFERENCES "public"."leads"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- A composite FK would null the required organization column too; only the named column goes (PostgreSQL 15).
ALTER TABLE "lead_ratings" ADD CONSTRAINT "lead_ratings_org_campaign_fk" FOREIGN KEY ("organization_id","campaign_id") REFERENCES "public"."campaigns"("organization_id","id") ON DELETE set null ("campaign_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_ratings" ADD CONSTRAINT "lead_ratings_org_phrase_fk" FOREIGN KEY ("organization_id","phrase_id") REFERENCES "public"."listening_phrases"("organization_id","id") ON DELETE set null ("phrase_id") ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lead_ratings_org_campaign_rated_idx" ON "lead_ratings" USING btree ("organization_id","campaign_id","rated_at");
--> statement-breakpoint
-- Generated tenant policies from packages/database/rls.ts
ALTER TABLE "lead_ratings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "lead_ratings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "lead_ratings";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_read ON "lead_ratings";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_append ON "lead_ratings";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_update ON "lead_ratings";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_retention_delete ON "lead_ratings";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "lead_ratings" USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
