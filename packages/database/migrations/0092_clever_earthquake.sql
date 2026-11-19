CREATE TABLE "oauth_authorization_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_hash" text NOT NULL,
	"client_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"code_challenge_method" text DEFAULT 'S256' NOT NULL,
	"resource" text,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"consumed_at" bigint,
	CONSTRAINT "oauth_authorization_codes_code_hash_unique" UNIQUE("code_hash"),
	CONSTRAINT "oauth_authorization_codes_expiry_check" CHECK ("oauth_authorization_codes"."expires_at" > "oauth_authorization_codes"."created_at")
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"client_name" text,
	"redirect_uris" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"token_endpoint_auth_method" text DEFAULT 'none' NOT NULL,
	"grant_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	"last_used_at" bigint,
	CONSTRAINT "oauth_clients_client_id_unique" UNIQUE("client_id"),
	CONSTRAINT "oauth_clients_redirect_uris_check" CHECK (jsonb_typeof("oauth_clients"."redirect_uris") = 'array')
);
--> statement-breakpoint
CREATE TABLE "oauth_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"api_key_id" uuid NOT NULL,
	"authorization_code_id" uuid,
	"refresh_token_hash" text NOT NULL,
	"previous_refresh_token_hash" text,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resource" text,
	"created_at" bigint NOT NULL,
	"last_refreshed_at" bigint,
	"expires_at" bigint NOT NULL,
	"revoked_at" bigint,
	CONSTRAINT "oauth_grants_api_key_id_unique" UNIQUE("api_key_id"),
	CONSTRAINT "oauth_grants_refresh_token_hash_unique" UNIQUE("refresh_token_hash"),
	CONSTRAINT "oauth_grants_expiry_check" CHECK ("oauth_grants"."expires_at" > "oauth_grants"."created_at")
);
--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_authorization_code_id_oauth_authorization_codes_id_fk" FOREIGN KEY ("authorization_code_id") REFERENCES "public"."oauth_authorization_codes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_authorization_codes_expires_at_idx" ON "oauth_authorization_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_grants_user_org_idx" ON "oauth_grants" USING btree ("user_id","organization_id");--> statement-breakpoint
CREATE INDEX "oauth_grants_expires_at_idx" ON "oauth_grants" USING btree ("expires_at");