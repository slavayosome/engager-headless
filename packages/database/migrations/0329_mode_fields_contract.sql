-- Contract migration: the five mode fields go. "Which mode is this action in"
-- has one answer, `modeFor` over the active strategy, so the projections that
-- once stood in for it have no reader and no writer left:
--   campaigns.run_mode, approval_mode, drafting_mode, auto_reply,
--   workers.publish_enabled (and the stage-ladder CHECK that named it).
--
-- BEFORE THE DROP, nothing goes live by inference:
--   * A campaign that was still in shadow — its column or any strategy version
--     that is active, waiting or in review said `run_mode: shadow` — is set
--     Paused and Not started (its active version returns to `draft`, so the
--     owner's Start is what activates it) and its workers' wake is cleared.
--     Its approved messages of every origin, the owner's included (a Pause
--     does not hold those), go back to `proposed` to wait for the owner's yes,
--     and their queued post jobs and any scheduled activation of its strategy
--     are cancelled, so only the owner's Start activates it. A message already
--     `posting` is left for reconciliation. The count is logged.
--   * The reply-writing prompt in `auto_reply.prompt` is the owner's text, not
--     a mode: a custom one moves to `prompts.reply_policy` (an existing
--     `reply_policy` wins), and the default text is not carried.
-- The strategy document's own `run_mode` key is dropped by the document
-- upgrader (schema 5 to 6, `strategy/upgrade.ts`); stored versions stay as
-- they were written.
--
-- DESTRUCTIVE. A bare drizzle `.select()` names every declared column, so a
-- build from before this change takes 42703 on `campaigns` and `workers` reads
-- once it is applied; the app migrates immediately before it starts the
-- matching build. The stored values of the dropped columns are not carried.
DO $$
DECLARE
  required text[] := ARRAY['campaigns.run_mode', 'campaigns.approval_mode', 'campaigns.drafting_mode',
    'campaigns.auto_reply', 'workers.publish_enabled'];
  item text;
  recreated text[] := ARRAY['workers_enabled_does_something_check'];
BEGIN
  IF current_setting('is_superuser') <> 'on' AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolbypassrls) THEN
    RAISE EXCEPTION 'Contract migration requires a role with BYPASSRLS';
  END IF;
  FOREACH item IN ARRAY required LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = split_part(item, '.', 1) AND column_name = split_part(item, '.', 2)) THEN
      RAISE EXCEPTION 'Cannot drop %: the column does not exist', item;
    END IF;
  END LOOP;
  FOREACH item IN ARRAY recreated LOOP
    IF length(item) > 63 THEN RAISE EXCEPTION 'identifier exceeds 63 characters: %', item; END IF;
  END LOOP;
END $$;
--> statement-breakpoint
DO $$
DECLARE
  shadow_ids bigint[];
  paused integer;
  unstarted integer;
  held integer;
  now_ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
BEGIN
  SELECT coalesce(array_agg(c.id::bigint), ARRAY[]::bigint[]) INTO shadow_ids
  FROM campaigns c
  WHERE c.deleted_at IS NULL
    AND (c.run_mode = 'shadow'
      OR EXISTS (SELECT 1 FROM campaign_strategies s
        WHERE s.organization_id = c.organization_id AND s.campaign_id = c.id
          AND s.status IN ('active', 'draft', 'pending_review')
          AND (s.document ->> 'run_mode') = 'shadow'));
  -- Beneath the row triggers: their functions are reinstalled after a whole
  -- run, so on an upgrade across releases they can still name columns an
  -- earlier migration dropped. The post jobs are cancelled just below instead.
  ALTER TABLE messages DISABLE TRIGGER USER;
  UPDATE messages SET status = 'proposed', scheduled_at = NULL
  WHERE campaign_id = ANY(shadow_ids) AND status = 'approved';
  GET DIAGNOSTICS held = ROW_COUNT;
  ALTER TABLE messages ENABLE TRIGGER USER;
  UPDATE jobs SET status = 'done', last_error = 'cancelled:campaign_in_shadow', updated_at = now_ms
  WHERE status = 'queued'
    AND ((type IN ('post_comment', 'post_reply') AND (payload ->> 'messageId') IN
        (SELECT m.id::text FROM messages m WHERE m.campaign_id = ANY(shadow_ids) AND m.status = 'proposed'))
      OR (type = 'activate_strategy' AND (payload ->> 'campaignId') IN (SELECT unnest(shadow_ids)::text)));
  UPDATE workers SET enabled = false, next_run_at = NULL, updated_at = now_ms
  WHERE campaign_id = ANY(shadow_ids) AND (enabled OR next_run_at IS NOT NULL);
  UPDATE campaign_strategies SET status = 'draft'
  WHERE campaign_id = ANY(shadow_ids) AND status = 'active';
  GET DIAGNOSTICS unstarted = ROW_COUNT;
  UPDATE campaigns SET status = 'paused', status_changed_at = now_ms, status_changed_by = 'system', updated_at = now_ms
  WHERE id = ANY(shadow_ids) AND status = 'active';
  GET DIAGNOSTICS paused = ROW_COUNT;
  RAISE NOTICE 'run_mode drop: % campaign(s) still in shadow, % paused, % returned to not started, % approved message(s) held',
    cardinality(shadow_ids), paused, unstarted, held;
END $$;
--> statement-breakpoint
UPDATE "campaigns"
SET "prompts" = coalesce("prompts", '{}'::jsonb) || jsonb_build_object('reply_policy', btrim("auto_reply" ->> 'prompt'))
WHERE "auto_reply" IS NOT NULL
  AND nullif(btrim("auto_reply" ->> 'prompt'), '') IS NOT NULL
  AND NOT (coalesce("prompts", '{}'::jsonb) ? 'reply_policy')
  AND btrim(replace("auto_reply" ->> 'prompt', E'\r\n', E'\n')) NOT IN (
    'Reply warmly, answer the question, never pitch.',
    'Reply warmly and specifically. Answer any question. Never pitch.');
--> statement-breakpoint
ALTER TABLE "workers" DROP CONSTRAINT "workers_stage_ladder_check";--> statement-breakpoint
ALTER TABLE "workers" DROP CONSTRAINT "workers_enabled_does_something_check";--> statement-breakpoint
ALTER TABLE "campaigns" DROP COLUMN "run_mode";--> statement-breakpoint
ALTER TABLE "campaigns" DROP COLUMN "approval_mode";--> statement-breakpoint
ALTER TABLE "campaigns" DROP COLUMN "drafting_mode";--> statement-breakpoint
ALTER TABLE "campaigns" DROP COLUMN "auto_reply";--> statement-breakpoint
ALTER TABLE "workers" DROP COLUMN "publish_enabled";--> statement-breakpoint
ALTER TABLE "workers" ADD CONSTRAINT "workers_enabled_does_something_check" CHECK (not "workers"."enabled"
        or ("workers"."kind" = 'scout' and "workers"."sweep_enabled")
        or ("workers"."kind" = 'ambassador' and ("workers"."draft_enabled" or "workers"."conversation_enabled")));
