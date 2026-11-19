ALTER TABLE "candidate_draft_requests" ADD COLUMN "owner_words" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "owner_origin" real;--> statement-breakpoint
ALTER TABLE "onboarding_radar_responses" ADD COLUMN "owner_origin" real;