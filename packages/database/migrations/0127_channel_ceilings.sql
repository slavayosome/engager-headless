ALTER TABLE "channels" ADD COLUMN "daily_engage_cap" integer DEFAULT 40 NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "min_action_gap_sec" integer DEFAULT 120 NOT NULL;--> statement-breakpoint
-- Carry each account's ceilings over from the org row that used to hold them.
-- Unlike an attribution backfill this one is EVIDENCED, not constructed: the
-- values exist, they are the numbers the owner set, and copying them is the
-- whole point of the move. The columns above default to 40/120 — the same
-- defaults `organizations` carries — so an org that never touched Settings is
-- unaffected either way, and an org that lowered its cap keeps the lower one
-- instead of being silently widened back to the default.
--
-- `channels` and `organizations` are both RLS-forced with an `app.current_org`
-- policy, so a role without BYPASSRLS copies ZERO rows IN SILENCE — every
-- account would quietly revert to the default ceiling, which is the widening
-- direction. migrate.ts documents this path as the DB owner/superuser and
-- refuses to run as the app role; 0120 and 0124 make the same assumption
-- explicit, and this block is their twin.
DO $channel_ceilings_guard$
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
      'this migration must run as the migration owner: role % cannot bypass row level security and would silently leave every account on the default ceiling',
      current_user;
  END IF;
END
$channel_ceilings_guard$;--> statement-breakpoint
UPDATE "channels"
   SET "daily_engage_cap" = "organizations"."daily_engage_cap",
       "min_action_gap_sec" = "organizations"."min_action_gap_sec"
  FROM "organizations"
 WHERE "organizations"."id" = "channels"."organization_id";
