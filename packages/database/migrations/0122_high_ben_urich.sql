-- Requires PostgreSQL 15+: UNIQUE ... NULLS NOT DISTINCT is 15 syntax, and this
-- is the first use of it in the schema. migrate.ts refuses an older server up
-- front rather than letting it fail here on `syntax error at or near "NULLS"`.
CREATE TABLE "channels" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"network" text DEFAULT 'linkedin' NOT NULL,
	"external_account_id" text,
	"connector" text DEFAULT 'local_browser' NOT NULL,
	"display_name" text,
	"verified_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "channels_org_network_account_key" UNIQUE NULLS NOT DISTINCT("organization_id","network","external_account_id"),
	CONSTRAINT "channels_org_id_key" UNIQUE("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Every org has a channel row from this migration on. One identity-less row per
-- existing org, written while the tenant policy below does not yet bind. The
-- NULLS NOT DISTINCT key is exactly what makes a re-run collide instead of
-- duplicating, so this statement is idempotent. `created_at`/`updated_at` are
-- app-defaulted columns with no DB default, hence the explicit clock.
INSERT INTO "channels" ("organization_id", "created_at", "updated_at")
SELECT "id",
	(extract(epoch FROM clock_timestamp()) * 1000)::bigint,
	(extract(epoch FROM clock_timestamp()) * 1000)::bigint
FROM "organizations"
ON CONFLICT ON CONSTRAINT "channels_org_network_account_key" DO NOTHING;
--> statement-breakpoint
ALTER TABLE "channels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "channels" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "channels"
	USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
