DO $$ BEGIN
  IF current_setting('is_superuser') <> 'on' AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolbypassrls) THEN
    RAISE EXCEPTION 'Contract migration requires a role with BYPASSRLS';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE campaign_definitions RENAME TO campaign_strategies;
--> statement-breakpoint
ALTER TABLE step_runs RENAME COLUMN definition_version TO strategy_version;
--> statement-breakpoint
ALTER TABLE system_state RENAME COLUMN definition_projection_schema TO strategy_projection_schema;
--> statement-breakpoint
DO $$
DECLARE item record; new_name text;
BEGIN
  FOR item IN SELECT n.nspname, t.relname AS table_name, c.conname AS object_name
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='public' AND c.conname LIKE '%campaign_definitions%'
  LOOP
    new_name := left(replace(item.object_name, 'campaign_definitions', 'campaign_strategies'), 63);
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = format('%I.%I',item.nspname,item.table_name)::regclass AND conname = new_name) OR to_regclass(format('%I.%I',item.nspname,new_name)) IS NOT NULL THEN RAISE EXCEPTION 'renamed identifier already exists: %', new_name; END IF;
    EXECUTE format('ALTER TABLE %I.%I RENAME CONSTRAINT %I TO %I',item.nspname,item.table_name,item.object_name,new_name);
  END LOOP;
  FOR item IN SELECT n.nspname, c.relname AS object_name, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('i','S') AND c.relname LIKE '%campaign_definitions%' LOOP
    new_name := left(replace(item.object_name, 'campaign_definitions', 'campaign_strategies'), 63);
    IF to_regclass(format('%I.%I',item.nspname,new_name)) IS NOT NULL THEN RAISE EXCEPTION 'renamed identifier already exists: %', new_name; END IF;
    EXECUTE format('ALTER %s %I.%I RENAME TO %I', CASE WHEN item.relkind='i' THEN 'INDEX' ELSE 'SEQUENCE' END,item.nspname,item.object_name,new_name);
  END LOOP;
  FOR item IN SELECT n.nspname,t.relname AS table_name,g.tgname AS object_name FROM pg_trigger g JOIN pg_class t ON t.oid=g.tgrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND NOT g.tgisinternal AND g.tgname LIKE '%campaign_definitions%' LOOP
    new_name := left(replace(item.object_name, 'campaign_definitions', 'campaign_strategies'), 63);
    IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=format('%I.%I',item.nspname,item.table_name)::regclass AND tgname=new_name) THEN RAISE EXCEPTION 'renamed identifier already exists: %', new_name; END IF;
    EXECUTE format('ALTER TRIGGER %I ON %I.%I RENAME TO %I',item.object_name,item.nspname,item.table_name,new_name);
  END LOOP;
END $$;
--> statement-breakpoint
UPDATE jobs SET type='activate_strategy', idempotency_key = CASE WHEN idempotency_key LIKE 'activate_definition:%' THEN 'activate_strategy:' || substr(idempotency_key, length('activate_definition:') + 1) ELSE idempotency_key END WHERE type='activate_definition';
--> statement-breakpoint
UPDATE chat_pending_changes SET kind='strategy.patch', payload = CASE WHEN payload->>'kind'='definition.patch' THEN jsonb_set(payload, '{kind}', '"strategy.patch"'::jsonb) ELSE payload END WHERE kind='definition.patch';
--> statement-breakpoint
UPDATE action_executions SET candidate=jsonb_set(candidate, '{versions}', ((candidate->'versions') - 'definition') || jsonb_build_object('strategy', candidate->'versions'->'definition')) WHERE candidate->'versions' ? 'definition' AND NOT (candidate->'versions' ? 'strategy');
--> statement-breakpoint
UPDATE conversation_events SET source_ref=jsonb_set(source_ref, '{room}', ((source_ref->'room') - 'definitionVersion') || jsonb_build_object('strategyVersion',source_ref->'room'->'definitionVersion')) WHERE source_ref->'room' ? 'definitionVersion' AND NOT (source_ref->'room' ? 'strategyVersion');
--> statement-breakpoint
UPDATE step_runs SET drafts=(SELECT coalesce(jsonb_agg(CASE WHEN d->'versions' ? 'definition' AND NOT (d->'versions' ? 'strategy') THEN jsonb_set(d, '{versions}', ((d->'versions') - 'definition') || jsonb_build_object('strategy',d->'versions'->'definition')) ELSE d END ORDER BY ord), '[]'::jsonb) FROM jsonb_array_elements(drafts) WITH ORDINALITY AS x(d,ord)) WHERE jsonb_typeof(drafts)='array' AND EXISTS (SELECT 1 FROM jsonb_array_elements(drafts) d WHERE d->'versions' ? 'definition');
--> statement-breakpoint
UPDATE action_approvals SET dependency_versions=(dependency_versions - 'definition') || jsonb_build_object('strategy',dependency_versions->'definition') WHERE dependency_versions ? 'definition' AND NOT (dependency_versions ? 'strategy');
