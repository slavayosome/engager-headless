CREATE TABLE "lead_thread_reads" (
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"campaign_id" bigint NOT NULL,
	"post_urn" text NOT NULL,
	"read_at" bigint NOT NULL,
	CONSTRAINT "lead_thread_reads_organization_id_campaign_id_post_urn_pk" PRIMARY KEY("organization_id","campaign_id","post_urn")
);
--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "search_depth" text;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "lead_read_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "lead_found_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "lead_screened_in_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "lead_researched_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "lead_research_deferred_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "lead_served_asking_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "lead_served_problem_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "lead_served_topic_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "lead_merged_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "lead_drop_no_words_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "lead_drop_selling_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "lead_drop_solved_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "lead_drop_recruiter_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "lead_drop_student_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "lead_buyer_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "lead_not_fit_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "lead_peer_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "lead_partner_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "search_pages_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "thread_reads_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "profile_reads_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "lead_signals" ADD COLUMN "profile_spelling" text;--> statement-breakpoint
ALTER TABLE "lead_signals" ADD COLUMN "headline_from" text;--> statement-breakpoint
ALTER TABLE "lead_signals" ADD COLUMN "comment_count" integer;--> statement-breakpoint
ALTER TABLE "lead_signals" ADD COLUMN "angles" jsonb;--> statement-breakpoint
ALTER TABLE "lead_signals" ADD COLUMN "lead_id" integer;--> statement-breakpoint
ALTER TABLE "listening_phrases" ADD COLUMN "next_read_at" bigint;--> statement-breakpoint
ALTER TABLE "lead_thread_reads" ADD CONSTRAINT "lead_thread_reads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_thread_reads" ADD CONSTRAINT "lead_thread_reads_org_campaign_fk" FOREIGN KEY ("organization_id","campaign_id") REFERENCES "public"."campaigns"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "leads_org_id_unq" ON "leads" USING btree ("organization_id","id");--> statement-breakpoint
-- A composite FK would null the required organization column too; only the lead goes (PostgreSQL 15).
ALTER TABLE "lead_signals" ADD CONSTRAINT "lead_signals_org_lead_fk" FOREIGN KEY ("organization_id","lead_id") REFERENCES "public"."leads"("organization_id","id") ON DELETE set null ("lead_id") ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lead_signals_org_lead_idx" ON "lead_signals" USING btree ("organization_id","lead_id");--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_lead_counts_check" CHECK ("automation_runs"."lead_read_count" >= 0 and "automation_runs"."lead_found_count" >= 0 and "automation_runs"."lead_screened_in_count" >= 0
        and "automation_runs"."lead_researched_count" >= 0 and "automation_runs"."lead_research_deferred_count" >= 0
        and "automation_runs"."lead_served_asking_count" >= 0 and "automation_runs"."lead_served_problem_count" >= 0 and "automation_runs"."lead_served_topic_count" >= 0
        and "automation_runs"."lead_merged_count" >= 0 and "automation_runs"."lead_drop_no_words_count" >= 0 and "automation_runs"."lead_drop_selling_count" >= 0
        and "automation_runs"."lead_drop_solved_count" >= 0 and "automation_runs"."lead_drop_recruiter_count" >= 0 and "automation_runs"."lead_drop_student_count" >= 0
        and "automation_runs"."lead_buyer_count" >= 0 and "automation_runs"."lead_not_fit_count" >= 0 and "automation_runs"."lead_peer_count" >= 0
        and "automation_runs"."lead_partner_count" >= 0 and "automation_runs"."search_pages_count" >= 0 and "automation_runs"."thread_reads_count" >= 0
        and "automation_runs"."profile_reads_count" >= 0);--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_search_depth_check" CHECK ("automation_runs"."search_depth" is null or "automation_runs"."search_depth" in ('quick', 'standard', 'deep'));--> statement-breakpoint
ALTER TABLE "lead_signals" ADD CONSTRAINT "lead_signals_headline_from_check" CHECK ("lead_signals"."headline_from" is null or "lead_signals"."headline_from" in ('search', 'comment'));--> statement-breakpoint
ALTER TABLE "lead_signals" ADD CONSTRAINT "lead_signals_comment_count_check" CHECK ("lead_signals"."comment_count" is null or "lead_signals"."comment_count" >= 0);--> statement-breakpoint
ALTER TABLE "lead_signals" ADD CONSTRAINT "lead_signals_angles_check" CHECK ("lead_signals"."angles" is null or (jsonb_typeof("lead_signals"."angles") = 'array' and jsonb_array_length("lead_signals"."angles") <= 2));
--> statement-breakpoint
-- Generated tenant policies from packages/database/rls.ts
ALTER TABLE "lead_thread_reads" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "lead_thread_reads" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "lead_thread_reads";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_read ON "lead_thread_reads";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_append ON "lead_thread_reads";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_update ON "lead_thread_reads";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_retention_delete ON "lead_thread_reads";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "lead_thread_reads" USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
