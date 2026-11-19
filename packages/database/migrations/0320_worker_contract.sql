DO $$ BEGIN
  IF current_setting('is_superuser') <> 'on' AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolbypassrls) THEN
    RAISE EXCEPTION 'Contract migration requires a role with BYPASSRLS';
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM automations a LEFT JOIN workers w ON w.id = a.id AND w.organization_id = a.organization_id WHERE w.id IS NULL) THEN
    RAISE EXCEPTION 'Cannot drop automations: an automation has no matching worker';
  END IF;
END $$;
--> statement-breakpoint
ALTER SEQUENCE automations_id_seq OWNED BY workers.id;
--> statement-breakpoint
ALTER SEQUENCE automations_id_seq RENAME TO workers_id_seq;
--> statement-breakpoint
DROP TABLE automations;
--> statement-breakpoint
ALTER TABLE automation_runs RENAME TO worker_runs;
--> statement-breakpoint
ALTER TABLE worker_runs RENAME COLUMN automation_id TO worker_id;
--> statement-breakpoint
ALTER TABLE messages RENAME COLUMN automation_run_id TO worker_run_id;
--> statement-breakpoint
ALTER TABLE discovered_posts RENAME COLUMN automation_run_id TO worker_run_id;
--> statement-breakpoint
DO $$ DECLARE r record; n text; BEGIN
  FOR r IN SELECT conname FROM pg_constraint WHERE conrelid = 'worker_runs'::regclass AND conname LIKE 'automation_runs%' LOOP
    n := replace(replace(r.conname, 'automation_runs', 'worker_runs'), 'org_automation_started', 'org_worker_started');
    EXECUTE format('ALTER TABLE worker_runs RENAME CONSTRAINT %I TO %I', r.conname, n);
  END LOOP;
  FOR r IN SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'worker_runs' AND indexname LIKE 'automation_runs%' LOOP
    n := replace(replace(r.indexname, 'automation_runs', 'worker_runs'), 'org_automation_started', 'org_worker_started');
    EXECUTE format('ALTER INDEX %I RENAME TO %I', r.indexname, n);
  END LOOP;
END $$;
--> statement-breakpoint
ALTER SEQUENCE automation_runs_id_seq RENAME TO worker_runs_id_seq;
--> statement-breakpoint
ALTER TABLE messages DROP CONSTRAINT messages_publish_origin_check;
--> statement-breakpoint
ALTER TABLE action_executions DROP CONSTRAINT action_executions_origin_check;
--> statement-breakpoint
UPDATE messages SET publish_origin = 'worker' WHERE publish_origin = 'automation';
--> statement-breakpoint
UPDATE action_executions SET origin = 'worker' WHERE origin = 'automation';
--> statement-breakpoint
UPDATE messages SET room_reply_target = jsonb_set(room_reply_target, '{selectedBy}', '"worker"'::jsonb) WHERE room_reply_target->>'selectedBy' = 'automation';
--> statement-breakpoint
ALTER TABLE messages ALTER COLUMN publish_origin SET DEFAULT 'worker';
--> statement-breakpoint
ALTER TABLE action_executions ALTER COLUMN origin SET DEFAULT 'worker';
--> statement-breakpoint
ALTER TABLE messages ADD CONSTRAINT messages_publish_origin_check CHECK (publish_origin IN ('owner', 'worker'));
--> statement-breakpoint
ALTER TABLE action_executions ADD CONSTRAINT action_executions_origin_check CHECK (origin IN ('owner', 'worker'));
--> statement-breakpoint
UPDATE jobs SET payload = (payload - 'automationRunId') || jsonb_build_object('workerRunId', payload->'automationRunId') WHERE jsonb_typeof(payload) = 'object' AND payload ? 'automationRunId' AND NOT payload ? 'workerRunId';
--> statement-breakpoint
UPDATE jobs SET payload = (payload - 'automationId') || jsonb_build_object('workerId', payload->'automationId') WHERE type = 'worker_run' AND jsonb_typeof(payload) = 'object' AND payload ? 'automationId' AND NOT payload ? 'workerId';
--> statement-breakpoint
UPDATE jobs SET payload = payload - 'automationRunId' WHERE jsonb_typeof(payload) = 'object' AND payload ? 'automationRunId';
--> statement-breakpoint
UPDATE jobs SET payload = payload - 'automationId' WHERE type = 'worker_run' AND jsonb_typeof(payload) = 'object' AND payload ? 'automationId';
--> statement-breakpoint
UPDATE ai_usage SET stage = 'worker_draft' WHERE stage = 'automation_draft';
--> statement-breakpoint
UPDATE ai_usage SET prompt_ref = regexp_replace(prompt_ref, '^automation\.', 'worker.') WHERE prompt_ref LIKE 'automation.%';

--> statement-breakpoint
DO $$
DECLARE item record; new_name text;
BEGIN
  FOR item IN
    SELECT n.nspname, t.relname AS table_name, g.tgname AS object_name
    FROM pg_trigger g JOIN pg_class t ON t.oid = g.tgrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND NOT g.tgisinternal AND g.tgname LIKE '%automation_runs%'
  LOOP
    new_name := left(replace(item.object_name, 'automation_runs', 'worker_runs'), 63);
    IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = format('%I.%I', item.nspname, item.table_name)::regclass AND tgname = new_name) THEN RAISE EXCEPTION 'renamed identifier already exists: %', new_name; END IF;
    EXECUTE format('ALTER TRIGGER %I ON %I.%I RENAME TO %I', item.object_name, item.nspname, item.table_name, new_name);
  END LOOP;
END $$;
