ALTER TABLE "channels" ADD COLUMN "daily_comment_cap" bigint DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "daily_reply_cap" bigint DEFAULT 25 NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "active_hours" jsonb;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "active_days" jsonb;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "min_delay_sec" bigint DEFAULT 40 NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "max_delay_sec" bigint DEFAULT 180 NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "per_profile_day_cap" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "per_profile_week_cap" bigint DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "per_profile_month_cap" bigint DEFAULT 4 NOT NULL;--> statement-breakpoint
-- Hand-written backfill (T-4.5a). Seed each account from the campaign whose
-- numbers already describe it: that org's ACTIVE campaign. This closes the
-- staleness hole at the moment the columns arrive, so T-4.5's flip of
-- consumption inherits fresh values instead of a backfill obligation of its
-- own — between this migration and that flip, the dual-write in
-- `operations/campaigns.ts` keeps them current.
--
-- One active campaign per org is an OPERATIONS-layer guard
-- (`assertNoOtherActiveCampaign`), not a database constraint, so a direct
-- insert can violate it. `DISTINCT ON` with an explicit
-- `updated_at DESC, id DESC` tie-break makes the choice deterministic rather
-- than leaving it to scan order: most recently updated wins, greatest id
-- breaks an exact tie. An org with no active campaign keeps the column
-- defaults above, which are the same defaults `campaigns` carries.
--
-- `channels` and `campaigns` are both RLS-forced with an `app.current_org`
-- policy, so a role without BYPASSRLS copies ZERO rows IN SILENCE — every
-- account would sit on defaults while the campaign row said otherwise, and
-- nothing downstream would report it. migrate.ts runs as the DB owner and
-- refuses the app role; 0127 carries the same guard and this is its twin.
DO $channel_pacing_guard$
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
      'this migration must run as the migration owner: role % cannot bypass row level security and would silently leave every account on the default pacing',
      current_user;
  END IF;
END
$channel_pacing_guard$;--> statement-breakpoint
UPDATE "channels"
   SET "daily_comment_cap" = "src"."daily_comment_cap",
       "daily_reply_cap" = "src"."daily_reply_cap",
       "active_hours" = "src"."active_hours",
       "active_days" = "src"."active_days",
       "min_delay_sec" = "src"."min_delay_sec",
       "max_delay_sec" = "src"."max_delay_sec",
       "per_profile_day_cap" = "src"."per_profile_day_cap",
       "per_profile_week_cap" = "src"."per_profile_week_cap",
       "per_profile_month_cap" = "src"."per_profile_month_cap"
  FROM (
        SELECT DISTINCT ON ("organization_id")
               "organization_id",
               "daily_comment_cap",
               "daily_reply_cap",
               "active_hours",
               "active_days",
               "min_delay_sec",
               "max_delay_sec",
               "per_profile_day_cap",
               "per_profile_week_cap",
               "per_profile_month_cap"
          FROM "campaigns"
         WHERE "status" = 'active'
         ORDER BY "organization_id", "updated_at" DESC, "id" DESC
       ) AS "src"
 WHERE "src"."organization_id" = "channels"."organization_id";