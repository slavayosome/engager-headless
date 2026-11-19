-- THE STEP CHECK SPLITS PER TYPE, in the landing that can carry it. A scout has
-- one step, the find; a commenter has write and publish, and its `sweep_enabled`
-- is dead since T-8.3. Split earlier and the shape the CRUD path still produced
-- — an armed commenter whose only step was the find — became unrepresentable,
-- measured at 30 tests across 7 files. What makes it representable no longer is
-- `create_worker` taking a `type`, which lands in this same commit.
--
-- DROP + ADD rather than a rename, which the lint permits: the new predicate is
-- strictly narrower, and every existing row already satisfies it because the
-- only writer of an armed worker is the CRUD path this commit narrows with it.
ALTER TABLE "workers" DROP CONSTRAINT "workers_enabled_does_something_check";--> statement-breakpoint
-- Any row the OLD predicate allowed and the new one does not is disarmed before
-- the constraint validates. On a fresh install this matches nothing — the CRUD
-- path narrows in the same release — so it is a same-release consistency step
-- rather than a backfill: without it a row written minutes before the migration
-- ran would fail validation and take the whole deploy with it.
--
-- Auto only, and the row is otherwise intact: Run now still works on it, because
-- Auto has never decided that (INV-5).
UPDATE "workers"
   SET "enabled" = false, "next_run_at" = NULL
 WHERE "enabled"
   AND NOT (
     ("kind" = 'scout' AND "sweep_enabled")
     OR ("kind" = 'commenter' AND ("draft_enabled" OR "publish_enabled"))
   );--> statement-breakpoint
ALTER TABLE "workers" ADD CONSTRAINT "workers_enabled_does_something_check" CHECK (not "workers"."enabled"
        or ("workers"."kind" = 'scout' and "workers"."sweep_enabled")
        or ("workers"."kind" = 'commenter' and ("workers"."draft_enabled" or "workers"."publish_enabled")));