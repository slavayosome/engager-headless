ALTER TABLE "discovered_posts" ADD COLUMN "author_headline" text;--> statement-breakpoint
ALTER TABLE "discovered_posts" ADD COLUMN "bet_score" real;--> statement-breakpoint
ALTER TABLE "discovered_posts" ADD COLUMN "bet_breakdown" jsonb;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "bet_score_at_post" real;