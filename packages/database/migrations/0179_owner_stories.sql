ALTER TABLE "candidate_draft_requests" ADD COLUMN "offered_stories" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "owner_story_id" bigint;