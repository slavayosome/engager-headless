-- The hosted browser and the cloud resource ledger are gone: Browser Use cloud,
-- the fleet permit queue, and the two spend ledgers nothing writes any more.
-- Local installs hold no rows in any of them; the cloud database's rows have
-- been idle since the fleet stopped.
--
-- The guard fails closed: a channel still bound to `hosted_browser` has a
-- browser the product can no longer reach, so the migration refuses rather than
-- strand it. Each org is entered in turn because `channels` is under forced RLS.
DO $$
DECLARE
  org uuid;
  held integer;
BEGIN
  FOR org IN SELECT id FROM organizations LOOP
    PERFORM set_config('app.current_org', org::text, true);
    SELECT count(*) INTO held FROM channels WHERE connector = 'hosted_browser';
    IF held > 0 THEN
      RAISE EXCEPTION 'organization % still has a hosted_browser channel', org;
    END IF;
  END LOOP;
  PERFORM set_config('app.current_org', '', true);
END
$$;--> statement-breakpoint
-- The two job types that only a hosted_browser channel ever enqueued: the
-- checkpoint email and the agent-run session probe. `jobs` is outside RLS.
DELETE FROM "jobs" WHERE "type" IN ('notify_checkpoint', 'probe_session');--> statement-breakpoint
DROP TABLE "cloud_fleet_permits" CASCADE;--> statement-breakpoint
DROP TABLE "cloud_resource_dimensions" CASCADE;--> statement-breakpoint
DROP TABLE "cloud_resource_ledger" CASCADE;--> statement-breakpoint
DROP TABLE "cloud_resource_periods" CASCADE;--> statement-breakpoint
DROP TABLE "cloud_resource_reservations" CASCADE;--> statement-breakpoint
DROP TABLE "cloud_resource_totals" CASCADE;--> statement-breakpoint
DROP TABLE "hosted_ai_spend_budgets" CASCADE;--> statement-breakpoint
DROP TABLE "hosted_ai_spend_dimensions" CASCADE;--> statement-breakpoint
DROP TABLE "hosted_ai_spend_ledger" CASCADE;--> statement-breakpoint
DROP TABLE "hosted_ai_spend_reservations" CASCADE;--> statement-breakpoint
ALTER TABLE "channels" DROP COLUMN "hosted_browser_profile_id";--> statement-breakpoint
ALTER TABLE "channels" DROP COLUMN "hosted_browser_session_id";--> statement-breakpoint
ALTER TABLE "channels" DROP COLUMN "hosted_browser_create_id";--> statement-breakpoint
ALTER TABLE "channels" DROP COLUMN "hosted_browser_create_at";--> statement-breakpoint
ALTER TABLE "channels" DROP COLUMN "hosted_browser_live_url";--> statement-breakpoint
ALTER TABLE "channels" DROP COLUMN "hosted_browser_country";
