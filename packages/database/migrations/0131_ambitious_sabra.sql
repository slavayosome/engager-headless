-- The org's context-epoch trigger still watches the two ceilings below in its
-- `UPDATE OF` list, and Postgres refuses to drop a column a trigger depends on.
-- `installTriggers` runs after every migration and re-creates this one narrowed
-- to `own_post_replies`, so dropping it here is the whole handoff — the epoch
-- keeps bumping from the channel's own watch, which T-4.5b added for this.
DROP TRIGGER IF EXISTS "organizations_runner_context_epoch" ON "organizations";--> statement-breakpoint
ALTER TABLE "campaigns" DROP COLUMN "hourly_comment_cap";--> statement-breakpoint
ALTER TABLE "campaigns" DROP COLUMN "daily_comment_cap";--> statement-breakpoint
ALTER TABLE "campaigns" DROP COLUMN "per_profile_day_cap";--> statement-breakpoint
ALTER TABLE "campaigns" DROP COLUMN "per_profile_week_cap";--> statement-breakpoint
ALTER TABLE "campaigns" DROP COLUMN "per_profile_month_cap";--> statement-breakpoint
ALTER TABLE "campaigns" DROP COLUMN "daily_reply_cap";--> statement-breakpoint
ALTER TABLE "campaigns" DROP COLUMN "active_hours";--> statement-breakpoint
ALTER TABLE "campaigns" DROP COLUMN "active_days";--> statement-breakpoint
ALTER TABLE "campaigns" DROP COLUMN "min_delay_sec";--> statement-breakpoint
ALTER TABLE "campaigns" DROP COLUMN "max_delay_sec";--> statement-breakpoint
ALTER TABLE "campaigns" DROP COLUMN "warmup_weeks";--> statement-breakpoint
ALTER TABLE "campaigns" DROP COLUMN "warmup_started_at";--> statement-breakpoint
ALTER TABLE "campaigns" DROP COLUMN "warmup_start_rate";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "daily_engage_cap";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "min_action_gap_sec";--> statement-breakpoint
ALTER TABLE "profile" DROP COLUMN "display_name";--> statement-breakpoint
ALTER TABLE "system_state" DROP COLUMN "paused_reason";--> statement-breakpoint
ALTER TABLE "system_state" DROP COLUMN "paused_until";--> statement-breakpoint
ALTER TABLE "system_state" DROP COLUMN "linkedin_session_ok_at";--> statement-breakpoint
ALTER TABLE "system_state" DROP COLUMN "linkedin_session_checked_at";--> statement-breakpoint
ALTER TABLE "system_state" DROP COLUMN "linkedin_session_reason";