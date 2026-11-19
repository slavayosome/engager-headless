ALTER TABLE "runner_protocol_transitions" ADD COLUMN "authority" text DEFAULT 'legacy_operator' NOT NULL;--> statement-breakpoint
ALTER TABLE "runner_protocol_transitions" ADD COLUMN "evidence" jsonb;
