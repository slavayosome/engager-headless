CREATE TABLE "email_delivery_receipts" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"job_id" bigint,
	"kind" text NOT NULL,
	"delivery_key" text NOT NULL,
	"provider_idempotency_key" text NOT NULL,
	"payload_hash" text NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"provider_message_id" text,
	"last_error" text,
	"first_attempt_at" bigint,
	"last_attempt_at" bigint,
	"sent_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_delivery_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "email_delivery_receipts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_read ON "email_delivery_receipts" FOR SELECT USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_append ON "email_delivery_receipts" FOR INSERT WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_update ON "email_delivery_receipts" FOR UPDATE USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "email_delivery_receipts" ADD CONSTRAINT "email_delivery_receipts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_delivery_receipts_org_delivery_unq" ON "email_delivery_receipts" USING btree ("organization_id","kind","delivery_key");--> statement-breakpoint
CREATE UNIQUE INDEX "email_delivery_receipts_provider_key_unq" ON "email_delivery_receipts" USING btree ("provider_idempotency_key");--> statement-breakpoint
CREATE INDEX "email_delivery_receipts_org_state_idx" ON "email_delivery_receipts" USING btree ("organization_id","state","updated_at");
