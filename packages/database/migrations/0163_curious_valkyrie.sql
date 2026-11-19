CREATE TABLE "commercial_offer_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"from_subscription_id" text,
	"from_offer_id" text,
	"to_offer_id" text NOT NULL,
	"quote_unit_amount" bigint NOT NULL,
	"quote_currency" text NOT NULL,
	"quote_credit_amount" bigint,
	"quote_expires_at" bigint NOT NULL,
	"quote_subscription_revision" text NOT NULL,
	"status" text DEFAULT 'recorded' NOT NULL,
	"provider_operation_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"applied_subscription_id" text,
	"applied_generation" bigint,
	"last_error" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "license_seats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"device_key_hash" text NOT NULL,
	"label" text,
	"assigned_at" bigint NOT NULL,
	"assigned_by_user_id" uuid,
	"revoked_at" bigint,
	"revoked_by_user_id" uuid,
	"revoked_reason" text,
	"last_seen_at" bigint,
	CONSTRAINT "license_seats_device_key_hash_unique" UNIQUE("device_key_hash"),
	CONSTRAINT "license_seats_revocation_pair_check" CHECK (("license_seats"."revoked_at" is null and "license_seats"."revoked_reason" is null) or ("license_seats"."revoked_at" is not null and "license_seats"."revoked_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "transfer_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"direction" text NOT NULL,
	"side" text NOT NULL,
	"source_placement" text NOT NULL,
	"destination_placement" text NOT NULL,
	"source_runtime_id" text,
	"expected_epoch" bigint,
	"destination_identity" text,
	"state" text DEFAULT 'recorded' NOT NULL,
	"manifest_sha256" text,
	"obligation_summary" jsonb,
	"source_stop_confirmed_at" bigint,
	"activated_epoch" bigint,
	"activated_at" bigint,
	"last_error" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "transfer_intents_activation_pair_check" CHECK (("transfer_intents"."activated_epoch" is null and "transfer_intents"."activated_at" is null) or ("transfer_intents"."activated_epoch" is not null and "transfer_intents"."activated_at" is not null and "transfer_intents"."state" = 'activated'))
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "offer_id" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "offer_terms" jsonb;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "commercial_generation" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "paid_through" bigint;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "revoked_at" bigint;--> statement-breakpoint
ALTER TABLE "commercial_offer_intents" ADD CONSTRAINT "commercial_offer_intents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license_seats" ADD CONSTRAINT "license_seats_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_intents" ADD CONSTRAINT "transfer_intents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commercial_offer_intents_org_idx" ON "commercial_offer_intents" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commercial_offer_intents_open_org_unq" ON "commercial_offer_intents" USING btree ("organization_id") WHERE "commercial_offer_intents"."status" in ('recorded', 'dispatched');--> statement-breakpoint
CREATE UNIQUE INDEX "commercial_offer_intents_operation_unq" ON "commercial_offer_intents" USING btree ("provider_operation_id");--> statement-breakpoint
CREATE INDEX "license_seats_org_idx" ON "license_seats" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "license_seats_active_org_idx" ON "license_seats" USING btree ("organization_id") WHERE "license_seats"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "transfer_intents_org_state_idx" ON "transfer_intents" USING btree ("organization_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "transfer_intents_open_org_side_unq" ON "transfer_intents" USING btree ("organization_id","side") WHERE "transfer_intents"."state" not in ('activated', 'abandoned');
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE "license_seats", "commercial_offer_intents", "transfer_intents" FROM engager_app;
