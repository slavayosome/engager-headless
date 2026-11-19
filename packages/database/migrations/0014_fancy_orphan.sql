CREATE TABLE "onboarding_previews" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"campaign_id" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"match_count" integer DEFAULT 0 NOT NULL,
	"drafts" jsonb,
	"error" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "onboarding_step" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "onboarding_completed_at" bigint;--> statement-breakpoint
ALTER TABLE "onboarding_previews" ADD CONSTRAINT "onboarding_previews_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_previews" ADD CONSTRAINT "onboarding_previews_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "onboarding_previews_org_idx" ON "onboarding_previews" USING btree ("organization_id");