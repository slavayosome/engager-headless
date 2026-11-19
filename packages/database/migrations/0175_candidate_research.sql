CREATE TABLE "candidate_research" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"campaign_id" bigint NOT NULL,
	"discovered_post_id" bigint NOT NULL,
	"thread" jsonb,
	"author" jsonb,
	"thread_read_at" bigint,
	"author_read_at" bigint,
	"play" text,
	"author_reply_rate" real,
	"already_said" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"verdict" text,
	"reason_code" text,
	"reason" text,
	"verified_by" text,
	"run_id" bigint,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "candidate_research_verdict_check" CHECK (("candidate_research"."verdict" is null and "candidate_research"."reason_code" is null and "candidate_research"."verified_by" is null) or ("candidate_research"."verdict" = 'confirmed' and "candidate_research"."reason_code" is null and "candidate_research"."verified_by" is not null) or ("candidate_research"."verdict" = 'rejected' and "candidate_research"."verified_by" is not null and ("candidate_research"."reason_code" is not null or "candidate_research"."verified_by" = 'owner')))
);
--> statement-breakpoint
ALTER TABLE "discovered_posts" ADD COLUMN "verified_at" bigint;--> statement-breakpoint
ALTER TABLE "discovered_posts" ADD COLUMN "verify_verdict" text;--> statement-breakpoint
ALTER TABLE "candidate_research" ADD CONSTRAINT "candidate_research_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- candidate_research_org_campaign_post_fk is installed by migrate.ts after
-- the concurrent discovered_posts tenant key exists, matching
-- candidate_draft_requests: that parent key is built CONCURRENTLY, so it does
-- not exist yet inside this transaction.--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_research_org_post_unq" ON "candidate_research" USING btree ("organization_id","discovered_post_id");--> statement-breakpoint
ALTER TABLE "candidate_research" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "candidate_research" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "candidate_research"
	USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
