-- Retired jobs have no remaining handler or producer.
DELETE FROM "jobs" WHERE "type" IN ('check_batch_runway', 'seed_campaign_definitions', 'followup_due', 'import_voice');
-- Posts-search room reads have no reader left; only listening-map rows are read.
DELETE FROM "search_lookalikes" WHERE "target" <> 'listening_map';
