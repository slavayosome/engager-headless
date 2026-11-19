CREATE TABLE "device_auth_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_code_hash" text NOT NULL,
	"user_code" text NOT NULL,
	"client_name" text,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"organization_id" uuid,
	"approved_by_user_id" uuid,
	"api_key_id" uuid,
	"token" text,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"claimed_at" bigint,
	CONSTRAINT "device_auth_requests_device_code_hash_unique" UNIQUE("device_code_hash"),
	CONSTRAINT "device_auth_requests_user_code_unique" UNIQUE("user_code")
);
--> statement-breakpoint
ALTER TABLE "device_auth_requests" ADD CONSTRAINT "device_auth_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;