CREATE TABLE "action_approvals" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"action_execution_id" bigint NOT NULL,
	"approver" text NOT NULL,
	"content_hash" text NOT NULL,
	"target_hash" text NOT NULL,
	"dependency_versions" jsonb NOT NULL,
	"expires_at" bigint NOT NULL,
	"used_at" bigint,
	"invalidated_at" bigint,
	"invalidated_reason" text,
	"created_at" bigint NOT NULL,
	CONSTRAINT "action_approvals_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "action_approvals_invalidated_check" CHECK (("action_approvals"."invalidated_at" is null) = ("action_approvals"."invalidated_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "action_executions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"channel_id" bigint NOT NULL,
	"campaign_id" bigint,
	"journey_id" bigint,
	"author_profile_id" text,
	"step_run_id" bigint,
	"action_binding_id" text,
	"kind" text NOT NULL,
	"purpose" text NOT NULL,
	"sequence" integer DEFAULT 1 NOT NULL,
	"idempotency_key" text NOT NULL,
	"target" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"candidate" jsonb NOT NULL,
	"origin" text DEFAULT 'automation' NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"status_reason" text,
	"fence_token" text,
	"generation_seen" bigint NOT NULL,
	"submitted_at" bigint,
	"external_receipt" jsonb,
	"attempts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"settled_at" bigint,
	CONSTRAINT "action_executions_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "action_executions_org_idempotency_key" UNIQUE("organization_id","idempotency_key"),
	CONSTRAINT "action_executions_kind_check" CHECK ("action_executions"."kind" in ('like_target', 'invite', 'accept_invite', 'dm', 'followup')),
	CONSTRAINT "action_executions_purpose_check" CHECK ("action_executions"."purpose" in ('opener', 'reply', 'cta', 'followup', 'reaction', 'acceptance')),
	CONSTRAINT "action_executions_origin_check" CHECK ("action_executions"."origin" in ('owner', 'automation')),
	CONSTRAINT "action_executions_status_check" CHECK ("action_executions"."status" in ('reserved', 'awaiting_review', 'approved', 'dispatching', 'confirmed', 'definitely_not_sent', 'uncertain', 'blocked', 'cancelled')),
	CONSTRAINT "action_executions_sequence_check" CHECK ("action_executions"."sequence" >= 1),
	CONSTRAINT "action_executions_fence_check" CHECK ("action_executions"."status" not in ('dispatching', 'uncertain') or ("action_executions"."fence_token" is not null and "action_executions"."submitted_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "pause_controls" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"scope" text NOT NULL,
	"scope_id" bigint NOT NULL,
	"reason" text NOT NULL,
	"generation" bigint NOT NULL,
	"paused_at" bigint NOT NULL,
	"paused_by" text NOT NULL,
	"resumed_at" bigint,
	"resumed_by" text,
	CONSTRAINT "pause_controls_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "pause_controls_org_generation_key" UNIQUE("organization_id","generation"),
	CONSTRAINT "pause_controls_scope_check" CHECK ("pause_controls"."scope" in ('account', 'campaign', 'conversation')),
	CONSTRAINT "pause_controls_reason_check" CHECK ("pause_controls"."reason" in ('stop', 'takeover', 'warning', 'restriction', 'opt_out', 'revocation', 'exclusion')),
	CONSTRAINT "pause_controls_generation_check" CHECK ("pause_controls"."generation" >= 1),
	CONSTRAINT "pause_controls_resumed_check" CHECK (("pause_controls"."resumed_at" is null) = ("pause_controls"."resumed_by" is null))
);
--> statement-breakpoint
ALTER TABLE "action_approvals" ADD CONSTRAINT "action_approvals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_approvals" ADD CONSTRAINT "action_approvals_org_action_fk" FOREIGN KEY ("organization_id","action_execution_id") REFERENCES "public"."action_executions"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_executions" ADD CONSTRAINT "action_executions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_executions" ADD CONSTRAINT "action_executions_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_executions" ADD CONSTRAINT "action_executions_org_channel_fk" FOREIGN KEY ("organization_id","channel_id") REFERENCES "public"."channels"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_executions" ADD CONSTRAINT "action_executions_org_journey_fk" FOREIGN KEY ("organization_id","journey_id") REFERENCES "public"."journeys"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pause_controls" ADD CONSTRAINT "pause_controls_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "action_approvals_live_unq" ON "action_approvals" USING btree ("organization_id","action_execution_id") WHERE "action_approvals"."used_at" is null and "action_approvals"."invalidated_at" is null;--> statement-breakpoint
CREATE INDEX "action_executions_org_status_idx" ON "action_executions" USING btree ("organization_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "action_executions_org_journey_idx" ON "action_executions" USING btree ("organization_id","journey_id");--> statement-breakpoint
CREATE INDEX "action_executions_org_campaign_idx" ON "action_executions" USING btree ("organization_id","campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pause_controls_open_unq" ON "pause_controls" USING btree ("organization_id","scope","scope_id","reason") WHERE "pause_controls"."resumed_at" is null;--> statement-breakpoint
ALTER TABLE "action_executions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "action_executions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "action_executions"
	USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "action_approvals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "action_approvals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "action_approvals"
	USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "pause_controls" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pause_controls" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "pause_controls"
	USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
