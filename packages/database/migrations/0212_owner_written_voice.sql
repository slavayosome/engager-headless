-- A VOICE LEARNS ONLY FROM WHAT ITS OWNER WROTE. Every saved comment used to
-- calibrate the voice, an agent draft the owner approved almost unchanged
-- included, so a voice that drafted its comments learned its own style back:
-- the calibration counted the approvals, and a register observed on drafts
-- that all closed on a question became the voice's "encouraged" closer.
-- Calibration now reads only the samples the owner wrote most of the words of
-- (`ownerAuthoredSample`, packages/core/voice.ts: assist retention under 0.5,
-- owner origin at least 0.5, or no draft offered at all).
--
-- A voice taught from an approval is recounted once, here. It was taught from
-- one when a recalibration consumed an approved sample, or when the first-run
-- calibration (`calibrateVoice`, which consumes no sample) read an approved
-- response: an active comment response of a preview calibrated into it.
--   * its calibration sample count is the owner-written evidence it has — its
--     owner-written samples, or the owner-written comments of one first-run
--     preview where those are more (they reach the samples only lazily) —
--     and a voice whose own words number fewer than two is provisional again;
--   * its samples lose their calibration watermark, so the owner-written ones
--     are the new evidence the next calibration reads — the owner's agent, or
--     the hosted fallback after its grace — and the persona and house style
--     are relearned from the owner's words; an approval's watermark would be
--     read by nothing again;
--   * a closer policy of "encouraged" goes back to inherit (natural) where the
--     first snapshot to carry it was a calibration's, never a hand edit.
--
-- Expand-only: no column is added or removed; only `voices.style_rules`,
-- `calibration_sample_count`, `maturity`, `revision`, `updated_at` and
-- `voice_samples.used_in_voice_revision` move. A voice moves only where its
-- recount differs from what it holds, so a second pass or a fresh database
-- matches nothing.
WITH "tainted" AS (
  SELECT "voices"."id", "voices"."organization_id", "voices"."is_default"
    FROM "voices"
    JOIN "voice_samples"
      ON "voice_samples"."organization_id" = "voices"."organization_id"
     AND ("voice_samples"."voice_id" = "voices"."id"
          OR ("voice_samples"."voice_id" IS NULL AND "voices"."is_default"))
   WHERE "voice_samples"."used_in_voice_revision" IS NOT NULL
     AND "voice_samples"."eligible"
     AND "voice_samples"."disowned_at" IS NULL
     AND "voice_samples"."assist_retention" >= 0.5
     AND coalesce("voice_samples"."owner_origin", 0) < 0.5
  UNION
  SELECT "voices"."id", "voices"."organization_id", "voices"."is_default"
    FROM "voices"
    JOIN "onboarding_radar_previews"
      ON "onboarding_radar_previews"."organization_id" = "voices"."organization_id"
     AND "onboarding_radar_previews"."voice_id" = "voices"."id"
    JOIN "onboarding_radar_responses"
      ON "onboarding_radar_responses"."organization_id" = "onboarding_radar_previews"."organization_id"
     AND "onboarding_radar_responses"."preview_id" = "onboarding_radar_previews"."id"
   WHERE "onboarding_radar_previews"."calibration_status" IN ('calibrated', 'provisional')
     AND "onboarding_radar_responses"."revision" <= "onboarding_radar_previews"."response_revision"
     AND "onboarding_radar_responses"."superseded_at" IS NULL
     AND "onboarding_radar_responses"."action" = 'comment'
     AND "onboarding_radar_responses"."comment_text" IS NOT NULL
     AND "onboarding_radar_responses"."assist_retention" >= 0.5
     AND coalesce("onboarding_radar_responses"."owner_origin", 0) < 0.5
), "owner_written" AS (
  SELECT "tainted"."id",
         greatest(
           (SELECT count(*)
              FROM "voice_samples"
             WHERE "voice_samples"."organization_id" = "tainted"."organization_id"
               AND ("voice_samples"."voice_id" = "tainted"."id"
                    OR ("voice_samples"."voice_id" IS NULL AND "tainted"."is_default"))
               AND "voice_samples"."eligible"
               AND "voice_samples"."disowned_at" IS NULL
               AND ("voice_samples"."assist_retention" IS NULL
                    OR "voice_samples"."assist_retention" < 0.5
                    OR "voice_samples"."owner_origin" >= 0.5)),
           (SELECT coalesce(max("per_preview"."n"), 0)
              FROM (SELECT count(*) AS "n"
                      FROM "onboarding_radar_previews"
                      JOIN "onboarding_radar_responses"
                        ON "onboarding_radar_responses"."organization_id" = "onboarding_radar_previews"."organization_id"
                       AND "onboarding_radar_responses"."preview_id" = "onboarding_radar_previews"."id"
                     WHERE "onboarding_radar_previews"."organization_id" = "tainted"."organization_id"
                       AND "onboarding_radar_previews"."voice_id" = "tainted"."id"
                       AND "onboarding_radar_responses"."revision" <= "onboarding_radar_previews"."response_revision"
                       AND "onboarding_radar_responses"."superseded_at" IS NULL
                       AND "onboarding_radar_responses"."action" = 'comment'
                       AND "onboarding_radar_responses"."comment_text" IS NOT NULL
                       AND ("onboarding_radar_responses"."assist_retention" IS NULL
                            OR "onboarding_radar_responses"."assist_retention" < 0.5
                            OR "onboarding_radar_responses"."owner_origin" >= 0.5)
                     GROUP BY "onboarding_radar_previews"."id") AS "per_preview")
         )::int AS "n"
    FROM "tainted"
), "recount" AS (
  SELECT "voices"."id",
         "owner_written"."n",
         CASE
           WHEN "voices"."maturity" = 'calibrated' AND "owner_written"."n" < 2 THEN 'provisional'
           ELSE "voices"."maturity"
         END AS "maturity",
         CASE
           WHEN "voices"."style_rules"->>'closerQuestionPolicy' = 'encouraged'
            AND EXISTS (
              SELECT 1 FROM "voice_revisions" AS "first"
               WHERE "first"."organization_id" = "voices"."organization_id"
                 AND "first"."voice_id" = "voices"."id"
                 AND "first"."source" <> 'manual'
                 AND "first"."style_rules"->>'closerQuestionPolicy' = 'encouraged'
                 AND NOT EXISTS (
                   SELECT 1 FROM "voice_revisions" AS "earlier"
                    WHERE "earlier"."organization_id" = "first"."organization_id"
                      AND "earlier"."voice_id" = "first"."voice_id"
                      AND "earlier"."revision" < "first"."revision"
                      AND "earlier"."style_rules"->>'closerQuestionPolicy' = 'encouraged'))
           THEN jsonb_set("voices"."style_rules", '{closerQuestionPolicy}', 'null'::jsonb)
           ELSE "voices"."style_rules"
         END AS "style_rules"
    FROM "voices"
    JOIN "owner_written" ON "owner_written"."id" = "voices"."id"
), "unconsumed" AS (
  UPDATE "voice_samples"
     SET "used_in_voice_revision" = NULL
    FROM "tainted"
   WHERE "voice_samples"."organization_id" = "tainted"."organization_id"
     AND ("voice_samples"."voice_id" = "tainted"."id"
          OR ("voice_samples"."voice_id" IS NULL AND "tainted"."is_default"))
     AND "voice_samples"."used_in_voice_revision" IS NOT NULL
)
UPDATE "voices"
   SET "calibration_sample_count" = "recount"."n",
       "maturity" = "recount"."maturity",
       "style_rules" = "recount"."style_rules",
       "revision" = "voices"."revision" + 1,
       "updated_at" = (extract(epoch from now())*1000)::bigint
  FROM "recount"
 WHERE "voices"."id" = "recount"."id"
   AND ("voices"."calibration_sample_count" IS DISTINCT FROM "recount"."n"
        OR "voices"."maturity" IS DISTINCT FROM "recount"."maturity"
        OR "voices"."style_rules" IS DISTINCT FROM "recount"."style_rules");
