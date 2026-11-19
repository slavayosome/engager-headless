-- ONE PRESS, ONE ANSWER; A MISS THE OWNER HAS READ. Two nullable columns:
-- `automation_runs.press_id` groups the runs one campaign Run now enqueued, so
-- the campaign can say what the press did as one line, and
-- `worker_missed_runs.dismissed_at` records the owner dismissing a missed run
-- from the alert. Expand-only: nothing existing moves, and NULL in either is
-- what every row already had.
ALTER TABLE "automation_runs" ADD COLUMN "press_id" text;--> statement-breakpoint
ALTER TABLE "worker_missed_runs" ADD COLUMN "dismissed_at" bigint;
