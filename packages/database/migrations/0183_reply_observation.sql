ALTER TABLE "incoming_comments" ADD COLUMN "text_hash" text;--> statement-breakpoint
ALTER TABLE "incoming_comments" ADD COLUMN "text_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "incoming_comments" ADD COLUMN "removed_at" bigint;