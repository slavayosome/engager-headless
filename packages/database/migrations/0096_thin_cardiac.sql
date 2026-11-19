CREATE TABLE "mcp_app_card_sessions" (
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"surface" text NOT NULL,
	"card_id" uuid NOT NULL,
	"claim_seq" bigint DEFAULT 1 NOT NULL,
	"claimed_at" bigint NOT NULL,
	CONSTRAINT "mcp_app_card_sessions_organization_id_surface_pk" PRIMARY KEY("organization_id","surface")
);
--> statement-breakpoint
ALTER TABLE "mcp_app_card_sessions" ADD CONSTRAINT "mcp_app_card_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_app_card_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mcp_app_card_sessions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "mcp_app_card_sessions"
	USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
