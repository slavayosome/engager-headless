-- Radar Today rate model (founder decision 2026-07-17: fixed rate, no dial):
-- admission is paced to 5 picks per campaign-timezone hour under a hard daily
-- ceiling of 20, so cohort ranks 11..20 become legal. Widen the rank CHECK
-- from 1..10 to 1..20 (drop + re-add in one migration; additive-safe — every
-- existing row already satisfies the wider range). Deploy order is safe by
-- construction: dev CD migrates before promoting the same SHA, so no serving
-- code writes rank > 10 before this constraint is widened.
ALTER TABLE "radar_daily_opportunities" DROP CONSTRAINT "radar_daily_opportunities_rank_check";--> statement-breakpoint
ALTER TABLE "radar_daily_opportunities" ADD CONSTRAINT "radar_daily_opportunities_rank_check" CHECK ("radar_daily_opportunities"."rank" between 1 and 20);
