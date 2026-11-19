ALTER TABLE "automations" DROP CONSTRAINT "automations_cadence_floor_check";--> statement-breakpoint
ALTER TABLE "automations" DROP CONSTRAINT "automations_per_run_limits_check";--> statement-breakpoint
ALTER TABLE "automations" DROP COLUMN "sweep_interval_minutes";--> statement-breakpoint
ALTER TABLE "automations" DROP COLUMN "max_triage_per_run";--> statement-breakpoint
ALTER TABLE "automations" DROP COLUMN "max_drafts_per_run";--> statement-breakpoint
ALTER TABLE "automations" DROP COLUMN "max_publishes_per_run";