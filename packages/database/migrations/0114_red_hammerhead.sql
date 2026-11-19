ALTER TABLE "system_state" ADD COLUMN "linkedin_session_ok_at" bigint;--> statement-breakpoint
ALTER TABLE "system_state" ADD COLUMN "linkedin_session_checked_at" bigint;--> statement-breakpoint
ALTER TABLE "system_state" ADD COLUMN "linkedin_session_reason" text;