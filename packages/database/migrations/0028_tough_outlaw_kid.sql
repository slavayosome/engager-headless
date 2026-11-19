ALTER TABLE "campaigns" ADD COLUMN "drafting_mode" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
-- Backfill heuristic: campaigns with client (MCP submit_batch) drafts in the last
-- 30 days stay agent-led; everything else was worker-drafted → server-led.
-- created_at is epoch milliseconds.
UPDATE "campaigns" SET "drafting_mode" = 'server'
WHERE "id" NOT IN (
  SELECT DISTINCT "campaign_id" FROM "messages"
  WHERE "loop_version" = 'client'
    AND "campaign_id" IS NOT NULL
    AND "created_at" > (extract(epoch from now()) * 1000)::bigint - (30::bigint * 24 * 3600 * 1000)
);