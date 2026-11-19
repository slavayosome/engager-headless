ALTER TABLE "channels" ADD COLUMN "paused_reason" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "paused_until" bigint;