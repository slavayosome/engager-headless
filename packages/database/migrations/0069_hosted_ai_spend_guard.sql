CREATE TABLE "hosted_ai_spend_budgets" (
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"period_start" bigint NOT NULL,
	"period_end" bigint NOT NULL,
	"limit_usd_micros" bigint NOT NULL,
	"reserved_usd_micros" bigint DEFAULT 0 NOT NULL,
	"spent_usd_micros" bigint DEFAULT 0 NOT NULL,
	"max_calls" integer NOT NULL,
	"call_count" integer DEFAULT 0 NOT NULL,
	"max_concurrency" integer NOT NULL,
	"active_reservations" integer DEFAULT 0 NOT NULL,
	"policy_version" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "hosted_ai_spend_budgets_organization_id_period_start_pk" PRIMARY KEY("organization_id","period_start"),
	CONSTRAINT "hosted_ai_spend_budgets_period_check" CHECK ("hosted_ai_spend_budgets"."period_end" > "hosted_ai_spend_budgets"."period_start"),
	CONSTRAINT "hosted_ai_spend_budgets_counters_check" CHECK ("hosted_ai_spend_budgets"."limit_usd_micros" > 0 and "hosted_ai_spend_budgets"."reserved_usd_micros" >= 0 and "hosted_ai_spend_budgets"."spent_usd_micros" >= 0 and "hosted_ai_spend_budgets"."max_calls" > 0 and "hosted_ai_spend_budgets"."call_count" >= 0 and "hosted_ai_spend_budgets"."max_concurrency" > 0 and "hosted_ai_spend_budgets"."active_reservations" >= 0)
);
--> statement-breakpoint
CREATE TABLE "hosted_ai_spend_dimensions" (
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"period_start" bigint NOT NULL,
	"kind" text NOT NULL,
	"dimension_key" text NOT NULL,
	"reserved_usd_micros" bigint DEFAULT 0 NOT NULL,
	"spent_usd_micros" bigint DEFAULT 0 NOT NULL,
	"max_calls" integer NOT NULL,
	"call_count" integer DEFAULT 0 NOT NULL,
	"max_concurrency" integer NOT NULL,
	"active_reservations" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "hosted_ai_spend_dimensions_organization_id_period_start_kind_dimension_key_pk" PRIMARY KEY("organization_id","period_start","kind","dimension_key"),
	CONSTRAINT "hosted_ai_spend_dimensions_counters_check" CHECK ("hosted_ai_spend_dimensions"."dimension_key" <> '' and "hosted_ai_spend_dimensions"."reserved_usd_micros" >= 0 and "hosted_ai_spend_dimensions"."spent_usd_micros" >= 0 and "hosted_ai_spend_dimensions"."max_calls" > 0 and "hosted_ai_spend_dimensions"."call_count" >= 0 and "hosted_ai_spend_dimensions"."max_concurrency" > 0 and "hosted_ai_spend_dimensions"."active_reservations" >= 0)
);
--> statement-breakpoint
CREATE TABLE "hosted_ai_spend_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"period_start" bigint NOT NULL,
	"reservation_id" uuid,
	"entry_type" text NOT NULL,
	"amount_usd_micros" bigint NOT NULL,
	"metadata" jsonb,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hosted_ai_spend_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"period_start" bigint NOT NULL,
	"idempotency_key" text NOT NULL,
	"lease_token" uuid DEFAULT gen_random_uuid() NOT NULL,
	"credential_key_id" text,
	"request_id" text NOT NULL,
	"request_phase" integer NOT NULL,
	"job_id" bigint,
	"job_lease_token" text,
	"source" text NOT NULL,
	"tool" text NOT NULL,
	"provider" text NOT NULL,
	"operation" text NOT NULL,
	"model" text NOT NULL,
	"input_fingerprint" text NOT NULL,
	"reserved_usd_micros" bigint NOT NULL,
	"actual_usd_micros" bigint,
	"state" text DEFAULT 'reserved' NOT NULL,
	"failure_kind" text,
	"expires_at" bigint NOT NULL,
	"started_at" bigint,
	"settled_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "hosted_ai_spend_reservations_amounts_check" CHECK ("hosted_ai_spend_reservations"."reserved_usd_micros" > 0 and ("hosted_ai_spend_reservations"."actual_usd_micros" is null or "hosted_ai_spend_reservations"."actual_usd_micros" >= 0) and "hosted_ai_spend_reservations"."request_phase" > 0)
);
--> statement-breakpoint
ALTER TABLE "hosted_ai_spend_budgets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hosted_ai_spend_budgets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_read ON "hosted_ai_spend_budgets" FOR SELECT USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_append ON "hosted_ai_spend_budgets" FOR INSERT WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_update ON "hosted_ai_spend_budgets" FOR UPDATE USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "hosted_ai_spend_dimensions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hosted_ai_spend_dimensions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_read ON "hosted_ai_spend_dimensions" FOR SELECT USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_append ON "hosted_ai_spend_dimensions" FOR INSERT WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_update ON "hosted_ai_spend_dimensions" FOR UPDATE USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "hosted_ai_spend_ledger" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hosted_ai_spend_ledger" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_read ON "hosted_ai_spend_ledger" FOR SELECT USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_append ON "hosted_ai_spend_ledger" FOR INSERT WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "hosted_ai_spend_reservations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hosted_ai_spend_reservations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_read ON "hosted_ai_spend_reservations" FOR SELECT USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_append ON "hosted_ai_spend_reservations" FOR INSERT WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_update ON "hosted_ai_spend_reservations" FOR UPDATE USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "credential_key_id" text;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "request_id" text;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "request_phase" integer;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "spend_reservation_id" uuid;--> statement-breakpoint
ALTER TABLE "hosted_ai_spend_budgets" ADD CONSTRAINT "hosted_ai_spend_budgets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosted_ai_spend_dimensions" ADD CONSTRAINT "hosted_ai_spend_dimensions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosted_ai_spend_dimensions" ADD CONSTRAINT "hosted_ai_spend_dimensions_budget_fk" FOREIGN KEY ("organization_id","period_start") REFERENCES "public"."hosted_ai_spend_budgets"("organization_id","period_start") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosted_ai_spend_ledger" ADD CONSTRAINT "hosted_ai_spend_ledger_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosted_ai_spend_ledger" ADD CONSTRAINT "hosted_ai_spend_ledger_reservation_id_hosted_ai_spend_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."hosted_ai_spend_reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosted_ai_spend_reservations" ADD CONSTRAINT "hosted_ai_spend_reservations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosted_ai_spend_reservations" ADD CONSTRAINT "hosted_ai_spend_reservations_budget_fk" FOREIGN KEY ("organization_id","period_start") REFERENCES "public"."hosted_ai_spend_budgets"("organization_id","period_start") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hosted_ai_spend_ledger_reservation_entry_unq" ON "hosted_ai_spend_ledger" USING btree ("reservation_id","entry_type") WHERE "hosted_ai_spend_ledger"."reservation_id" is not null;--> statement-breakpoint
CREATE INDEX "hosted_ai_spend_ledger_org_period_idx" ON "hosted_ai_spend_ledger" USING btree ("organization_id","period_start","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "hosted_ai_spend_reservations_org_idempotency_unq" ON "hosted_ai_spend_reservations" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "hosted_ai_spend_reservations_expiry_idx" ON "hosted_ai_spend_reservations" USING btree ("organization_id","period_start","state","expires_at");--> statement-breakpoint
CREATE INDEX "hosted_ai_spend_reservations_credential_idx" ON "hosted_ai_spend_reservations" USING btree ("organization_id","period_start","credential_key_id");--> statement-breakpoint
CREATE INDEX "ai_usage_spend_reservation_idx" ON "ai_usage" USING btree ("spend_reservation_id");
