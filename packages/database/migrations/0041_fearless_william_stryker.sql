ALTER TABLE "campaigns" ADD COLUMN "automation_mode" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "discovered_posts" ADD COLUMN "agent_score" real;--> statement-breakpoint
ALTER TABLE "discovered_posts" ADD COLUMN "agent_ranked_at" bigint;--> statement-breakpoint
ALTER TABLE "discovered_posts" ADD COLUMN "agent_rank_reason" text;--> statement-breakpoint
-- Backfill the new automation axis from the stored legacy pair: live+auto campaigns
-- were "auto mode" (now autopilot); everything else (live/manual, hybrid, shadow)
-- collapses to 'draft' — the same mapping campaignMode() has always applied.
-- campaigns is FORCE-RLS; the migration runs as owner, so drop FORCE around the
-- backfill (0033 precedent).
ALTER TABLE "campaigns" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "campaigns" SET "automation_mode" = 'autopilot' WHERE "run_mode" = 'live' AND "approval_mode" = 'auto';--> statement-breakpoint
ALTER TABLE "campaigns" FORCE ROW LEVEL SECURITY;