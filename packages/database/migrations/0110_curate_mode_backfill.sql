-- The pacing paths read campaigns.mode synchronously (pacingPolicy): a NULL
-- selector fails closed to the capped Review policy, which would silently
-- keep caps/windows/warm-up binding on campaigns that PRESENT as Curate.
-- Backfill NULL rows to exactly what presentedMode() derives today, in its
-- resolution order. One-shot, expand-only: writers stamp the column for
-- every new campaign and never return it to NULL, so reruns match zero rows.
UPDATE "campaigns"
SET "mode" = 'auto'
WHERE "mode" IS NULL
  AND "automation_mode" = 'autopilot';--> statement-breakpoint
UPDATE "campaigns" c
SET "mode" = 'review'
WHERE c."mode" IS NULL
  AND c."automation_mode" = 'draft'
  AND EXISTS (
    SELECT 1
    FROM "api_keys" a
    WHERE a."organization_id" = c."organization_id"
      AND a."credential_profile" = 'runner'
      AND a."authorization_purpose" IN ('scheduled_curate', 'scheduled_review')
      AND a."bound_campaign_id" = c."id"
      AND a."revoked_at" IS NULL
      AND a."expires_at" IS NULL
  );--> statement-breakpoint
UPDATE "campaigns"
SET "mode" = 'curate'
WHERE "mode" IS NULL
  AND "automation_mode" IN ('discover', 'draft');
