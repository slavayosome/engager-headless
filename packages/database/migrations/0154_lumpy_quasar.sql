ALTER TABLE "system_state" ADD COLUMN "cloud_paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "system_state" ADD COLUMN "cloud_control_revision" bigint DEFAULT 0 NOT NULL;