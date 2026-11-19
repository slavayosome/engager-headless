CREATE TABLE "leads" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"profile_id" text NOT NULL,
	"name" text,
	"headline" text,
	"followers" bigint,
	"tier" text DEFAULT 'watch' NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"intent_level" text DEFAULT 'none' NOT NULL,
	"evidence_quote" text,
	"trigger_incoming_comment_id" bigint,
	"touch_count" integer DEFAULT 1 NOT NULL,
	"tier_reasons" jsonb,
	"dm_draft" text,
	"dm_drafted_at" bigint,
	"notified_at" bigint,
	"nudged_at" bigint,
	"last_signal_at" bigint NOT NULL,
	"status_changed_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "incoming_comments" ADD COLUMN "intent" text;--> statement-breakpoint
ALTER TABLE "incoming_comments" ADD COLUMN "intent_evidence" text;--> statement-breakpoint
ALTER TABLE "incoming_comments" ADD COLUMN "classified_at" bigint;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_trigger_incoming_comment_id_incoming_comments_id_fk" FOREIGN KEY ("trigger_incoming_comment_id") REFERENCES "public"."incoming_comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "leads_org_profile_unq" ON "leads" USING btree ("organization_id","profile_id");--> statement-breakpoint
CREATE INDEX "leads_org_tier_status_idx" ON "leads" USING btree ("organization_id","tier","status");