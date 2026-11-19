ALTER TABLE "voice_samples" ADD COLUMN "edit_signals" jsonb;--> statement-breakpoint
ALTER TABLE "voices" ADD COLUMN "learned_directives" jsonb;--> statement-breakpoint
ALTER TABLE "voices" ADD COLUMN "disabled_directives" jsonb DEFAULT '[]'::jsonb NOT NULL;