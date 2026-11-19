-- Contract migration: worker_runs keeps only the counters the server still
-- writes. The Find posts counters (found, judged, matched, the four verify
-- counts, rounds) lost their writers with Find posts, and the conversation
-- sums (conversations served, turns, tool calls, drafts) are now counted over
-- step_runs, step_tool_calls and messages when a run is read. The frozen
-- conversation ids stay: they are the server's selection at the run's birth.
--
-- step_runs gains iterations_by_run, the turns each run spent on a checkpoint,
-- so a checkpoint a later wake adopts keeps who spent which. Existing
-- checkpoints are credited whole to the run that holds them.
--
-- DESTRUCTIVE. A bare drizzle `.select()` names every declared column, so a
-- build from before this change takes 42703 on `worker_runs` reads once it is
-- applied; the app migrates immediately before it starts the matching build.
-- The stored values of the dropped counters are not carried.
DO $$ BEGIN
  IF current_setting('is_superuser') <> 'on' AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolbypassrls) THEN
    RAISE EXCEPTION 'Contract migration requires a role with BYPASSRLS';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "step_runs" ADD COLUMN "iterations_by_run" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "step_runs" SET "iterations_by_run" = jsonb_build_object("run_id"::text, "iterations") WHERE "iterations" > 0;--> statement-breakpoint
ALTER TABLE "worker_runs" DROP CONSTRAINT "worker_runs_verify_counts_check";--> statement-breakpoint
ALTER TABLE "worker_runs" DROP CONSTRAINT "worker_runs_verify_for_owner_count_check";--> statement-breakpoint
ALTER TABLE "worker_runs" DROP CONSTRAINT "worker_runs_step_counts_check";--> statement-breakpoint
ALTER TABLE "worker_runs" DROP CONSTRAINT "worker_runs_counts_check";--> statement-breakpoint
ALTER TABLE "worker_runs" DROP COLUMN "discovered_count";--> statement-breakpoint
ALTER TABLE "worker_runs" DROP COLUMN "triaged_count";--> statement-breakpoint
ALTER TABLE "worker_runs" DROP COLUMN "matched_count";--> statement-breakpoint
ALTER TABLE "worker_runs" DROP COLUMN "verified_count";--> statement-breakpoint
ALTER TABLE "worker_runs" DROP COLUMN "verify_for_owner_count";--> statement-breakpoint
ALTER TABLE "worker_runs" DROP COLUMN "verify_rejected_count";--> statement-breakpoint
ALTER TABLE "worker_runs" DROP COLUMN "verify_cap_refused_count";--> statement-breakpoint
ALTER TABLE "worker_runs" DROP COLUMN "rounds_count";--> statement-breakpoint
ALTER TABLE "worker_runs" DROP COLUMN "conversations_selected_count";--> statement-breakpoint
ALTER TABLE "worker_runs" DROP COLUMN "iterations_count";--> statement-breakpoint
ALTER TABLE "worker_runs" DROP COLUMN "tool_calls_dispatched_count";--> statement-breakpoint
ALTER TABLE "worker_runs" DROP COLUMN "tool_calls_discarded_count";--> statement-breakpoint
ALTER TABLE "worker_runs" DROP COLUMN "step_drafted_count";--> statement-breakpoint
ALTER TABLE "worker_runs" ADD CONSTRAINT "worker_runs_counts_check" CHECK ("worker_runs"."demand_count" >= 0 and "worker_runs"."drafted_count" >= 0 and "worker_runs"."published_count" >= 0 and "worker_runs"."rejected_count" >= 0 and "worker_runs"."cap_refused_count" >= 0);