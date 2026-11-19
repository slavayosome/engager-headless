-- Every campaign runs on its definition (US-RET-23), so `agentic_workflow` is
-- true on every row a live campaign has, and nothing reads it. The drop fails
-- closed: a campaign an older install left off its definition would lose the
-- only record that it was, so the migration refuses to run until the agent's
-- start has moved it (`select count(*) from campaigns where agentic_workflow =
-- false and deleted_at is null` must be 0). Deleted campaigns lose nothing
-- that is read.
--
-- DESTRUCTIVE. A bare drizzle `.select()` names every declared column, so a
-- build from before this change takes 42703 on `campaigns` reads once it is
-- applied; the app migrates immediately before it starts the matching build.
DO $$
BEGIN
  IF current_setting('is_superuser') <> 'on'
     AND NOT EXISTS (
       SELECT 1 FROM pg_roles r
       WHERE (r.rolsuper OR r.rolbypassrls)
         AND pg_has_role(current_user, r.oid, 'USAGE')
     ) THEN
    RAISE EXCEPTION 'migration role % cannot bypass row level security on campaigns', current_user;
  END IF;
  IF EXISTS (SELECT 1 FROM "campaigns" WHERE "agentic_workflow" = false AND "deleted_at" IS NULL) THEN
    RAISE EXCEPTION 'campaigns still off their definition: start the previous release once so the agent moves them, then migrate';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "campaigns" DROP COLUMN "agentic_workflow";
