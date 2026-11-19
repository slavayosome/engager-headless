CREATE TABLE "cloud_fleet_permits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"intent_key" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"queued_at" bigint NOT NULL,
	"granted_at" bigint,
	"heartbeat_at" bigint,
	"expires_at" bigint,
	"released_at" bigint,
	"release_reason" text,
	"fleet_limit" integer NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "cloud_fleet_permits_state_check" CHECK ("cloud_fleet_permits"."state" in ('queued', 'granted', 'released', 'expired') and "cloud_fleet_permits"."fleet_limit" > 0 and "cloud_fleet_permits"."intent_key" <> ''),
	CONSTRAINT "cloud_fleet_permits_lifecycle_check" CHECK (("cloud_fleet_permits"."state" = 'queued' and "cloud_fleet_permits"."granted_at" is null and "cloud_fleet_permits"."released_at" is null) or ("cloud_fleet_permits"."state" = 'granted' and "cloud_fleet_permits"."granted_at" is not null and "cloud_fleet_permits"."expires_at" is not null and "cloud_fleet_permits"."released_at" is null) or ("cloud_fleet_permits"."state" in ('released', 'expired') and "cloud_fleet_permits"."released_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "cloud_provider_circuits" (
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"provider" text NOT NULL,
	"period_start" bigint NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"opened_at" bigint,
	"open_until" bigint,
	"last_failure_kind" text,
	"last_failure_at" bigint,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "cloud_provider_circuits_organization_id_provider_pk" PRIMARY KEY("organization_id","provider"),
	CONSTRAINT "cloud_provider_circuits_counters_check" CHECK ("cloud_provider_circuits"."consecutive_failures" >= 0 and "cloud_provider_circuits"."provider" <> '')
);
--> statement-breakpoint
CREATE TABLE "cloud_resource_dimensions" (
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"period_start" bigint NOT NULL,
	"scope" text NOT NULL,
	"kind" text NOT NULL,
	"dimension_key" text NOT NULL,
	"max_calls" integer NOT NULL,
	"call_count" integer DEFAULT 0 NOT NULL,
	"max_concurrency" integer NOT NULL,
	"active_reservations" integer DEFAULT 0 NOT NULL,
	"reserved_usd_micros" bigint DEFAULT 0 NOT NULL,
	"spent_usd_micros" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "cloud_resource_dimensions_organization_id_period_start_scope_kind_dimension_key_pk" PRIMARY KEY("organization_id","period_start","scope","kind","dimension_key"),
	CONSTRAINT "cloud_resource_dimensions_counters_check" CHECK ("cloud_resource_dimensions"."dimension_key" <> '' and "cloud_resource_dimensions"."max_calls" > 0 and "cloud_resource_dimensions"."call_count" >= 0 and "cloud_resource_dimensions"."max_concurrency" > 0 and "cloud_resource_dimensions"."active_reservations" >= 0 and "cloud_resource_dimensions"."reserved_usd_micros" >= 0 and "cloud_resource_dimensions"."spent_usd_micros" >= 0),
	CONSTRAINT "cloud_resource_dimensions_kind_check" CHECK ("cloud_resource_dimensions"."kind" in ('credential', 'tool'))
);
--> statement-breakpoint
CREATE TABLE "cloud_resource_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"period_start" bigint NOT NULL,
	"scope" text NOT NULL,
	"reservation_id" uuid,
	"entry_type" text NOT NULL,
	"resource" text NOT NULL,
	"limit_delta" bigint DEFAULT 0 NOT NULL,
	"reserved_delta" bigint DEFAULT 0 NOT NULL,
	"spent_delta" bigint DEFAULT 0 NOT NULL,
	"uncertain_delta" bigint DEFAULT 0 NOT NULL,
	"metadata" jsonb,
	"created_at" bigint NOT NULL,
	CONSTRAINT "cloud_resource_ledger_entry_check" CHECK ("cloud_resource_ledger"."entry_type" in ('grant', 'reserve', 'start', 'settle', 'release', 'uncertain', 'resolve_uncertain', 'adjust') and "cloud_resource_ledger"."scope" in ('tenant', 'recovery') and "cloud_resource_ledger"."resource" in ('input_tokens', 'output_tokens', 'usd_micros', 'browser_seconds', 'traffic_bytes', 'session_slots')),
	CONSTRAINT "cloud_resource_ledger_reservation_presence_check" CHECK (("cloud_resource_ledger"."entry_type" in ('grant', 'adjust')) or "cloud_resource_ledger"."reservation_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "cloud_resource_periods" (
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"period_start" bigint NOT NULL,
	"scope" text NOT NULL,
	"period_end" bigint NOT NULL,
	"subscription_id" text,
	"commercial_generation" bigint DEFAULT 0 NOT NULL,
	"offer_id" text,
	"tariff_version" text NOT NULL,
	"policy_version" text NOT NULL,
	"max_attempts" integer NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_concurrent_calls" integer NOT NULL,
	"active_calls" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "cloud_resource_periods_organization_id_period_start_scope_pk" PRIMARY KEY("organization_id","period_start","scope"),
	CONSTRAINT "cloud_resource_periods_window_check" CHECK ("cloud_resource_periods"."period_end" > "cloud_resource_periods"."period_start" and "cloud_resource_periods"."period_start" > 0),
	CONSTRAINT "cloud_resource_periods_scope_check" CHECK ("cloud_resource_periods"."scope" in ('tenant', 'recovery')),
	CONSTRAINT "cloud_resource_periods_attempts_check" CHECK ("cloud_resource_periods"."max_attempts" > 0 and "cloud_resource_periods"."attempt_count" >= 0 and "cloud_resource_periods"."max_concurrent_calls" > 0 and "cloud_resource_periods"."active_calls" >= 0 and "cloud_resource_periods"."commercial_generation" >= 0)
);
--> statement-breakpoint
CREATE TABLE "cloud_resource_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"period_start" bigint NOT NULL,
	"scope" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"lease_token" uuid DEFAULT gen_random_uuid() NOT NULL,
	"purpose" text NOT NULL,
	"tariff_version" text NOT NULL,
	"credential_key_id" text,
	"request_id" text NOT NULL,
	"request_phase" integer NOT NULL,
	"job_id" bigint,
	"job_lease_token" text,
	"channel_id" integer,
	"execution_epoch" bigint,
	"commercial_generation" bigint DEFAULT 0 NOT NULL,
	"source" text NOT NULL,
	"tool" text NOT NULL,
	"provider" text NOT NULL,
	"operation" text NOT NULL,
	"model" text,
	"input_fingerprint" text,
	"provider_allocation_id" text,
	"provider_session_id" text,
	"max_input_tokens" bigint DEFAULT 0 NOT NULL,
	"max_output_tokens" bigint DEFAULT 0 NOT NULL,
	"max_usd_micros" bigint DEFAULT 0 NOT NULL,
	"max_browser_seconds" bigint DEFAULT 0 NOT NULL,
	"max_traffic_bytes" bigint DEFAULT 0 NOT NULL,
	"max_session_slots" integer DEFAULT 0 NOT NULL,
	"actual_input_tokens" bigint,
	"actual_output_tokens" bigint,
	"actual_usd_micros" bigint,
	"actual_browser_seconds" bigint,
	"actual_traffic_bytes" bigint,
	"state" text DEFAULT 'reserved' NOT NULL,
	"failure_kind" text,
	"over_bound" boolean DEFAULT false NOT NULL,
	"expires_at" bigint NOT NULL,
	"started_at" bigint,
	"settled_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "cloud_resource_reservations_scope_check" CHECK ("cloud_resource_reservations"."scope" in ('tenant', 'recovery') and "cloud_resource_reservations"."purpose" in ('model_call', 'browser_session') and "cloud_resource_reservations"."state" in ('reserved', 'started', 'settled', 'released', 'uncertain')),
	CONSTRAINT "cloud_resource_reservations_maxima_check" CHECK ("cloud_resource_reservations"."request_phase" > 0 and "cloud_resource_reservations"."max_input_tokens" >= 0 and "cloud_resource_reservations"."max_output_tokens" >= 0 and "cloud_resource_reservations"."max_usd_micros" >= 0 and "cloud_resource_reservations"."max_browser_seconds" >= 0 and "cloud_resource_reservations"."max_traffic_bytes" >= 0 and "cloud_resource_reservations"."max_session_slots" >= 0 and ("cloud_resource_reservations"."max_input_tokens" + "cloud_resource_reservations"."max_output_tokens" + "cloud_resource_reservations"."max_usd_micros" + "cloud_resource_reservations"."max_browser_seconds" + "cloud_resource_reservations"."max_traffic_bytes" + "cloud_resource_reservations"."max_session_slots") > 0),
	CONSTRAINT "cloud_resource_reservations_lifecycle_check" CHECK (("cloud_resource_reservations"."state" = 'reserved' and "cloud_resource_reservations"."started_at" is null and "cloud_resource_reservations"."settled_at" is null) or ("cloud_resource_reservations"."state" = 'started' and "cloud_resource_reservations"."started_at" is not null and "cloud_resource_reservations"."settled_at" is null) or ("cloud_resource_reservations"."state" = 'uncertain' and "cloud_resource_reservations"."started_at" is not null and "cloud_resource_reservations"."settled_at" is null) or ("cloud_resource_reservations"."state" in ('settled', 'released') and "cloud_resource_reservations"."settled_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "cloud_resource_totals" (
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"period_start" bigint NOT NULL,
	"scope" text NOT NULL,
	"resource" text NOT NULL,
	"limit_units" bigint NOT NULL,
	"reserved_units" bigint DEFAULT 0 NOT NULL,
	"spent_units" bigint DEFAULT 0 NOT NULL,
	"uncertain_units" bigint DEFAULT 0 NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "cloud_resource_totals_organization_id_period_start_scope_resource_pk" PRIMARY KEY("organization_id","period_start","scope","resource"),
	CONSTRAINT "cloud_resource_totals_counters_check" CHECK ("cloud_resource_totals"."limit_units" >= 0 and "cloud_resource_totals"."reserved_units" >= 0 and "cloud_resource_totals"."spent_units" >= 0 and "cloud_resource_totals"."uncertain_units" >= 0),
	CONSTRAINT "cloud_resource_totals_resource_check" CHECK ("cloud_resource_totals"."resource" in ('input_tokens', 'output_tokens', 'usd_micros', 'browser_seconds', 'traffic_bytes', 'session_slots'))
);
--> statement-breakpoint
ALTER TABLE "cloud_fleet_permits" ADD CONSTRAINT "cloud_fleet_permits_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_provider_circuits" ADD CONSTRAINT "cloud_provider_circuits_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_resource_dimensions" ADD CONSTRAINT "cloud_resource_dimensions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_resource_dimensions" ADD CONSTRAINT "cloud_resource_dimensions_period_fk" FOREIGN KEY ("organization_id","period_start","scope") REFERENCES "public"."cloud_resource_periods"("organization_id","period_start","scope") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_resource_ledger" ADD CONSTRAINT "cloud_resource_ledger_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_resource_periods" ADD CONSTRAINT "cloud_resource_periods_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_resource_reservations" ADD CONSTRAINT "cloud_resource_reservations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_resource_reservations" ADD CONSTRAINT "cloud_resource_reservations_period_fk" FOREIGN KEY ("organization_id","period_start","scope") REFERENCES "public"."cloud_resource_periods"("organization_id","period_start","scope") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_resource_totals" ADD CONSTRAINT "cloud_resource_totals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_resource_totals" ADD CONSTRAINT "cloud_resource_totals_period_fk" FOREIGN KEY ("organization_id","period_start","scope") REFERENCES "public"."cloud_resource_periods"("organization_id","period_start","scope") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_fleet_permits_live_org_unq" ON "cloud_fleet_permits" USING btree ("organization_id") WHERE "cloud_fleet_permits"."state" in ('queued', 'granted');--> statement-breakpoint
CREATE INDEX "cloud_fleet_permits_queue_idx" ON "cloud_fleet_permits" USING btree ("state","queued_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_resource_ledger_reservation_entry_unq" ON "cloud_resource_ledger" USING btree ("reservation_id","entry_type","resource") WHERE "cloud_resource_ledger"."reservation_id" is not null;--> statement-breakpoint
CREATE INDEX "cloud_resource_ledger_period_idx" ON "cloud_resource_ledger" USING btree ("organization_id","period_start","scope","resource");--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_resource_reservations_org_idempotency_unq" ON "cloud_resource_reservations" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_resource_reservations_org_period_id_unq" ON "cloud_resource_reservations" USING btree ("organization_id","period_start","scope","id");--> statement-breakpoint
CREATE INDEX "cloud_resource_reservations_expiry_idx" ON "cloud_resource_reservations" USING btree ("organization_id","state","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_resource_reservations_allocation_unq" ON "cloud_resource_reservations" USING btree ("organization_id","provider_allocation_id") WHERE "cloud_resource_reservations"."provider_allocation_id" is not null;
--> statement-breakpoint
-- The six `cloud_resource_*` / `cloud_provider_circuits` tables are TENANT
-- tables: enable + FORCE RLS and install their policies INSIDE the transaction
-- that creates them, so an accounting row is never readable across orgs for
-- even one statement. They join the hosted-spend policy family — read, append,
-- and update counters, never application delete — and `cloud_resource_ledger`
-- is append-only, so it gets no update policy at all. `applyRls` re-applies
-- this idempotently on every migrate; this block is what makes the pre-commit
-- firebreak true.
--
-- `cloud_fleet_permits` is deliberately absent: fleet admission is arbitrated
-- across tenants by the controller before any one tenant's scope exists, like
-- `engagement_leases`, and every query binds its organization explicitly.
ALTER TABLE "cloud_resource_periods" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cloud_resource_periods" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "cloud_resource_periods";--> statement-breakpoint
DROP POLICY IF EXISTS tenant_read ON "cloud_resource_periods";--> statement-breakpoint
DROP POLICY IF EXISTS tenant_append ON "cloud_resource_periods";--> statement-breakpoint
DROP POLICY IF EXISTS tenant_update ON "cloud_resource_periods";--> statement-breakpoint
DROP POLICY IF EXISTS tenant_retention_delete ON "cloud_resource_periods";--> statement-breakpoint
CREATE POLICY tenant_read ON "cloud_resource_periods" FOR SELECT USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_append ON "cloud_resource_periods" FOR INSERT WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_update ON "cloud_resource_periods" FOR UPDATE USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "cloud_resource_totals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cloud_resource_totals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "cloud_resource_totals";--> statement-breakpoint
DROP POLICY IF EXISTS tenant_read ON "cloud_resource_totals";--> statement-breakpoint
DROP POLICY IF EXISTS tenant_append ON "cloud_resource_totals";--> statement-breakpoint
DROP POLICY IF EXISTS tenant_update ON "cloud_resource_totals";--> statement-breakpoint
DROP POLICY IF EXISTS tenant_retention_delete ON "cloud_resource_totals";--> statement-breakpoint
CREATE POLICY tenant_read ON "cloud_resource_totals" FOR SELECT USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_append ON "cloud_resource_totals" FOR INSERT WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_update ON "cloud_resource_totals" FOR UPDATE USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "cloud_resource_dimensions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cloud_resource_dimensions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "cloud_resource_dimensions";--> statement-breakpoint
DROP POLICY IF EXISTS tenant_read ON "cloud_resource_dimensions";--> statement-breakpoint
DROP POLICY IF EXISTS tenant_append ON "cloud_resource_dimensions";--> statement-breakpoint
DROP POLICY IF EXISTS tenant_update ON "cloud_resource_dimensions";--> statement-breakpoint
DROP POLICY IF EXISTS tenant_retention_delete ON "cloud_resource_dimensions";--> statement-breakpoint
CREATE POLICY tenant_read ON "cloud_resource_dimensions" FOR SELECT USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_append ON "cloud_resource_dimensions" FOR INSERT WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_update ON "cloud_resource_dimensions" FOR UPDATE USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "cloud_resource_reservations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cloud_resource_reservations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "cloud_resource_reservations";--> statement-breakpoint
DROP POLICY IF EXISTS tenant_read ON "cloud_resource_reservations";--> statement-breakpoint
DROP POLICY IF EXISTS tenant_append ON "cloud_resource_reservations";--> statement-breakpoint
DROP POLICY IF EXISTS tenant_update ON "cloud_resource_reservations";--> statement-breakpoint
DROP POLICY IF EXISTS tenant_retention_delete ON "cloud_resource_reservations";--> statement-breakpoint
CREATE POLICY tenant_read ON "cloud_resource_reservations" FOR SELECT USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_append ON "cloud_resource_reservations" FOR INSERT WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_update ON "cloud_resource_reservations" FOR UPDATE USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "cloud_resource_ledger" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cloud_resource_ledger" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "cloud_resource_ledger";--> statement-breakpoint
DROP POLICY IF EXISTS tenant_read ON "cloud_resource_ledger";--> statement-breakpoint
DROP POLICY IF EXISTS tenant_append ON "cloud_resource_ledger";--> statement-breakpoint
DROP POLICY IF EXISTS tenant_update ON "cloud_resource_ledger";--> statement-breakpoint
DROP POLICY IF EXISTS tenant_retention_delete ON "cloud_resource_ledger";--> statement-breakpoint
CREATE POLICY tenant_read ON "cloud_resource_ledger" FOR SELECT USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_append ON "cloud_resource_ledger" FOR INSERT WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "cloud_provider_circuits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cloud_provider_circuits" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "cloud_provider_circuits";--> statement-breakpoint
DROP POLICY IF EXISTS tenant_read ON "cloud_provider_circuits";--> statement-breakpoint
DROP POLICY IF EXISTS tenant_append ON "cloud_provider_circuits";--> statement-breakpoint
DROP POLICY IF EXISTS tenant_update ON "cloud_provider_circuits";--> statement-breakpoint
DROP POLICY IF EXISTS tenant_retention_delete ON "cloud_provider_circuits";--> statement-breakpoint
CREATE POLICY tenant_read ON "cloud_provider_circuits" FOR SELECT USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_append ON "cloud_provider_circuits" FOR INSERT WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_update ON "cloud_provider_circuits" FOR UPDATE USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
