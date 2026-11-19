CREATE TABLE "runtime_heartbeats" (
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"runtime_id" text NOT NULL,
	"at" bigint NOT NULL,
	CONSTRAINT "runtime_heartbeats_organization_id_runtime_id_pk" PRIMARY KEY("organization_id","runtime_id"),
	CONSTRAINT "runtime_heartbeats_runtime_check" CHECK ("runtime_heartbeats"."runtime_id" <> '' and "runtime_heartbeats"."at" > 0)
);
--> statement-breakpoint
ALTER TABLE "runtime_heartbeats" ADD CONSTRAINT "runtime_heartbeats_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runtime_heartbeats_org_at_idx" ON "runtime_heartbeats" USING btree ("organization_id","at");
--> statement-breakpoint
-- `runtime_heartbeats` is a TENANT table: enable + FORCE RLS and install the
-- ordinary `tenant_isolation` policy INSIDE the transaction that creates it,
-- so one org's liveness is never readable by another for even one statement.
-- The ordinary read/write family, not the append-only one: a beat is rewritten
-- in place on every tick, and a departed runtime's row is an ordinary tenant
-- delete. `applyRls` re-applies this idempotently on every migrate; this block
-- is what makes the pre-commit firebreak true.
ALTER TABLE "runtime_heartbeats" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "runtime_heartbeats" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "runtime_heartbeats";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_read ON "runtime_heartbeats";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_append ON "runtime_heartbeats";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_update ON "runtime_heartbeats";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_retention_delete ON "runtime_heartbeats";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "runtime_heartbeats" USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
