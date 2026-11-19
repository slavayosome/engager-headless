ALTER TABLE "discovery_sources" ADD COLUMN "search_intent" text DEFAULT 'topic' NOT NULL;--> statement-breakpoint
ALTER TABLE "discovery_sources" ADD COLUMN "pain_id" text;--> statement-breakpoint
ALTER TABLE "discovery_sources" ADD COLUMN "display_name" text;