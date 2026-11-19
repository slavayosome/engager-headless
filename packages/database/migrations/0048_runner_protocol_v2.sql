CREATE TABLE "candidate_feedback" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"campaign_id" bigint NOT NULL,
	"discovered_post_id" bigint NOT NULL,
	"verdict" text NOT NULL,
	"reason" text,
	"note" text,
	"actor" text NOT NULL,
	"created_at" bigint NOT NULL,
	"reverted_at" bigint
);
--> statement-breakpoint
CREATE TABLE "runner_context_epochs" (
	"organization_id" uuid PRIMARY KEY DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runner_draft_schedules" (
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"campaign_id" bigint NOT NULL,
	"next_draft_at" bigint NOT NULL,
	"last_draft_claimed_at" bigint,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "runner_draft_schedules_organization_id_campaign_id_pk" PRIMARY KEY("organization_id","campaign_id")
);
--> statement-breakpoint
CREATE TABLE "runner_protocol_transitions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"from_state" text NOT NULL,
	"to_state" text NOT NULL,
	"operator" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runner_work_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"work_order_id" uuid NOT NULL,
	"item_type" text NOT NULL,
	"input_id" text NOT NULL,
	"action" text NOT NULL,
	"outcome" text NOT NULL,
	"output_id" text,
	"detail" jsonb,
	"idempotency_key" text,
	"request_hash" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runner_work_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"campaign_id" bigint NOT NULL,
	"contract_version" integer NOT NULL,
	"lane" text NOT NULL,
	"purpose" text DEFAULT 'production' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"not_before" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"input" jsonb NOT NULL,
	"limits" jsonb NOT NULL,
	"context_revision" text NOT NULL,
	"context_snapshot" jsonb,
	"context_snapshotted_at" bigint,
	"claimed_by_runner_id" text,
	"lease_token_hash" text,
	"lease_expires_at" bigint,
	"result" jsonb,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"completed_at" bigint,
	CONSTRAINT "runner_work_orders_attempt_check" CHECK ("runner_work_orders"."attempt" >= 1),
	CONSTRAINT "runner_work_orders_purpose_check" CHECK ("runner_work_orders"."purpose" in ('production', 'setup_proof'))
);
--> statement-breakpoint
ALTER TABLE "device_auth_requests" ADD COLUMN "delivery_protocol" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "device_auth_requests" ADD COLUMN "delivery_expires_at" bigint;--> statement-breakpoint
UPDATE "device_auth_requests"
	SET "status" = 'denied', "token" = NULL, "delivery_expires_at" = NULL
	WHERE "status" NOT IN ('pending', 'approved', 'denied', 'claimed');--> statement-breakpoint
ALTER TABLE "device_auth_requests" ADD CONSTRAINT "device_auth_requests_status_check"
	CHECK ("device_auth_requests"."status" in ('pending', 'approved', 'denied', 'claimed'));--> statement-breakpoint
ALTER TABLE "device_auth_requests" ADD CONSTRAINT "device_auth_requests_delivery_protocol_check"
	CHECK ("device_auth_requests"."delivery_protocol" in (1, 2));--> statement-breakpoint
ALTER TABLE "device_auth_requests" ADD CONSTRAINT "device_auth_requests_delivery_state_check"
	CHECK (
		"device_auth_requests"."delivery_expires_at" IS NULL
		OR (
			"device_auth_requests"."status" = 'claimed'
			AND "device_auth_requests"."api_key_id" IS NOT NULL
			AND "device_auth_requests"."token" IS NULL
		)
	);--> statement-breakpoint
