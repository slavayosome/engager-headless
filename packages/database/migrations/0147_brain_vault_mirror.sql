CREATE TABLE "brain_vault_mirror" (
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"relative_path" text NOT NULL,
	"sha256" text NOT NULL,
	"bytes" text NOT NULL,
	"file_mtime_ms" bigint NOT NULL,
	"mirror_version" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "brain_vault_mirror_org_path_key" UNIQUE("organization_id","relative_path")
);
--> statement-breakpoint
ALTER TABLE "brain_state" ADD COLUMN "mirror_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "brain_vault_mirror" ADD CONSTRAINT "brain_vault_mirror_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;-- `brain_vault_mirror` is a tenant table: enable + FORCE RLS and install its
-- isolation policy INSIDE the transaction that creates it, so the owner's own
-- notes are never readable across orgs for even one statement. `applyRls`
-- re-applies this idempotently on every migrate; this block is what makes the
-- pre-commit firebreak true.
ALTER TABLE "brain_vault_mirror" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "brain_vault_mirror" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "brain_vault_mirror"
	USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
