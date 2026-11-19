CREATE TABLE "tenant_runtimes" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"neon_project_id" text,
	"database_name" text,
	"fly_machine_id" text,
	"region" text,
	"country" text,
	"status" text DEFAULT 'provisioning' NOT NULL,
	"step" text,
	"last_error" text,
	"master_key_ciphertext" text,
	"owner_url_ciphertext" text,
	"app_role_password_ciphertext" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"stopped_at" bigint,
	"retired_at" bigint,
	CONSTRAINT "tenant_runtimes_status_check" CHECK ("tenant_runtimes"."status" in ('provisioning', 'active', 'stopped', 'retired'))
);
--> statement-breakpoint
ALTER TABLE "tenant_runtimes" ADD CONSTRAINT "tenant_runtimes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tenant_runtimes_status_idx" ON "tenant_runtimes" USING btree ("status");