ALTER TABLE "agent_runners" ADD COLUMN "contract_major" integer;--> statement-breakpoint
ALTER TABLE "agent_runners" ADD COLUMN "contract_minor" integer;--> statement-breakpoint
ALTER TABLE "agent_runners" ADD COLUMN "engine" text;--> statement-breakpoint
ALTER TABLE "agent_runners" ADD COLUMN "quota_state" jsonb;--> statement-breakpoint
ALTER TABLE "agent_runners" ADD COLUMN "last_healthy_receipt_at" bigint;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "runner_protocol_state" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
-- Composite tenant keys for low-write tables must exist before the tenant-safe
-- foreign keys below reference them.
CREATE UNIQUE INDEX "campaigns_org_id_unq" ON "campaigns" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "runner_work_orders_org_id_unq" ON "runner_work_orders" USING btree ("organization_id","id");--> statement-breakpoint
-- discovered_posts_org_campaign_id_unq and its dependent candidate_feedback FK
-- are installed by migrate.ts after this transaction using concurrent index
-- maintenance, so discovery ingestion never waits for a blocking index build.
ALTER TABLE "candidate_feedback" ADD CONSTRAINT "candidate_feedback_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_context_epochs" ADD CONSTRAINT "runner_context_epochs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_draft_schedules" ADD CONSTRAINT "runner_draft_schedules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_draft_schedules" ADD CONSTRAINT "runner_draft_schedules_org_campaign_fk" FOREIGN KEY ("organization_id","campaign_id") REFERENCES "public"."campaigns"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_protocol_transitions" ADD CONSTRAINT "runner_protocol_transitions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_work_events" ADD CONSTRAINT "runner_work_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_work_events" ADD CONSTRAINT "runner_work_events_org_work_order_fk" FOREIGN KEY ("organization_id","work_order_id") REFERENCES "public"."runner_work_orders"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_work_orders" ADD CONSTRAINT "runner_work_orders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_work_orders" ADD CONSTRAINT "runner_work_orders_org_campaign_fk" FOREIGN KEY ("organization_id","campaign_id") REFERENCES "public"."campaigns"("organization_id","id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
CREATE INDEX "candidate_feedback_org_campaign_created_idx" ON "candidate_feedback" USING btree ("organization_id","campaign_id","created_at");--> statement-breakpoint
CREATE INDEX "candidate_feedback_org_post_created_idx" ON "candidate_feedback" USING btree ("organization_id","discovered_post_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_feedback_org_campaign_post_active_unq" ON "candidate_feedback" USING btree ("organization_id","campaign_id","discovered_post_id") WHERE "candidate_feedback"."reverted_at" is null;--> statement-breakpoint
CREATE INDEX "runner_draft_schedules_org_due_idx" ON "runner_draft_schedules" USING btree ("organization_id","next_draft_at");--> statement-breakpoint
CREATE INDEX "runner_protocol_transitions_org_created_idx" ON "runner_protocol_transitions" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "runner_work_events_order_created_idx" ON "runner_work_events" USING btree ("work_order_id","created_at");--> statement-breakpoint
CREATE INDEX "runner_work_events_org_created_idx" ON "runner_work_events" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "runner_work_events_order_item_action_unq" ON "runner_work_events" USING btree ("work_order_id","item_type","input_id","action");--> statement-breakpoint
CREATE UNIQUE INDEX "runner_work_events_order_idempotency_unq" ON "runner_work_events" USING btree ("work_order_id","idempotency_key") WHERE "runner_work_events"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "runner_work_orders_org_status_eligible_idx" ON "runner_work_orders" USING btree ("organization_id","status","not_before","priority" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "runner_work_orders_org_campaign_lane_status_idx" ON "runner_work_orders" USING btree ("organization_id","campaign_id","lane","status");--> statement-breakpoint
CREATE INDEX "runner_work_orders_org_status_completed_idx" ON "runner_work_orders" USING btree ("organization_id","status","completed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "runner_work_orders_org_campaign_lane_open_unq" ON "runner_work_orders" USING btree ("organization_id","campaign_id","lane") WHERE "runner_work_orders"."status" in ('queued', 'claimed');--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_runner_protocol_state_check" CHECK ("organizations"."runner_protocol_state" in ('legacy', 'cohort', 'rollback'));
