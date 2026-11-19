DO $$ BEGIN
  IF current_setting('is_superuser') <> 'on' AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolbypassrls) THEN
    RAISE EXCEPTION 'Contract migration requires a role with BYPASSRLS';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE listening_phrases RENAME TO searches;
--> statement-breakpoint
ALTER TABLE listening_phrase_changes RENAME TO search_changes;
--> statement-breakpoint
ALTER TABLE listening_map_plans RENAME TO search_plans;
--> statement-breakpoint
DO $$ DECLARE r record; n text; BEGIN
  FOR r IN SELECT conrelid::regclass AS tbl, conname FROM pg_constraint WHERE conrelid IN ('searches'::regclass, 'search_changes'::regclass, 'search_plans'::regclass) AND conname LIKE 'listening_%' LOOP
    n := replace(replace(replace(r.conname, 'listening_phrase_changes', 'search_changes'), 'listening_map_plans', 'search_plans'), 'listening_phrases', 'searches');
    EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I', r.tbl, r.conname, n);
  END LOOP;
  FOR r IN SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename IN ('searches', 'search_changes', 'search_plans') AND indexname LIKE 'listening_%' LOOP
    n := replace(replace(replace(r.indexname, 'listening_phrase_changes', 'search_changes'), 'listening_map_plans', 'search_plans'), 'listening_phrases', 'searches');
    EXECUTE format('ALTER INDEX %I RENAME TO %I', r.indexname, n);
  END LOOP;
END $$;
--> statement-breakpoint
ALTER SEQUENCE listening_phrases_id_seq RENAME TO searches_id_seq;
--> statement-breakpoint
ALTER SEQUENCE listening_phrase_changes_id_seq RENAME TO search_changes_id_seq;
--> statement-breakpoint
ALTER SEQUENCE listening_map_plans_id_seq RENAME TO search_plans_id_seq;
--> statement-breakpoint
ALTER TABLE search_lookalikes DROP CONSTRAINT search_lookalikes_target;
--> statement-breakpoint
UPDATE search_lookalikes SET target = 'lead_searches' WHERE target = 'listening_map';
--> statement-breakpoint
ALTER TABLE search_lookalikes ADD CONSTRAINT search_lookalikes_target CHECK (target IN ('searches', 'lead_searches'));

--> statement-breakpoint
DO $$
DECLARE item record; new_name text;
BEGIN
  FOR item IN
    SELECT n.nspname, t.relname AS table_name, g.tgname AS object_name
    FROM pg_trigger g JOIN pg_class t ON t.oid = g.tgrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND NOT g.tgisinternal AND g.tgname LIKE '%listening_%'
  LOOP
    new_name := left(replace(replace(replace(item.object_name, 'listening_phrase_changes', 'search_changes'), 'listening_map_plans', 'search_plans'), 'listening_phrases', 'searches'), 63);
    IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = format('%I.%I', item.nspname, item.table_name)::regclass AND tgname = new_name) THEN RAISE EXCEPTION 'renamed identifier already exists: %', new_name; END IF;
    EXECUTE format('ALTER TRIGGER %I ON %I.%I RENAME TO %I', item.object_name, item.nspname, item.table_name, new_name);
  END LOOP;
END $$;
