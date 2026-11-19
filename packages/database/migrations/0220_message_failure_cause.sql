ALTER TABLE "messages" ADD COLUMN "error_code" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "last_attempt_at" bigint;