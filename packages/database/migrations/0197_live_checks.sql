-- THE OWNER'S LIVE CHECKS (INV-31). One new table, `live_checks`, with its RLS
-- family installed in this same file: one row per attempt to prove a write
-- surface on one account, a recorded row making that capability available
-- there beside the shipped table. Additive: no existing table, column or
-- constraint moves.
CREATE TABLE "live_checks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"channel_id" bigint NOT NULL,
	"capability" text NOT NULL,
	"state" text NOT NULL,
	"subject" jsonb NOT NULL,
	"read_proof" jsonb,
	"read_confirmed_at" bigint,
	"action_execution_id" bigint,
	"write_proof" jsonb,
	"closed_reason" text,
	"started_by" text NOT NULL,
	"recorded_by" text,
	"recorded_at" bigint,
	"cleared_by" text,
	"cleared_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "live_checks_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "live_checks_values_check" CHECK ("live_checks"."capability" in ('send_invitation', 'accept_invitation', 'send_dm') and "live_checks"."state" in ('reading', 'read', 'writing', 'recorded', 'closed')),
	CONSTRAINT "live_checks_writing_check" CHECK ("live_checks"."state" not in ('writing', 'recorded') or ("live_checks"."action_execution_id" is not null and "live_checks"."read_confirmed_at" is not null)),
	CONSTRAINT "live_checks_recorded_check" CHECK ("live_checks"."state" <> 'recorded' or ("live_checks"."recorded_at" is not null and "live_checks"."recorded_by" is not null and "live_checks"."write_proof" is not null)),
	CONSTRAINT "live_checks_closed_check" CHECK (("live_checks"."state" = 'closed') = ("live_checks"."closed_reason" is not null)),
	CONSTRAINT "live_checks_cleared_check" CHECK (("live_checks"."cleared_at" is null) = ("live_checks"."cleared_by" is null) and ("live_checks"."cleared_at" is null or "live_checks"."recorded_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "live_checks" ADD CONSTRAINT "live_checks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_checks" ADD CONSTRAINT "live_checks_org_channel_fk" FOREIGN KEY ("organization_id","channel_id") REFERENCES "public"."channels"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_checks" ADD CONSTRAINT "live_checks_org_action_fk" FOREIGN KEY ("organization_id","action_execution_id") REFERENCES "public"."action_executions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "live_checks_open_unq" ON "live_checks" USING btree ("organization_id","channel_id","capability") WHERE "live_checks"."state" in ('reading', 'read', 'writing');--> statement-breakpoint
CREATE UNIQUE INDEX "live_checks_recorded_unq" ON "live_checks" USING btree ("organization_id","channel_id","capability") WHERE "live_checks"."state" = 'recorded';--> statement-breakpoint
CREATE UNIQUE INDEX "live_checks_org_action_unq" ON "live_checks" USING btree ("organization_id","action_execution_id") WHERE "live_checks"."action_execution_id" is not null;--> statement-breakpoint
ALTER TABLE "live_checks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "live_checks" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "live_checks"
	USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
