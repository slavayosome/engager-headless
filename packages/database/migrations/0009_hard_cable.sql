ALTER TABLE "messages" ADD COLUMN "brief_source_hash" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "brief_anchor_ids" jsonb;