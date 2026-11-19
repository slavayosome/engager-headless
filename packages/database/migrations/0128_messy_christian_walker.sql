ALTER TABLE "channels" ADD COLUMN "warmup_weeks" bigint DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "warmup_started_at" bigint;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "warmup_start_rate" bigint;--> statement-breakpoint
-- Carry the account's ramp over from the campaign row that used to hold it.
--
-- The readers repoint in THIS landing, so without the backfill every warmed
-- account restarts at the column defaults: `warmup_started_at` null reads as
-- "no ramp running", which does not under-cap — it UNCAPS, handing a
-- mid-ramp account its full daily cap on the day this deploys. That is the
-- widening direction, which is why this runs with the columns.
--
-- WHICH campaign: the org's single `status='active'` row, falling back to the
-- most recently created campaign when none is active. The pick is singular BY
-- CONSTRUCTION, not by evidence — the operations layer still refuses a second
-- active campaign (that policy outlives this phase; only its compensating send
-- gate refusal is removed), so at this instant "the active campaign" names one
-- row rather than a choice. Once the policy lifts, an account will legitimately
-- have several targets and there will be nothing to re-derive this from: the
-- ramp is the ACCOUNT's from here on, and per-campaign clocks stop being
-- written. Correct today, permanently unverifiable later — the same footing
-- 0124 states for ledger attribution.
--
-- `warmup_started_at` is the anchor and moves as-is; a null anchor stays null,
-- because an account that never armed unattended publishing has no ramp
-- running and must not acquire one from a migration.
--
-- `channels` and `campaigns` are both RLS-forced with an `app.current_org`
-- policy, so a role without BYPASSRLS copies ZERO rows IN SILENCE. Same guard,
-- same reason, as 0120, 0124 and 0127.
DO $channel_warmup_guard$
BEGIN
  IF current_setting('is_superuser') <> 'on'
     AND NOT EXISTS (
       SELECT 1
       FROM pg_roles r
       WHERE (r.rolsuper OR r.rolbypassrls)
         AND pg_has_role(current_user, r.oid, 'USAGE')
     )
  THEN
    RAISE EXCEPTION
      'this migration must run as the migration owner: role % cannot bypass row level security and would silently leave every warmed account with no ramp',
      current_user;
  END IF;
END
$channel_warmup_guard$;--> statement-breakpoint
UPDATE "channels"
   SET "warmup_weeks" = "source"."warmup_weeks",
       "warmup_started_at" = "source"."warmup_started_at",
       "warmup_start_rate" = "source"."warmup_start_rate"
  FROM (
    SELECT DISTINCT ON ("organization_id")
           "organization_id",
           "warmup_weeks",
           "warmup_started_at",
           "warmup_start_rate"
      FROM "campaigns"
     ORDER BY "organization_id",
              ("status" = 'active') DESC,
              "created_at" DESC,
              "id" DESC
  ) AS "source"
 WHERE "source"."organization_id" = "channels"."organization_id";
