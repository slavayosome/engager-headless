DO $$ BEGIN
  IF current_setting('is_superuser') <> 'on' AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolbypassrls) THEN
    RAISE EXCEPTION 'Contract migration requires a role with BYPASSRLS';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE interactive_stages RENAME TO tasks;
--> statement-breakpoint
ALTER TABLE worker_runs RENAME COLUMN agent_stage_status TO agent_task_status;
--> statement-breakpoint
DO $$
DECLARE item record; new_name text;
BEGIN
  FOR item IN SELECT n.nspname, t.relname AS table_name, c.conname AS object_name
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='public' AND c.conname LIKE '%interactive_stages%'
  LOOP
    new_name := left(replace(item.object_name, 'interactive_stages', 'tasks'), 63);
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = format('%I.%I',item.nspname,item.table_name)::regclass AND conname = new_name) OR to_regclass(format('%I.%I',item.nspname,new_name)) IS NOT NULL THEN RAISE EXCEPTION 'renamed identifier already exists: %', new_name; END IF;
    EXECUTE format('ALTER TABLE %I.%I RENAME CONSTRAINT %I TO %I',item.nspname,item.table_name,item.object_name,new_name);
  END LOOP;
  FOR item IN SELECT n.nspname, c.relname AS object_name, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('i','S') AND c.relname LIKE '%interactive_stages%' LOOP
    new_name := left(replace(item.object_name, 'interactive_stages', 'tasks'), 63);
    IF to_regclass(format('%I.%I',item.nspname,new_name)) IS NOT NULL THEN RAISE EXCEPTION 'renamed identifier already exists: %', new_name; END IF;
    EXECUTE format('ALTER %s %I.%I RENAME TO %I', CASE WHEN item.relkind='i' THEN 'INDEX' ELSE 'SEQUENCE' END,item.nspname,item.object_name,new_name);
  END LOOP;
  FOR item IN SELECT n.nspname,t.relname AS table_name,g.tgname AS object_name FROM pg_trigger g JOIN pg_class t ON t.oid=g.tgrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND NOT g.tgisinternal AND g.tgname LIKE '%interactive_stages%' LOOP
    new_name := left(replace(item.object_name, 'interactive_stages', 'tasks'), 63);
    IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=format('%I.%I',item.nspname,item.table_name)::regclass AND tgname=new_name) THEN RAISE EXCEPTION 'renamed identifier already exists: %', new_name; END IF;
    EXECUTE format('ALTER TRIGGER %I ON %I.%I RENAME TO %I',item.object_name,item.nspname,item.table_name,new_name);
  END LOOP;
END $$;
--> statement-breakpoint
UPDATE tasks SET kind='campaign_brief' WHERE kind='target_brief';
--> statement-breakpoint
UPDATE tasks SET context=jsonb_set(context, '{input}', ((context->'input') - 'stageKind') || jsonb_build_object('taskKind', CASE WHEN context->'input'->>'stageKind'='target_brief' THEN to_jsonb('campaign_brief'::text) ELSE context->'input'->'stageKind' END)) WHERE jsonb_typeof(context->'input')='object' AND context->'input' ? 'stageKind' AND NOT (context->'input' ? 'taskKind');
--> statement-breakpoint
UPDATE tasks SET receipts = (SELECT coalesce(jsonb_object_agg(key, CASE WHEN jsonb_typeof(value)='object' THEN
  (value - 'pendingStages' - 'nextRequiredStage') ||
  CASE WHEN value ? 'pendingStages' THEN jsonb_build_object('pendingTasks', (SELECT coalesce(jsonb_agg(CASE WHEN v='"target_brief"'::jsonb THEN '"campaign_brief"'::jsonb ELSE v END ORDER BY ord), '[]'::jsonb) FROM jsonb_array_elements(value->'pendingStages') WITH ORDINALITY AS p(v,ord))) ELSE '{}'::jsonb END ||
  CASE WHEN value ? 'nextRequiredStage' THEN jsonb_build_object('nextRequiredTask', value->'nextRequiredStage') ELSE '{}'::jsonb END
  ELSE value END), '{}'::jsonb) FROM jsonb_each(receipts))
WHERE jsonb_typeof(receipts)='object' AND EXISTS (SELECT 1 FROM jsonb_each(receipts) r WHERE r.value ? 'pendingStages' OR r.value ? 'nextRequiredStage');
