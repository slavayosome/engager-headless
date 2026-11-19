-- A comment sends as a `comment` action, and the post job goes. The kind joins
-- the action ledger's, and its row names the `messages` row that holds the
-- words (`message_id`), the record every surface of the comment reads.
--
-- `convert_comments` is the whole conversion, so a restored pre-update archive
-- runs the same one (`portable-restore.ts`). Nothing sends twice:
--   * an approved comment with the owner's yes on its exact words (or the
--     owner's own words) becomes an `approved` action carrying that yes; any
--     other (an Automatic proposal nobody said yes to) becomes `reserved`, with
--     no binding, which the gate sends back to the owner. Its slot stays on the
--     message;
--   * a comment that was posting, or parked for review, becomes an `uncertain`
--     action fenced to the operation it went out under: it may have reached
--     LinkedIn, so nothing presses again until a read of the post or the owner
--     says what happened. Its message waits for review;
--   * a worker's comment keeps the Comment binding its campaign's active
--     strategy has for it, and a yes keeps that mode as its authority; with no
--     single binding on Ask me or Automatic it goes back to the owner for a
--     fresh yes;
--   * an owner's answer the old resolver had queued for the sidecar's journal
--     (a pending `reconcile_message_write`) becomes an answered, uncertain
--     action carrying the version it was frozen at: the drain closes the
--     journal on it, a journal that disagrees leaves it with the owner, and the
--     old job is retired in the same transaction;
--   * an approved comment whose campaign or post is gone can never be sent: it
--     fails, with the cause the send would have given;
--   * the queued `post:` job of each is retired, and no post job outlives the
--     update: `post_comment` and `post_reply` leave the job types, and the
--     trigger that projected them is replaced by one that only withdraws a
--     queued action (`packages/database/triggers.ts`, applied at launch).
ALTER TABLE "action_executions" DROP CONSTRAINT "action_executions_kind_check";--> statement-breakpoint
ALTER TABLE "action_executions" ADD CONSTRAINT "action_executions_kind_check" CHECK ("action_executions"."kind" in ('like_target', 'invite', 'accept_invite', 'dm', 'followup', 'withdraw_invite', 'room_reply', 'reply', 'comment'));
--> statement-breakpoint
DROP TRIGGER IF EXISTS messages_sync_post_job_ins ON messages;--> statement-breakpoint
DROP TRIGGER IF EXISTS messages_sync_post_job_upd ON messages;--> statement-breakpoint
DROP FUNCTION IF EXISTS engager_sync_post_job();--> statement-breakpoint
CREATE FUNCTION convert_comments(p_org uuid DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  m record;
  txt text;
  fence text;
  submitted bigint;
  gen bigint;
  aid bigint;
  yes boolean;
  chash text;
  tgt jsonb;
  cand jsonb;
  bind_n int;
  bind_id text;
  bind_mode text;
  observed text;
  now_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
BEGIN
  UPDATE jobs j
    SET status = 'done', last_error = 'superseded: comment action', updated_at = now_ms
    FROM messages msg
    WHERE msg.kind = 'comment' AND j.organization_id = msg.organization_id
      AND j.idempotency_key = 'post:' || msg.id AND j.status = 'queued'
      AND j.type IN ('post_comment', 'post_reply') AND (p_org IS NULL OR msg.organization_id = p_org);

  FOR m IN
    SELECT msg.*, c.channel_id AS channel, d.post_urn, d.author_profile_id AS post_author
    FROM messages msg
    JOIN campaigns c ON c.id = msg.campaign_id AND c.organization_id = msg.organization_id
    JOIN discovered_posts d ON d.id = msg.discovered_post_id AND d.organization_id = msg.organization_id
    WHERE msg.kind = 'comment' AND msg.status IN ('approved', 'posting', 'needs_review')
      AND c.channel_id IS NOT NULL AND (p_org IS NULL OR msg.organization_id = p_org)
    ORDER BY msg.id
  LOOP
    txt := coalesce(m.final_text, m.proposed_text);
    chash := encode(sha256(convert_to('["comment",' || to_json(txt)::text || ']', 'UTF8')), 'hex');
    tgt := jsonb_strip_nulls(jsonb_build_object(
      'kind', 'post', 'id', m.post_urn, 'urn', m.post_urn, 'postUrn', m.post_urn,
      'authorProfileId', m.post_author));
    cand := jsonb_build_object('text', txt, 'sources', '[]'::jsonb,
      'versions', jsonb_build_object('strategy', null, 'facts', '[]'::jsonb, 'memory', null, 'voice', null));
    SELECT coalesce(max(generation), 0) INTO gen FROM pause_controls WHERE organization_id = m.organization_id;
    submitted := coalesce(m.posting_started_at, m.last_attempt_at, m.created_at);
    aid := NULL;

    IF m.status = 'approved' THEN
      bind_id := NULL;
      bind_mode := NULL;
      IF m.publish_origin = 'worker' THEN
        SELECT count(*), min(b->>'action_binding_id'), min(b->>'mode') INTO bind_n, bind_id, bind_mode
          FROM campaign_strategies s, jsonb_array_elements(coalesce(s.document->'action_bindings', '[]'::jsonb)) b
          WHERE s.organization_id = m.organization_id AND s.campaign_id = m.campaign_id AND s.status = 'active'
            AND b->>'capability_ref' = 'publish_comment' AND coalesce(b->>'target', 'post') = 'post';
        IF bind_n <> 1 OR coalesce(bind_mode, 'off') NOT IN ('review', 'auto') THEN
          UPDATE messages SET status = 'proposed', scheduled_at = NULL, error = 'review_required'
            WHERE id = m.id AND organization_id = m.organization_id;
          CONTINUE;
        END IF;
      END IF;
      yes := m.publish_origin = 'owner';
      IF NOT yes THEN
        SELECT (f.verdict IN ('approve', 'edit') AND f.final_text_hash = encode(sha256(convert_to(txt, 'UTF8')), 'hex'))
          INTO yes
          FROM feedback f WHERE f.message_id = m.id ORDER BY f.id DESC LIMIT 1;
      END IF;
      INSERT INTO action_executions (
        organization_id, channel_id, campaign_id, author_profile_id, message_id, kind, purpose, sequence,
        idempotency_key, target, content_hash, candidate, origin, status, status_reason,
        generation_seen, created_at, updated_at, action_binding_id
      ) VALUES (
        m.organization_id, m.channel, m.campaign_id, m.target_profile_id, m.id, 'comment', 'opener', 1,
        'comment:' || m.channel || ':' || m.dedupe_key, tgt, chash, cand, m.publish_origin,
        CASE WHEN coalesce(yes, false) THEN 'approved' ELSE 'reserved' END, 'migrated_comment',
        gen, now_ms, now_ms, bind_id
      ) ON CONFLICT (organization_id, idempotency_key) DO NOTHING
      RETURNING id INTO aid;
      IF aid IS NOT NULL AND coalesce(yes, false) THEN
        INSERT INTO action_approvals (
          organization_id, action_execution_id, approver, content_hash, target_hash, dependency_versions,
          expires_at, created_at
        ) VALUES (
          m.organization_id, aid, 'migrated_comment', chash,
          encode(sha256(convert_to('["post",' || to_json(m.post_urn)::text || ',' || to_json(m.post_urn)::text || ']', 'UTF8')), 'hex'),
          jsonb_build_object('facts', '[]'::jsonb, 'memory', null, 'sources', '[]'::jsonb, 'authority', bind_mode,
            'strategy', null, 'voice', null),
          now_ms + 86400000, now_ms);
      END IF;
    ELSE
      fence := 'post:' || m.id || ':' || m.redraft_request_version;
      INSERT INTO action_executions (
        organization_id, channel_id, campaign_id, author_profile_id, message_id, kind, purpose, sequence,
        idempotency_key, target, content_hash, candidate, origin, status, status_reason, fence_token,
        generation_seen, submitted_at, attempts, created_at, updated_at
      ) VALUES (
        m.organization_id, m.channel, m.campaign_id, m.target_profile_id, m.id, 'comment', 'opener', 1,
        'comment:' || m.channel || ':' || m.dedupe_key, tgt, chash, cand,
        m.publish_origin, 'uncertain', 'migrated_comment', fence,
        gen, submitted,
        jsonb_build_array(jsonb_build_object(
          'attempt', 1, 'operationId', fence, 'epoch', 0, 'startedAt', submitted,
          'settledAt', NULL, 'outcome', NULL, 'settledBy', NULL, 'evidence', NULL)),
        submitted, now_ms
      ) ON CONFLICT (organization_id, idempotency_key) DO NOTHING
      RETURNING id INTO aid;
      IF aid IS NOT NULL THEN
        UPDATE messages SET status = 'needs_review', posting_started_at = NULL,
            error = coalesce(error, 'Posting was interrupted and the outcome could not be verified. Check LinkedIn, then say whether it went out.')
          WHERE id = m.id AND organization_id = m.organization_id;
      END IF;
    END IF;
    -- The drain reconciles an uncertain row and sends an approved one at its slot.
    IF aid IS NOT NULL THEN
      INSERT INTO jobs (organization_id, type, payload, status, attempts, max_attempts, next_run_at,
                        idempotency_key, created_at, updated_at)
      VALUES (m.organization_id, 'dispatch_actions', jsonb_build_object('channelId', m.channel), 'queued', 0, 5,
              now_ms, 'dispatch_actions:' || m.channel, now_ms, now_ms)
      ON CONFLICT (organization_id, idempotency_key) DO UPDATE SET
        next_run_at = least(jobs.next_run_at, EXCLUDED.next_run_at),
        status = CASE WHEN jobs.status IN ('done', 'dead', 'failed') THEN 'queued' ELSE jobs.status END,
        attempts = CASE WHEN jobs.status IN ('done', 'dead', 'failed') THEN 0 ELSE jobs.attempts END,
        updated_at = EXCLUDED.updated_at;
    END IF;
  END LOOP;

  FOR m IN
    SELECT msg.*, c.channel_id AS channel, j.id AS job_id, (j.payload->>'requestVersion')::int AS answer_version,
           d.post_urn, d.author_profile_id AS post_author
    FROM jobs j
    JOIN messages msg ON msg.id = (j.payload->>'messageId')::int AND msg.organization_id = j.organization_id
    JOIN campaigns c ON c.id = msg.campaign_id AND c.organization_id = msg.organization_id
    JOIN discovered_posts d ON d.id = msg.discovered_post_id AND d.organization_id = msg.organization_id
    WHERE j.type = 'reconcile_message_write' AND j.status = 'queued' AND msg.kind = 'comment'
      AND msg.status IN ('proposed', 'posted') AND c.channel_id IS NOT NULL
      AND (p_org IS NULL OR msg.organization_id = p_org)
      AND NOT EXISTS (SELECT 1 FROM action_executions a
        WHERE a.organization_id = msg.organization_id AND a.message_id = msg.id AND a.status IN ('dispatching', 'uncertain'))
    ORDER BY j.id
  LOOP
    txt := coalesce(m.final_text, m.proposed_text);
    observed := CASE WHEN m.status = 'posted' THEN 'went_out' ELSE 'not_sent' END;
    fence := 'post:' || m.id || ':' || (m.answer_version - 1);
    submitted := coalesce(m.posting_started_at, m.last_attempt_at, m.created_at);
    SELECT coalesce(max(generation), 0) INTO gen FROM pause_controls WHERE organization_id = m.organization_id;
    INSERT INTO action_executions (
      organization_id, channel_id, campaign_id, author_profile_id, message_id, kind, purpose, sequence,
      idempotency_key, target, content_hash, candidate, origin, status, status_reason, external_receipt, fence_token,
      generation_seen, submitted_at, attempts, created_at, updated_at
    ) VALUES (
      m.organization_id, m.channel, m.campaign_id, m.target_profile_id, m.id, 'comment', 'opener', 1,
      'comment:' || m.channel || ':' || m.dedupe_key || ':answered:' || m.answer_version,
      jsonb_strip_nulls(jsonb_build_object('kind', 'post', 'id', m.post_urn, 'urn', m.post_urn, 'postUrn', m.post_urn,
        'authorProfileId', m.post_author)),
      encode(sha256(convert_to('["comment",' || to_json(txt)::text || ']', 'UTF8')), 'hex'),
      jsonb_build_object('text', txt, 'sources', '[]'::jsonb,
        'versions', jsonb_build_object('strategy', null, 'facts', '[]'::jsonb, 'memory', null, 'voice', null)),
      m.publish_origin, 'uncertain', 'owner_answered:' || observed,
      jsonb_build_object('ownerAnswer', jsonb_strip_nulls(jsonb_build_object('observed', observed, 'by', 'migrated_answer',
        'target', CASE WHEN observed = 'went_out' THEN m.external_urn END, 'folded', true, 'version', m.answer_version))),
      fence, gen, submitted,
      jsonb_build_array(jsonb_build_object(
        'attempt', 1, 'operationId', fence, 'epoch', 0, 'startedAt', submitted,
        'settledAt', NULL, 'outcome', NULL, 'settledBy', NULL, 'evidence', NULL)),
      submitted, now_ms
    ) ON CONFLICT (organization_id, idempotency_key) DO NOTHING
    RETURNING id INTO aid;
    IF aid IS NOT NULL THEN
      UPDATE jobs SET status = 'done', last_error = 'folded into comment action', updated_at = now_ms WHERE id = m.job_id;
      INSERT INTO jobs (organization_id, type, payload, status, attempts, max_attempts, next_run_at,
                        idempotency_key, created_at, updated_at)
      VALUES (m.organization_id, 'dispatch_actions', jsonb_build_object('channelId', m.channel), 'queued', 0, 5,
              now_ms, 'dispatch_actions:' || m.channel, now_ms, now_ms)
      ON CONFLICT (organization_id, idempotency_key) DO UPDATE SET
        next_run_at = least(jobs.next_run_at, EXCLUDED.next_run_at),
        status = CASE WHEN jobs.status IN ('done', 'dead', 'failed') THEN 'queued' ELSE jobs.status END,
        attempts = CASE WHEN jobs.status IN ('done', 'dead', 'failed') THEN 0 ELSE jobs.attempts END,
        updated_at = EXCLUDED.updated_at;
    END IF;
  END LOOP;

  UPDATE messages msg
    SET status = 'failed', scheduled_at = NULL, last_attempt_at = now_ms,
        error_code = CASE WHEN EXISTS (SELECT 1 FROM campaigns c WHERE c.id = msg.campaign_id AND c.organization_id = msg.organization_id)
          THEN 'target_missing' ELSE 'campaign_missing' END,
        error = CASE WHEN EXISTS (SELECT 1 FROM campaigns c WHERE c.id = msg.campaign_id AND c.organization_id = msg.organization_id)
          THEN 'target_missing' ELSE 'campaign_missing' END
    WHERE msg.kind = 'comment' AND msg.status = 'approved' AND (p_org IS NULL OR msg.organization_id = p_org)
      AND NOT EXISTS (SELECT 1 FROM action_executions a
        WHERE a.organization_id = msg.organization_id AND a.message_id = msg.id AND a.kind = 'comment');
END
$fn$;--> statement-breakpoint
DO $$ BEGIN
  IF current_setting('is_superuser') <> 'on' AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolbypassrls) THEN
    RAISE EXCEPTION 'Data migration requires a role with BYPASSRLS';
  END IF;
END $$;
--> statement-breakpoint
SELECT convert_comments();--> statement-breakpoint
DELETE FROM jobs WHERE type IN ('post_comment', 'post_reply');
