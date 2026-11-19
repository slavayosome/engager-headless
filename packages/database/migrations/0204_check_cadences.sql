-- HOW OFTEN THE ACCOUNT LOOKS FOR WHAT PEOPLE WROTE BACK. Two defaulted
-- columns on `channels`, beside the pacing numbers they join:
-- `reply_check_base_min` (a fresh comment watch's check cadence, 30-240 min;
-- the older tiers stay 6x and 12x it) and `inbox_check_base_min` (the light
-- inbox check's, 20-240 min). Both are a base the check jitters +-30%.
-- Expand-only: no existing column, constraint or row moves, and every account
-- keeps the cadence it had — replies about hourly, the inbox about every 45
-- minutes.
ALTER TABLE "channels" ADD COLUMN "reply_check_base_min" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "inbox_check_base_min" integer DEFAULT 45 NOT NULL;
