-- INV-11: nothing posts that the owner did not personally author or personally
-- approve. `campaigns.approval_mode` was the last thing that could approve on
-- its own: a row holding 'auto' (or the already-legacy 'hybrid') made a freshly
-- drafted comment land 'approved', which the DB trigger then arms as a post job.
-- The runtime in this commit writes the column as the constant 'manual' and no
-- longer reads it to decide a status, so the value is collapsed here to match.
--
-- This is a ONE-TIME correction of the rows a retired column already armed, not
-- a runtime retraction: it does not touch the kill switch (Phase 2 owns that
-- ladder) and it does not touch anything an automation run legitimately armed.
-- `publish_origin = 'automation' AND automation_run_id IS NULL` is exactly that
-- distinction — an owner-authored comment is untouched, and so is a comment a
-- real automation run scheduled under a switch the owner turned on.
--
-- One-shot, expand-only: both predicates exclude the state they write, so a
-- rerun matches zero rows.
UPDATE "campaigns" SET "approval_mode" = 'manual' WHERE "approval_mode" <> 'manual';--> statement-breakpoint
-- `messages` is FORCE ROW LEVEL SECURITY with an `app.current_org` policy, so a
-- role without BYPASSRLS matches ZERO rows IN SILENCE — indistinguishable from
-- "there was nothing to correct". migrate.ts documents this path as the DB
-- owner/superuser and refuses to run as the app role; this block makes that
-- assumption explicit and reports what it actually corrected.
DO $collapse$
DECLARE
  corrected bigint;
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
      '0120 must run as the migration owner: role % cannot bypass row level security on "messages" and would silently correct zero rows',
      current_user;
  END IF;

  UPDATE "messages" SET "status" = 'proposed', "scheduled_at" = NULL
  WHERE "status" = 'approved' AND "publish_origin" = 'automation'
    AND "automation_run_id" IS NULL AND "scheduled_at" IS NOT NULL;
  GET DIAGNOSTICS corrected = ROW_COUNT;

  RAISE NOTICE '0120 manual approval collapse: % armed message(s) returned to proposed', corrected;
END
$collapse$;
