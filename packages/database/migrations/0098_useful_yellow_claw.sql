CREATE TABLE "candidate_draft_requests" (
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"campaign_id" bigint NOT NULL,
	"discovered_post_id" bigint NOT NULL,
	"request_revision" integer DEFAULT 0 NOT NULL,
	"instruction" text,
	"seed_text" text,
	"parked_text" text,
	"pending" boolean DEFAULT false NOT NULL,
	"failed" boolean DEFAULT false NOT NULL,
	"rejection_count" integer DEFAULT 0 NOT NULL,
	"offered" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requested_at" bigint,
	"filled_at" bigint,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "candidate_draft_requests_organization_id_campaign_id_discovered_post_id_pk" PRIMARY KEY("organization_id","campaign_id","discovered_post_id")
);
--> statement-breakpoint
ALTER TABLE "candidate_draft_requests" ADD CONSTRAINT "candidate_draft_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- candidate_draft_requests_org_campaign_post_fk is installed by migrate.ts
-- after the concurrent discovered_posts tenant key exists, matching
-- candidate_actions. The parent key is built CONCURRENTLY so discovery
-- ingestion never waits on a blocking index build, which means it does not
-- exist yet inside this transaction.--> statement-breakpoint
ALTER TABLE "candidate_draft_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "candidate_draft_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "candidate_draft_requests"
	USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
