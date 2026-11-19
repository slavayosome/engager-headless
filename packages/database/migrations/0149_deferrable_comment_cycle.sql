-- THE ONE FOREIGN-KEY CYCLE BECOMES DEFERRABLE. `messages` and
-- `incoming_comments` reference each other — a message answering an incoming
-- comment, and a comment left under one of our messages — so no table order
-- inserts both sides of a populated org, and `SET CONSTRAINTS ALL DEFERRED`
-- cannot help while both constraints are NOT DEFERRABLE.
--
-- INITIALLY IMMEDIATE keeps every existing statement byte-identical: the check
-- still runs at statement end unless a transaction opts in. A transaction that
-- does opt in — `copy-org.ts`'s target transaction — gets both checked once, at
-- commit. Written by hand rather than generated: the pinned drizzle-orm's
-- `ForeignKeyBuilder` exposes only `onUpdate`/`onDelete`, so `schema.ts` cannot
-- say this and carries a comment naming this file instead.
--
-- Conditional because NEITHER half is a migration's constraint: both are added
-- by `applyPostConcurrentConstraints` (`concurrent-indexes.ts`), which runs
-- AFTER the migrations. A fresh database has neither here and gets both
-- deferrable from that installer; a database migrated before this release has
-- both, and this converges them.
DO $$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT relation.relname AS table_name, constraint_state.conname AS constraint_name
      FROM pg_catalog.pg_constraint AS constraint_state
      JOIN pg_catalog.pg_class AS relation
        ON relation.oid = constraint_state.conrelid
      JOIN pg_catalog.pg_namespace AS relation_namespace
        ON relation_namespace.oid = relation.relnamespace
     WHERE relation_namespace.nspname = 'public'
       AND constraint_state.conname IN (
             'incoming_comments_org_parent_message_fk',
             'messages_org_incoming_comment_fk'
           )
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ALTER CONSTRAINT %I DEFERRABLE INITIALLY IMMEDIATE',
      target.table_name,
      target.constraint_name
    );
  END LOOP;
END $$;
