ALTER TABLE "campaigns" ADD COLUMN "diversity_structural_threshold" real DEFAULT 0.45 NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "style_directives" jsonb;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "structural_novelty" real;--> statement-breakpoint
ALTER TABLE "profile" ADD COLUMN "voice_structural_range" jsonb;