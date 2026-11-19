-- 0315 dropped both hosted lane-claim tables but left the trigger that writes them, so every compile_campaign, import_voice and ingest_product claim failed on the missing relation and held the queue behind it.
DROP TRIGGER IF EXISTS "fence_legacy_initial_hosted_lane_claim" ON "jobs";--> statement-breakpoint
DROP FUNCTION IF EXISTS "fence_legacy_initial_hosted_lane_claim"();
