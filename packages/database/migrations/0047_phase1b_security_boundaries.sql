CREATE TABLE "billing_checkout_claims" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"claim_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"interval" text NOT NULL,
	"price_id" text NOT NULL,
	"billing_customer_id" text NOT NULL,
	"trial_days" integer,
	"success_url" text NOT NULL,
	"cancel_url" text NOT NULL,
	"status" text DEFAULT 'creating' NOT NULL,
	"checkout_session_id" text,
	"checkout_url" text,
	"lease_expires_at" bigint NOT NULL,
	"checkout_expires_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "billing_checkout_claims_claim_id_unique" UNIQUE("claim_id")
);
--> statement-breakpoint
CREATE TABLE "unipile_connection_intents" (
	"organization_id" uuid PRIMARY KEY DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"nonce_hash" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"consumed_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_checkout_claims" ADD CONSTRAINT "billing_checkout_claims_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unipile_connection_intents" ADD CONSTRAINT "unipile_connection_intents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unipile_connection_intents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "unipile_connection_intents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "unipile_connection_intents"
	USING ("organization_id" = nullif(current_setting('app.current_org', true), '')::uuid)
	WITH CHECK ("organization_id" = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "device_auth_requests" ADD COLUMN "last_polled_at" bigint;--> statement-breakpoint
CREATE INDEX "device_auth_requests_expires_at_idx" ON "device_auth_requests" USING btree ("expires_at");--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "subscriptions"
    WHERE "active" = true
    GROUP BY "organization_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'billing subscription ownership cutover blocked: multiple active subscriptions exist for an organization';
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_active_org_uidx" ON "subscriptions" USING btree ("organization_id") WHERE "subscriptions"."active" = true;
