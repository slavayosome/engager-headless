-- THE OWNER'S PROBLEM REPORTS. One new table, `bug_reports`, with its RLS
-- family installed in this same file: one row per report the owner sent from
-- the dashboard — their words, the screen, the screenshots they ticked, the
-- diagnostics they previewed — and its delivery's state as the
-- `file_bug_report` job moves it. The id is the report's idempotency key end
-- to end. Rows go with their organization.
-- Expand-only: no existing table, column, constraint or row moves, and old
-- code never names it.
CREATE TABLE "bug_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"screen" jsonb NOT NULL,
	"owner_text" text NOT NULL,
	"expected" text,
	"screenshots" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"include_diagnostics" boolean NOT NULL,
	"diagnostics" text,
	"app" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"agent_summary" jsonb,
	"message_id" text,
	"sent_at" bigint,
	"error" text,
	"queued_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bug_reports" ADD CONSTRAINT "bug_reports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bug_reports_org_created_idx" ON "bug_reports" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "bug_reports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bug_reports" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "bug_reports"
	USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
