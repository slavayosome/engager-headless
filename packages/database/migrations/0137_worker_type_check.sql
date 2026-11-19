ALTER TABLE "workers" ALTER COLUMN "kind" SET DEFAULT 'commenter';--> statement-breakpoint
-- `workers` is FORCE ROW LEVEL SECURITY, so a role without BYPASSRLS rewrites
-- ZERO rows IN SILENCE — and here the silence is followed by a CHECK that then
-- fails on every row it did not reach. migrate.ts documents this path as the DB
-- owner and refuses to run as the app role; 0136's guard is this one's twin.
DO $worker_type_guard$
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
      'this migration must run as the migration owner: role % cannot bypass row level security and would leave rows the CHECK below then rejects',
      current_user;
  END IF;
END
$worker_type_guard$;--> statement-breakpoint
-- BEFORE the CHECK, not after: `ADD CONSTRAINT ... CHECK` validates every
-- existing row, and every row 0136 copied says `'comment'` — the source table's
-- one kind, a thing the worker MAKES. The twin says what the worker IS.
--
-- An UPDATE rather than a rename, which is what the lint leaves available and
-- what makes this re-runnable: the predicate matches nothing on a second pass.
-- The source table's own `kind` is deliberately untouched and keeps saying
-- `'comment'` until the contract release drops it.
UPDATE "workers" SET "kind" = 'commenter' WHERE "kind" = 'comment';--> statement-breakpoint
-- The source table's `kind` was created with no CHECK at all (0116), so a raw
-- `insert ... kind = 'post'` succeeded there and the enum was a TypeScript
-- opinion. `responder` and `writer` join this predicate in the landings that
-- build them — a constraint that admits a type nothing can run lets a row exist
-- that every consumer's switch falls through.
ALTER TABLE "workers" ADD CONSTRAINT "workers_kind_check" CHECK ("workers"."kind" in ('scout','commenter'));
