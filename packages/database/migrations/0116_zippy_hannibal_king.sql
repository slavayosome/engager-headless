CREATE TABLE "automation_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"automation_id" bigint NOT NULL,
	"campaign_id" bigint NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"skip_reason" text,
	"phase" text,
	"started_at" bigint NOT NULL,
	"finished_at" bigint,
	"discovered_count" integer DEFAULT 0 NOT NULL,
	"triaged_count" integer DEFAULT 0 NOT NULL,
	"matched_count" integer DEFAULT 0 NOT NULL,
	"drafted_count" integer DEFAULT 0 NOT NULL,
	"published_count" integer DEFAULT 0 NOT NULL,
	"rejected_count" integer DEFAULT 0 NOT NULL,
	"cap_refused_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	CONSTRAINT "automation_runs_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "automation_runs_open_run_check" CHECK (("automation_runs"."status" = 'running') = ("automation_runs"."finished_at" is null)),
	CONSTRAINT "automation_runs_skip_reason_check" CHECK ("automation_runs"."skip_reason" is null or "automation_runs"."status" = 'skipped'),
	CONSTRAINT "automation_runs_counts_check" CHECK ("automation_runs"."discovered_count" >= 0 and "automation_runs"."triaged_count" >= 0 and "automation_runs"."matched_count" >= 0 and "automation_runs"."drafted_count" >= 0 and "automation_runs"."published_count" >= 0 and "automation_runs"."rejected_count" >= 0 and "automation_runs"."cap_refused_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"campaign_id" bigint NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'comment' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"sweep_enabled" boolean DEFAULT true NOT NULL,
	"sweep_interval_minutes" integer DEFAULT 240 NOT NULL,
	"draft_enabled" boolean DEFAULT false NOT NULL,
	"publish_enabled" boolean DEFAULT false NOT NULL,
	"active_hours" jsonb,
	"active_days" jsonb,
	"max_triage_per_run" integer DEFAULT 25 NOT NULL,
	"max_drafts_per_run" integer DEFAULT 5 NOT NULL,
	"max_publishes_per_run" integer DEFAULT 5 NOT NULL,
	"last_run_at" bigint,
	"next_run_at" bigint,
	"paused_reason" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "automations_org_name_key" UNIQUE("organization_id","name"),
	CONSTRAINT "automations_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "automations_stage_ladder_check" CHECK (not "automations"."publish_enabled" or "automations"."draft_enabled"),
	CONSTRAINT "automations_enabled_does_something_check" CHECK (not "automations"."enabled" or "automations"."sweep_enabled" or "automations"."draft_enabled" or "automations"."publish_enabled"),
	CONSTRAINT "automations_cadence_floor_check" CHECK ("automations"."sweep_interval_minutes" >= 30),
	CONSTRAINT "automations_per_run_limits_check" CHECK ("automations"."max_triage_per_run" between 0 and 100 and "automations"."max_drafts_per_run" between 0 and 100 and "automations"."max_publishes_per_run" between 0 and 100)
);
--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_org_automation_fk" FOREIGN KEY ("organization_id","automation_id") REFERENCES "public"."automations"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_runs_org_automation_started_idx" ON "automation_runs" USING btree ("organization_id","automation_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_runs_org_campaign_running_key" ON "automation_runs" USING btree ("organization_id","campaign_id") WHERE status = 'running';--> statement-breakpoint
CREATE INDEX "automations_org_campaign_idx" ON "automations" USING btree ("organization_id","campaign_id");--> statement-breakpoint
CREATE INDEX "automations_org_next_run_idx" ON "automations" USING btree ("organization_id","next_run_at");
--> statement-breakpoint
ALTER TABLE "automations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "automations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "automations"
	USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "automation_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "automation_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "automation_runs"
	USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
