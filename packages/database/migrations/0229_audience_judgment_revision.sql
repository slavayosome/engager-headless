ALTER TABLE "candidate_research" ADD COLUMN "audience_revision" integer;--> statement-breakpoint
ALTER TABLE "discovered_posts" ADD COLUMN "verify_audience_revision" integer DEFAULT 0 NOT NULL;