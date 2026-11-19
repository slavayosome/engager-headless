-- WHO PAUSED IT, AND WHEN. A campaign row says when its status last changed
-- and who changed it — the owner in Engager, their agent over MCP, or Engager
-- itself — so the Campaigns list and Overview can say "Paused by you
-- yesterday 22:47" rather than only "Paused". Written with every status
-- change from here on (`setCampaignStatusOp`).
--
-- Expand-only: two nullable columns, no backfill. A row whose status has not
-- changed since reads as Paused with no who or when.
ALTER TABLE "campaigns" ADD COLUMN "status_changed_at" bigint;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "status_changed_by" text;
