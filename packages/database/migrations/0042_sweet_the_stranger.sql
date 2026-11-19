CREATE TABLE IF NOT EXISTS "deployment_metadata" (
	"id" text PRIMARY KEY NOT NULL,
	"environment" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deployment_metadata" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "deployment_metadata_select_policy" ON "deployment_metadata" FOR SELECT USING (true);--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "credential_profile" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "runner_id" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "revoked_at" bigint;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "revoked_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "device_auth_requests" ADD COLUMN "credential_profile" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "device_auth_requests" ADD COLUMN "runner_id" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_credential_profile_check" CHECK ("credential_profile" IN ('legacy', 'interactive', 'runner', 'public_api'));--> statement-breakpoint
ALTER TABLE "device_auth_requests" ADD CONSTRAINT "device_auth_requests_credential_profile_check" CHECK ("credential_profile" IN ('legacy', 'interactive', 'runner'));--> statement-breakpoint
CREATE INDEX "api_keys_org_runner_idx" ON "api_keys" USING btree ("organization_id","runner_id");
