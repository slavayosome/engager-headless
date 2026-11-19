CREATE TABLE "lead_backtests" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"campaign_id" bigint NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"window_from" bigint NOT NULL,
	"window_to" bigint NOT NULL,
	"counts" jsonb,
	"error" text,
	"created_at" bigint NOT NULL,
	"finished_at" bigint,
	CONSTRAINT "lead_backtests_values_check" CHECK ("lead_backtests"."status" in ('queued', 'running', 'done', 'failed') and "lead_backtests"."window_from" <= "lead_backtests"."window_to"
        and ("lead_backtests"."status" = 'done') = ("lead_backtests"."counts" is not null)
        and ("lead_backtests"."status" = 'failed') = ("lead_backtests"."error" is not null)
        and ("lead_backtests"."status" in ('done', 'failed')) = ("lead_backtests"."finished_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "lead_backtests" ADD CONSTRAINT "lead_backtests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_backtests" ADD CONSTRAINT "lead_backtests_org_campaign_fk" FOREIGN KEY ("organization_id","campaign_id") REFERENCES "public"."campaigns"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lead_backtests_campaign_idx" ON "lead_backtests" USING btree ("organization_id","campaign_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "lead_backtests_org_campaign_open_key" ON "lead_backtests" USING btree ("organization_id","campaign_id") WHERE status in ('queued', 'running');
--> statement-breakpoint
-- Generated tenant policies from packages/database/rls.ts
ALTER TABLE "lead_backtests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "lead_backtests" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "lead_backtests";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_read ON "lead_backtests";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_append ON "lead_backtests";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_update ON "lead_backtests";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_retention_delete ON "lead_backtests";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "lead_backtests" USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
