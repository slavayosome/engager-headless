-- Contract migration: `action_executions` becomes `actions`, the one table of
-- everything that sends. Rows, ids and foreign keys are kept, so an action in
-- flight keeps its holder and idempotency key and nothing sends twice.
-- Idempotent: a database that already has `actions` is left as it is.
DO $$ BEGIN
  IF current_setting('is_superuser') <> 'on' AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolbypassrls) THEN
    RAISE EXCEPTION 'Contract migration requires a role with BYPASSRLS';
  END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE item record; new_name text;
BEGIN
  IF to_regclass('public.action_executions') IS NOT NULL THEN
    IF to_regclass('public.actions') IS NOT NULL THEN
      RAISE EXCEPTION 'Cannot rename action_executions: actions already exists';
    END IF;
    ALTER TABLE public.action_executions RENAME TO actions;
  END IF;
  IF to_regclass('public.actions') IS NULL THEN
    RAISE EXCEPTION 'Neither action_executions nor actions exists';
  END IF;
  -- Constraint renames also rename their backing indexes. Rename the remaining
  -- indexes, the sequence and the change-feed trigger after that.
  FOR item IN
    SELECT c.conname AS object_name FROM pg_constraint c
    WHERE c.conrelid = 'public.actions'::regclass AND strpos(c.conname, 'action_executions') > 0
  LOOP
    new_name := left(replace(item.object_name, 'action_executions', 'actions'), 63);
    IF to_regclass(format('public.%I', new_name)) IS NOT NULL
      OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.actions'::regclass AND conname = new_name) THEN
      RAISE EXCEPTION 'renamed identifier already exists: %', new_name;
    END IF;
    EXECUTE format('ALTER TABLE public.actions RENAME CONSTRAINT %I TO %I', item.object_name, new_name);
  END LOOP;
  FOR item IN
    SELECT c.relname AS object_name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'i' AND strpos(c.relname, 'action_executions') > 0
  LOOP
    new_name := left(replace(item.object_name, 'action_executions', 'actions'), 63);
    IF to_regclass(format('public.%I', new_name)) IS NOT NULL THEN RAISE EXCEPTION 'renamed identifier already exists: %', new_name; END IF;
    EXECUTE format('ALTER INDEX public.%I RENAME TO %I', item.object_name, new_name);
  END LOOP;
  FOR item IN
    SELECT c.relname AS object_name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'S' AND strpos(c.relname, 'action_executions') > 0
  LOOP
    new_name := left(replace(item.object_name, 'action_executions', 'actions'), 63);
    IF to_regclass(format('public.%I', new_name)) IS NOT NULL THEN RAISE EXCEPTION 'renamed identifier already exists: %', new_name; END IF;
    EXECUTE format('ALTER SEQUENCE public.%I RENAME TO %I', item.object_name, new_name);
  END LOOP;
  FOR item IN
    SELECT g.tgname AS object_name FROM pg_trigger g
    WHERE g.tgrelid = 'public.actions'::regclass AND NOT g.tgisinternal AND strpos(g.tgname, 'action_executions') > 0
  LOOP
    new_name := left(replace(item.object_name, 'action_executions', 'actions'), 63);
    IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.actions'::regclass AND tgname = new_name) THEN RAISE EXCEPTION 'renamed identifier already exists: %', new_name; END IF;
    EXECUTE format('ALTER TRIGGER %I ON public.actions RENAME TO %I', item.object_name, new_name);
  END LOOP;
  -- Function bodies name tables at run time, so the ones that name this table
  -- (the conversions a restored pre-update archive still runs, and the message
  -- withdrawal trigger) are re-created against the new name.
  FOR item IN
    SELECT pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f' AND strpos(p.prosrc, 'action_executions') > 0
  LOOP
    EXECUTE replace(item.definition, 'action_executions', 'actions');
  END LOOP;
END $$;
