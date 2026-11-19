-- HOW HARD A CAMPAIGN'S SCOUT WORKS before it shows the owner anything. One
-- defaulted column on `campaigns`: `search_depth` stores the Quick (a small,
-- fresh slice) or Standard (how Scout has always worked) chosen for it, with a
-- CHECK every row passes at that default. Deep is never stored: it IS the Find
-- posts step's Research, read from the definition (`readSearchDepth`, core's
-- definition/searchDepth.ts), so a campaign whose Research is on already reads
-- Deep.
-- Expand-only: no existing column, constraint or row moves. Every campaign,
-- existing ones included, stores `standard`.
ALTER TABLE "campaigns" ADD COLUMN "search_depth" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_search_depth_check" CHECK ("campaigns"."search_depth" in ('quick', 'standard'));
