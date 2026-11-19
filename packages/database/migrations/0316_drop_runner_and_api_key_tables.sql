-- Retired runner credentials and work have no remaining runtime users; interactive activations remain. setup_proof activations were runner-only and are counted below and deleted with the column; their subscriptions return to the guarded state.
DO $$ DECLARE retired_count bigint; BEGIN
  SELECT count(*) INTO retired_count FROM subscription_activations WHERE source = 'setup_proof';
  RAISE NOTICE 'Removing % retired setup_proof activations', retired_count;
END $$;--> statement-breakpoint
DELETE FROM subscription_activations WHERE source = 'setup_proof';--> statement-breakpoint
ALTER TABLE subscription_activations DROP CONSTRAINT subscription_activations_source_check;--> statement-breakpoint
-- Installed by post-migration maintenance on existing installs, not by journal replay.
ALTER TABLE subscription_activations DROP CONSTRAINT IF EXISTS subscription_activations_org_runner_event_fk;--> statement-breakpoint
DROP INDEX subscription_activations_runner_event_unq;--> statement-breakpoint
ALTER TABLE subscription_activations DROP COLUMN runner_work_event_id;--> statement-breakpoint
ALTER TABLE subscription_activations ADD CONSTRAINT subscription_activations_source_check CHECK (source = 'interactive' AND approved_by_user_id IS NOT NULL);--> statement-breakpoint
DO $$ DECLARE t record; BEGIN
  FOR t IN SELECT n.nspname, c.relname, tg.tgname
    FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT tg.tgisinternal AND n.nspname = 'public'
      AND tg.tgname LIKE '%\_runner\_context\_epoch' ESCAPE '\'
  LOOP
    EXECUTE format('DROP TRIGGER %I ON %I.%I', t.tgname, t.nspname, t.relname);
  END LOOP;
END $$;--> statement-breakpoint
DROP FUNCTION IF EXISTS engager_bump_runner_context_epoch();--> statement-breakpoint
DROP FUNCTION IF EXISTS engager_lock_runner_context_epoch();--> statement-breakpoint
DROP TABLE runner_disconnect_receipts;--> statement-breakpoint
DROP TABLE runner_disconnect_requests;--> statement-breakpoint
DROP TABLE runner_work_events;--> statement-breakpoint
DROP TABLE runner_work_orders;--> statement-breakpoint
DROP TABLE agent_runners;--> statement-breakpoint
DROP TABLE api_keys;--> statement-breakpoint
DROP TABLE runner_protocol_transitions;--> statement-breakpoint
DROP TABLE runner_context_epochs;--> statement-breakpoint
DROP TABLE runner_draft_schedules;--> statement-breakpoint
DROP FUNCTION IF EXISTS enforce_runner_api_key_enrollment();--> statement-breakpoint
DROP FUNCTION IF EXISTS enforce_runner_api_key_revocation();--> statement-breakpoint
DROP FUNCTION IF EXISTS enforce_scheduled_runner_binding_immutability();
