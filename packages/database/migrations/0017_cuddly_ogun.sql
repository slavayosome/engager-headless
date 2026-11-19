ALTER TABLE "organizations" ADD COLUMN "daily_engage_cap" integer DEFAULT 40 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "min_action_gap_sec" integer DEFAULT 120 NOT NULL;