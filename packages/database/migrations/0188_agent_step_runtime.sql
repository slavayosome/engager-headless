CREATE TABLE "step_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"run_id" bigint NOT NULL,
	"journey_id" bigint NOT NULL,
	"campaign_id" bigint NOT NULL,
	"step_id" text NOT NULL,
	"work_key" text NOT NULL,
	"event_id" bigint,
	"definition_version" integer NOT NULL,
	"input_version" text,
	"evidence_version" text,
	"iterations" integer DEFAULT 0 NOT NULL,
	"tool_actions" integer DEFAULT 0 NOT NULL,
	"elapsed_ms" integer DEFAULT 0 NOT NULL,
	"tokens" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"blocked_reason" text,
	"rationale_summary" text,
	"evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"wait" jsonb,
	"drafts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"memory_patches" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"finished_at" bigint,
	CONSTRAINT "step_runs_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "step_runs_org_work_key" UNIQUE("organization_id","journey_id","step_id","work_key"),
	CONSTRAINT "step_runs_status_check" CHECK ("step_runs"."status" in ('running', 'achieved', 'waiting', 'needs_approval', 'blocked', 'budget_exhausted')),
	CONSTRAINT "step_runs_open_check" CHECK (("step_runs"."status" = 'running') = ("step_runs"."finished_at" is null)),
	CONSTRAINT "step_runs_counts_check" CHECK ("step_runs"."iterations" >= 0 and "step_runs"."tool_actions" >= 0 and "step_runs"."elapsed_ms" >= 0 and "step_runs"."tokens" >= 0)
);
--> statement-breakpoint
CREATE TABLE "step_tool_calls" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"step_run_id" bigint NOT NULL,
	"run_id" bigint NOT NULL,
	"iteration" integer NOT NULL,
	"call_id" text,
	"tool" text NOT NULL,
	"tool_version" integer,
	"target_kind" text,
	"target_ref" text,
	"call_digest" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"result_ref" text,
	"created_at" bigint NOT NULL,
	CONSTRAINT "step_tool_calls_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "step_tool_calls_outcome_check" CHECK ("step_tool_calls"."outcome" in ('dispatched', 'discarded')),
	CONSTRAINT "step_tool_calls_reason_check" CHECK (("step_tool_calls"."outcome" = 'dispatched') = ("step_tool_calls"."reason" is null))
);
--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "served_step_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "frozen_journey_ids" bigint[] DEFAULT '{}'::bigint[] NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "journeys_selected_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "iterations_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "tool_calls_dispatched_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "tool_calls_discarded_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "step_drafted_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "step_runs" ADD CONSTRAINT "step_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_runs" ADD CONSTRAINT "step_runs_org_run_fk" FOREIGN KEY ("organization_id","run_id") REFERENCES "public"."automation_runs"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_runs" ADD CONSTRAINT "step_runs_org_journey_fk" FOREIGN KEY ("organization_id","journey_id") REFERENCES "public"."journeys"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_tool_calls" ADD CONSTRAINT "step_tool_calls_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_tool_calls" ADD CONSTRAINT "step_tool_calls_org_step_run_fk" FOREIGN KEY ("organization_id","step_run_id") REFERENCES "public"."step_runs"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "step_runs_org_run_idx" ON "step_runs" USING btree ("organization_id","run_id");--> statement-breakpoint
CREATE INDEX "step_tool_calls_org_step_run_idx" ON "step_tool_calls" USING btree ("organization_id","step_run_id");--> statement-breakpoint
CREATE INDEX "step_tool_calls_org_run_idx" ON "step_tool_calls" USING btree ("organization_id","run_id");--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_step_counts_check" CHECK ("automation_runs"."journeys_selected_count" >= 0 and "automation_runs"."iterations_count" >= 0 and "automation_runs"."tool_calls_dispatched_count" >= 0 and "automation_runs"."tool_calls_discarded_count" >= 0 and "automation_runs"."step_drafted_count" >= 0);--> statement-breakpoint
ALTER TABLE "step_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "step_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "step_runs"
	USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "step_tool_calls" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "step_tool_calls" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_read ON "step_tool_calls" FOR SELECT USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_append ON "step_tool_calls" FOR INSERT WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);