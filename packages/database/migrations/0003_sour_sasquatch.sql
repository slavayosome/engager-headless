CREATE TABLE "credit_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"amount" bigint NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"reason" text,
	"created_at" bigint NOT NULL,
	"settled_at" bigint
);
--> statement-breakpoint
CREATE TABLE "credit_transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"type" text NOT NULL,
	"amount" bigint NOT NULL,
	"reason" text,
	"grant_key" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_wallets" (
	"organization_id" uuid PRIMARY KEY DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"balance" bigint DEFAULT 0 NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"processed_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_wallets" ADD CONSTRAINT "credit_wallets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_reservations_org_status_idx" ON "credit_reservations" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "credit_transactions_org_idx" ON "credit_transactions" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_transactions_grant_key_unq" ON "credit_transactions" USING btree ("grant_key");