CREATE TABLE "maintenance_receipts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"kind" text NOT NULL,
	"outcome" text NOT NULL,
	"name" text NOT NULL,
	"sha256" text,
	"version" text,
	"schema_hash" text,
	"signature" text,
	"size_bytes" bigint,
	"detail" text,
	"at" bigint NOT NULL,
	CONSTRAINT "maintenance_receipts_name_check" CHECK ("maintenance_receipts"."name" <> '' and ("maintenance_receipts"."size_bytes" is null or "maintenance_receipts"."size_bytes" >= 0))
);
--> statement-breakpoint
CREATE TABLE "supervision_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"component" text NOT NULL,
	"state" text NOT NULL,
	"reason" text NOT NULL,
	"holder_id" text,
	"diagnosis" text,
	"at" bigint NOT NULL,
	CONSTRAINT "supervision_events_component_check" CHECK ("supervision_events"."component" <> '')
);
--> statement-breakpoint
CREATE TABLE "supervision_state" (
	"organization_id" uuid PRIMARY KEY DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"supervisor" text DEFAULT 'self_managed' NOT NULL,
	"holder_id" text,
	"holder_lease_until" bigint,
	"state" text DEFAULT 'stopped' NOT NULL,
	"restart_count" integer DEFAULT 0 NOT NULL,
	"restart_window_started_at" bigint,
	"backoff_until" bigint,
	"healthy_since" bigint,
	"last_diagnosis" text,
	"last_diagnosis_at" bigint,
	"sleeping_since" bigint,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "supervision_state_check" CHECK ("supervision_state"."restart_count" >= 0
        and ("supervision_state"."holder_id" is null) = ("supervision_state"."holder_lease_until" is null)
        and ("supervision_state"."state" <> 'backoff' or "supervision_state"."backoff_until" is not null))
);
--> statement-breakpoint
CREATE TABLE "worker_missed_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"worker_id" bigint NOT NULL,
	"missed_from" bigint NOT NULL,
	"observed_at" bigint NOT NULL,
	"missed_count" integer NOT NULL,
	"cause" text NOT NULL,
	"coalesced_run_at" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "worker_missed_runs_count_check" CHECK ("worker_missed_runs"."missed_count" > 0 and "worker_missed_runs"."observed_at" >= "worker_missed_runs"."missed_from")
);
--> statement-breakpoint
ALTER TABLE "maintenance_receipts" ADD CONSTRAINT "maintenance_receipts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervision_events" ADD CONSTRAINT "supervision_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervision_state" ADD CONSTRAINT "supervision_state_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_missed_runs" ADD CONSTRAINT "worker_missed_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_missed_runs" ADD CONSTRAINT "worker_missed_runs_org_worker_fk" FOREIGN KEY ("organization_id","worker_id") REFERENCES "public"."workers"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "maintenance_receipts_org_kind_at_idx" ON "maintenance_receipts" USING btree ("organization_id","kind","at");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_receipts_org_kind_name_unq" ON "maintenance_receipts" USING btree ("organization_id","kind","name","at");--> statement-breakpoint
CREATE INDEX "supervision_events_org_at_idx" ON "supervision_events" USING btree ("organization_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "worker_missed_runs_worker_wake_unq" ON "worker_missed_runs" USING btree ("organization_id","worker_id","missed_from");

--> statement-breakpoint
-- The four supervision/maintenance tables are TENANT tables: enable + FORCE
-- RLS and install the ordinary `tenant_isolation` policy INSIDE the
-- transaction that creates them, so a restart history or a backup receipt is
-- never readable across orgs for even one statement. They take the ordinary
-- read/write family rather than the hosted-spend one: `supervision_state` and
-- `worker_missed_runs` advance in place, and a retention sweep of old
-- supervision events is an ordinary tenant delete, not an accounting event.
-- `applyRls` re-applies this idempotently on every migrate; this block is what
-- makes the pre-commit firebreak true.
ALTER TABLE "supervision_state" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "supervision_state" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "supervision_state";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_read ON "supervision_state";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_append ON "supervision_state";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_update ON "supervision_state";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_retention_delete ON "supervision_state";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "supervision_state" USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "supervision_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "supervision_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "supervision_events";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_read ON "supervision_events";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_append ON "supervision_events";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_update ON "supervision_events";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_retention_delete ON "supervision_events";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "supervision_events" USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "worker_missed_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "worker_missed_runs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "worker_missed_runs";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_read ON "worker_missed_runs";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_append ON "worker_missed_runs";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_update ON "worker_missed_runs";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_retention_delete ON "worker_missed_runs";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "worker_missed_runs" USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "maintenance_receipts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "maintenance_receipts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "maintenance_receipts";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_read ON "maintenance_receipts";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_append ON "maintenance_receipts";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_update ON "maintenance_receipts";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_retention_delete ON "maintenance_receipts";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "maintenance_receipts" USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
