ALTER TABLE "author_profiles" ADD COLUMN "relationship" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "author_profiles" ADD COLUMN "relationship_checked_at" bigint;--> statement-breakpoint
ALTER TABLE "author_profiles" ADD COLUMN "identity_evidence" jsonb;--> statement-breakpoint
ALTER TABLE "author_profiles" ADD CONSTRAINT "author_profiles_relationship_check" CHECK ("author_profiles"."relationship" in ('unknown', 'not_connected', 'outgoing_pending', 'incoming_pending', 'connected'));