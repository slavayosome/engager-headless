ALTER TABLE "onboarding_radar_previews" ADD COLUMN "agent_drafts" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "onboarding_radar_responses" ADD COLUMN "assist_retention" real;--> statement-breakpoint
ALTER TABLE "onboarding_radar_responses" ADD COLUMN "assist_draft_revision" integer;