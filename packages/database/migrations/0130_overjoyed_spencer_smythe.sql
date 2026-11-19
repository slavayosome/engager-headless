ALTER TABLE "automation_runs" ADD COLUMN "channel_id" bigint;--> statement-breakpoint
-- `automation_runs` and `channels` are both FORCE ROW LEVEL SECURITY with an
-- `app.current_org` policy, so a role without BYPASSRLS backfills ZERO rows IN
-- SILENCE — and here that silence would be followed by a NOT NULL that fails on
-- every existing row. migrate.ts documents this path as the DB owner/superuser
-- and refuses to run as the app role; 0124's guard is this one's twin.
DO $automation_run_channel_guard$
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
      'this migration must run as the migration owner: role % cannot bypass row level security and would silently attribute zero rows to their channel',
      current_user;
  END IF;
END
$automation_run_channel_guard$;--> statement-breakpoint
-- Attribution, stated once and permanently: existing rows are attributed to
-- their org's one channel BY CONSTRUCTION, NOT BY EVIDENCE. Every run below
-- this line executed while exactly one connected account existed, so the
-- attribution is correct today and permanently unverifiable later — a run row
-- carries no account marker to audit against. `channels` holds exactly one row
-- per org (0122's per-org seed plus bootstrapLocalOrg's mint, idempotent on
-- (org, network) EXISTENCE), so the org join names one id, not a choice.
UPDATE "automation_runs"
   SET "channel_id" = "channels"."id"
  FROM "channels"
 WHERE "channels"."organization_id" = "automation_runs"."organization_id"
   AND "automation_runs"."channel_id" IS NULL;--> statement-breakpoint
-- migration-lint flags this SET NOT NULL, and its reason is sound: pre-migration
-- app code inserts `automation_runs` without a `channel_id` and would start
-- failing the moment this runs. Deliberate here, and waived by label, because
-- the overlap the rule protects against is ALREADY forbidden for this table —
-- the re-keyed leases mean an old process and a new one are two writers on one
-- account, so the deploy note requires draining the agent before migrating.
-- There is no window in which both versions serve, so there is nothing for an
-- expand-then-contract split to buy.
ALTER TABLE "automation_runs" ALTER COLUMN "channel_id" SET NOT NULL;--> statement-breakpoint
DROP INDEX "automation_runs_org_campaign_running_key";--> statement-breakpoint
-- The lock stops being the campaign's and becomes the ACCOUNT's: what a run
-- occupies is one browser profile, so two campaigns on one channel serialize
-- against each other now.
--
-- This CREATE fails if the org already holds two `running` rows on one channel
-- — precisely the state the new key forbids. That is the correct outcome, not a
-- case to paper over: it means two runs were live on one account at migration
-- time, and the deploy note's drain (stop the agent, let in-flight runs finish
-- or wait out the 20-minute run lease) is what prevents it.
CREATE UNIQUE INDEX "automation_runs_org_channel_running_key" ON "automation_runs" USING btree ("organization_id","channel_id") WHERE status = 'running';--> statement-breakpoint
-- Hygiene only: the re-keyed leases below are orphans under the old key, and an
-- orphan is invisible to the new code that would otherwise wait for it. Deleting
-- the row does NOT stop a holder still running under the old key — the drain in
-- the deploy note is the requirement, and this is the cleanup after it.
DELETE FROM "pacing_state"
 WHERE "kind" LIKE 'automation-run:%'
    OR "kind" LIKE 'discover-lock:%';
