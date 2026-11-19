ALTER TABLE "messages" ADD COLUMN "publish_origin" text DEFAULT 'automation' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_publish_origin_check" CHECK ("messages"."publish_origin" in ('owner','automation'));--> statement-breakpoint
-- Backfill: freeze today's pacingPolicy verdict onto each existing row.
--
-- `pacingPolicy` used to read the CAMPAIGN's stored mode, where 'curate' meant
-- "fully manual, every send had a human act behind it" — and in Curate the only
-- path to an approved message IS the owner's own save (bulk agent intake is
-- refused there). So a message on a curate campaign is exactly an owner-authored
-- send, and everything else keeps the paced policy it already had.
--
-- The column default ('automation') covers every other row, so this expand
-- changes no send's verdict: it only moves WHERE that verdict is read from.
UPDATE "messages" SET "publish_origin" = 'owner'
WHERE "campaign_id" IN (SELECT "id" FROM "campaigns" WHERE "mode" = 'curate');
