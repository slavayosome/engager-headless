CREATE TABLE "license_device_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_code_hash" text NOT NULL,
	"user_code" text NOT NULL,
	"client_name" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"user_id" uuid,
	"organization_id" uuid,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"last_polled_at" bigint,
	CONSTRAINT "license_device_requests_device_code_hash_unique" UNIQUE("device_code_hash"),
	CONSTRAINT "license_device_requests_user_code_unique" UNIQUE("user_code"),
	CONSTRAINT "license_device_requests_status_check" CHECK ("license_device_requests"."status" in ('pending', 'approved', 'denied', 'claimed'))
);
--> statement-breakpoint
CREATE TABLE "license_refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid,
	"created_at" bigint NOT NULL,
	"revoked_at" bigint,
	CONSTRAINT "license_refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "license_trial_ends_at" bigint;--> statement-breakpoint
ALTER TABLE "license_device_requests" ADD CONSTRAINT "license_device_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license_refresh_tokens" ADD CONSTRAINT "license_refresh_tokens_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "license_device_requests_expires_at_idx" ON "license_device_requests" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "license_refresh_tokens_org_idx" ON "license_refresh_tokens" USING btree ("organization_id");