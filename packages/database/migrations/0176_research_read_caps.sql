ALTER TABLE "channels" ADD COLUMN "daily_thread_read_cap" bigint DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "daily_profile_read_cap" bigint DEFAULT 40 NOT NULL;