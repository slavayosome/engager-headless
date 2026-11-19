-- Contract migration: table/column renames preserve rows, IDs and foreign keys.
ALTER TABLE "journeys" RENAME TO "conversations";
--> statement-breakpoint
ALTER TABLE "journey_events" RENAME TO "conversation_events";
--> statement-breakpoint
ALTER TABLE "journey_sources" RENAME TO "conversation_sources";
--> statement-breakpoint
ALTER TABLE "conversation_events" RENAME COLUMN "journey_id" TO "conversation_id";
--> statement-breakpoint
ALTER TABLE "conversation_sources" RENAME COLUMN "journey_id" TO "conversation_id";
--> statement-breakpoint
ALTER TABLE "incoming_invitations" RENAME COLUMN "journey_id" TO "conversation_id";
--> statement-breakpoint
ALTER TABLE "incoming_invitations" RENAME COLUMN "journey_event_id" TO "conversation_event_id";
--> statement-breakpoint
ALTER TABLE "outcome_events" RENAME COLUMN "journey_id" TO "conversation_id";
--> statement-breakpoint
ALTER TABLE "dm_threads" RENAME COLUMN "journey_id" TO "conversation_id";
--> statement-breakpoint
ALTER TABLE "step_runs" RENAME COLUMN "journey_id" TO "conversation_id";
--> statement-breakpoint
ALTER TABLE "action_executions" RENAME COLUMN "journey_id" TO "conversation_id";
--> statement-breakpoint
ALTER TABLE "chat_sessions" RENAME COLUMN "person_journey_id" TO "person_conversation_id";
--> statement-breakpoint
ALTER TABLE "automation_runs" RENAME COLUMN "frozen_journey_ids" TO "frozen_conversation_ids";
--> statement-breakpoint
ALTER TABLE "automation_runs" RENAME COLUMN "journeys_selected_count" TO "conversations_selected_count";
--> statement-breakpoint
-- Constraint renames also rename their backing indexes. Rename the remaining
-- indexes, sequences and change-feed triggers after that, preserving ownership.
DO $$
DECLARE item record; new_name text;
BEGIN
  FOR item IN
    SELECT n.nspname, t.relname AS table_name, c.conname AS object_name
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND c.conname LIKE '%journey%'
  LOOP
    new_name := replace(replace(item.object_name, 'journeys', 'conversations'), 'journey', 'conversation');
    new_name := left(new_name, 63);
    IF to_regclass(format('%I.%I', 'public', new_name)) IS NOT NULL THEN RAISE EXCEPTION 'renamed identifier already exists: %', new_name; END IF;
    EXECUTE format('ALTER TABLE %I.%I RENAME CONSTRAINT %I TO %I', item.nspname, item.table_name, item.object_name, new_name);
  END LOOP;
  FOR item IN
    SELECT n.nspname, c.relname AS object_name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'i' AND c.relname LIKE '%journey%'
  LOOP
    new_name := replace(replace(item.object_name, 'journeys', 'conversations'), 'journey', 'conversation');
    new_name := left(new_name, 63);
    IF to_regclass(format('%I.%I', 'public', new_name)) IS NOT NULL THEN RAISE EXCEPTION 'renamed identifier already exists: %', new_name; END IF;
    EXECUTE format('ALTER INDEX %I.%I RENAME TO %I', item.nspname, item.object_name, new_name);
  END LOOP;
  FOR item IN
    SELECT n.nspname, c.relname AS object_name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'S' AND c.relname LIKE '%journey%'
  LOOP
    new_name := replace(replace(item.object_name, 'journeys', 'conversations'), 'journey', 'conversation');
    new_name := left(new_name, 63);
    IF to_regclass(format('%I.%I', 'public', new_name)) IS NOT NULL THEN RAISE EXCEPTION 'renamed identifier already exists: %', new_name; END IF;
    EXECUTE format('ALTER SEQUENCE %I.%I RENAME TO %I', item.nspname, item.object_name, new_name);
  END LOOP;
  FOR item IN
    SELECT n.nspname, t.relname AS table_name, g.tgname AS object_name
    FROM pg_trigger g JOIN pg_class t ON t.oid = g.tgrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND NOT g.tgisinternal AND g.tgname LIKE '%journey%'
  LOOP
    new_name := replace(replace(item.object_name, 'journeys', 'conversations'), 'journey', 'conversation');
    new_name := left(new_name, 63);
    IF to_regclass(format('%I.%I', 'public', new_name)) IS NOT NULL THEN RAISE EXCEPTION 'renamed identifier already exists: %', new_name; END IF;
    EXECUTE format('ALTER TRIGGER %I ON %I.%I RENAME TO %I', item.object_name, item.nspname, item.table_name, new_name);
  END LOOP;
END $$;
--> statement-breakpoint
UPDATE "jobs"
SET "payload" = ("payload" - 'journeyId') || jsonb_build_object('conversationId', "payload"->'journeyId')
WHERE "type" IN ('invitation_watch', 'invite_note_check', 'withdrawal_read') AND "status" = 'queued'
  AND "payload" ? 'journeyId' AND NOT ("payload" ? 'conversationId');
--> statement-breakpoint
-- These mutable JSON records predate the column rename. Scope each update to
-- its organization so it also works under forced row-level security.
DO $$
DECLARE org record; previous_org text := current_setting('app.current_org', true);
BEGIN
  FOR org IN SELECT id FROM organizations LOOP
    PERFORM set_config('app.current_org', org.id::text, true);
    UPDATE incoming_invitations
      SET attribution_evidence = (attribution_evidence - 'journeyId') || jsonb_build_object('conversationId', attribution_evidence->'journeyId')
      WHERE organization_id = org.id AND attribution_evidence ? 'journeyId' AND NOT (attribution_evidence ? 'conversationId');
    UPDATE live_checks
      SET subject = (subject - 'journeyId' - 'kind') || jsonb_build_object('kind', 'conversation', 'conversationId', coalesce(subject->'conversationId', subject->'journeyId'))
      WHERE organization_id = org.id AND subject->>'kind' = 'journey';
  END LOOP;
  PERFORM set_config('app.current_org', coalesce(previous_org, ''), true);
END $$;
