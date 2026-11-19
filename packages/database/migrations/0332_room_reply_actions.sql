-- A room reply sends as a `room_reply` action. The kind joins the action
-- ledger's, and its row names the `messages` row that holds the words
-- (`message_id`), the record every surface of the reply reads.
--
-- `convert_room_replies` is the whole conversion, so a restored pre-update
-- archive runs the same one (`portable-restore.ts`). Nothing sends twice:
--   * an approved reply with the owner's yes on its exact words becomes an
--     `approved` action carrying that yes; any other (an Automatic proposal
--     nobody said yes to) becomes `reserved`, with no binding, which the gate
--     sends back to the owner. Its slot stays on the message;
--   * a reply that was posting, or parked for review, becomes an `uncertain`
--     action fenced to the operation it went out under: it may have reached
--     LinkedIn, so nothing presses again until a read of the thread or the
--     owner says what happened. Its message waits for review;
--   * the queued `post:` job of each is retired: the message no longer
--     projects one.
ALTER TABLE "action_executions" DROP CONSTRAINT "action_executions_kind_check";--> statement-breakpoint
ALTER TABLE "action_executions" ADD CONSTRAINT "action_executions_kind_check" CHECK ("action_executions"."kind" in ('like_target', 'invite', 'accept_invite', 'dm', 'followup', 'withdraw_invite', 'room_reply'));--> statement-breakpoint
CREATE FUNCTION convert_room_replies(p_org uuid DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  m record;
  txt text;
  urn text;
  key text;
  tgt jsonb;
  cand jsonb;
  chash text;
  fence text;
  submitted bigint;
  attempt jsonb;
  gen bigint;
  yes boolean;
  aid bigint;
  now_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
BEGIN
  UPDATE jobs j
    SET status = 'done', last_error = 'superseded: room reply action', updated_at = now_ms
    FROM messages msg
    WHERE msg.kind = 'room_reply' AND j.organization_id = msg.organization_id
      AND j.idempotency_key = 'post:' || msg.id AND j.status = 'queued'
      AND j.type IN ('post_comment', 'post_reply') AND (p_org IS NULL OR msg.organization_id = p_org);

  FOR m IN
    SELECT msg.*, c.channel_id AS channel
    FROM messages msg
    JOIN campaigns c ON c.id = msg.campaign_id AND c.organization_id = msg.organization_id
    WHERE msg.kind = 'room_reply' AND msg.status IN ('approved', 'posting', 'needs_review')
      AND c.channel_id IS NOT NULL AND (p_org IS NULL OR msg.organization_id = p_org)
    ORDER BY msg.id
  LOOP
    urn := m.room_reply_target ->> 'parentCommentUrn';
    CONTINUE WHEN urn IS NULL;
    txt := coalesce(m.final_text, m.proposed_text);
    key := 'room:' || m.channel || ':' || m.dedupe_key;
    tgt := jsonb_strip_nulls(jsonb_build_object(
      'kind', 'room_comment', 'id', urn, 'urn', urn,
      'postUrn', m.room_reply_target ->> 'postUrn', 'memberUrn', m.room_reply_target ->> 'memberUrn'));
    cand := jsonb_build_object(
      'text', txt, 'sources', '[]'::jsonb,
      'versions', jsonb_build_object('strategy', null, 'facts', '[]'::jsonb, 'memory', null, 'voice', null));
    IF m.assist_retention IS NOT NULL THEN
      cand := cand || jsonb_build_object('assist',
        jsonb_build_object('assistRetention', m.assist_retention, 'ownerOrigin', m.owner_origin));
    END IF;
    chash := encode(sha256(convert_to('["room_reply",' || to_json(txt)::text || ']', 'UTF8')), 'hex');
    SELECT coalesce(max(generation), 0) INTO gen FROM pause_controls WHERE organization_id = m.organization_id;
    submitted := coalesce(m.posting_started_at, m.last_attempt_at, m.created_at);
    aid := NULL;
    yes := NULL;

    IF m.status = 'approved' THEN
      SELECT (f.verdict IN ('approve', 'edit') AND f.decision_origin IN ('dashboard', 'mcp_app')
          AND f.message_request_version = m.redraft_request_version
          AND f.final_text_hash = encode(sha256(convert_to(txt, 'UTF8')), 'hex'))
        INTO yes
        FROM feedback f WHERE f.message_id = m.id ORDER BY f.id DESC LIMIT 1;
      INSERT INTO action_executions (
        organization_id, channel_id, campaign_id, author_profile_id, message_id, kind, purpose, sequence,
        idempotency_key, target, content_hash, candidate, origin, status, status_reason,
        generation_seen, created_at, updated_at
      ) VALUES (
        m.organization_id, m.channel, m.campaign_id, m.target_profile_id, m.id, 'room_reply', 'reply', 1,
        key, tgt, chash, cand, m.publish_origin,
        CASE WHEN coalesce(yes, false) THEN 'approved' ELSE 'reserved' END, 'migrated_room_reply',
        gen, now_ms, now_ms
      ) ON CONFLICT (organization_id, idempotency_key) DO NOTHING
      RETURNING id INTO aid;
      IF aid IS NOT NULL AND coalesce(yes, false) THEN
        INSERT INTO action_approvals (
          organization_id, action_execution_id, approver, content_hash, target_hash, dependency_versions,
          expires_at, created_at
        ) VALUES (
          m.organization_id, aid, 'migrated_room_reply', chash,
          encode(sha256(convert_to('["room_comment",' || to_json(urn)::text || ',' || to_json(urn)::text || ']', 'UTF8')), 'hex'),
          jsonb_build_object('facts', '[]'::jsonb, 'memory', null, 'sources', '[]'::jsonb, 'authority', null,
            'strategy', null, 'voice', null),
          now_ms + 86400000, now_ms);
      END IF;
    ELSE
      fence := 'post:' || m.id || ':' || m.redraft_request_version;
      attempt := jsonb_build_object(
        'attempt', 1, 'operationId', fence, 'epoch', 0, 'startedAt', submitted,
        'settledAt', NULL, 'outcome', NULL, 'settledBy', NULL, 'evidence', NULL);
      INSERT INTO action_executions (
        organization_id, channel_id, campaign_id, author_profile_id, message_id, kind, purpose, sequence,
        idempotency_key, target, content_hash, candidate, origin, status, status_reason, fence_token,
        generation_seen, submitted_at, attempts, created_at, updated_at
      ) VALUES (
        m.organization_id, m.channel, m.campaign_id, m.target_profile_id, m.id, 'room_reply', 'reply', 1,
        key, tgt, chash, cand, m.publish_origin, 'uncertain', 'migrated_room_reply', fence,
        gen, submitted, jsonb_build_array(attempt), submitted, now_ms
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
END
$fn$;--> statement-breakpoint
DO $$ BEGIN
  IF current_setting('is_superuser') <> 'on' AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolbypassrls) THEN
    RAISE EXCEPTION 'Data migration requires a role with BYPASSRLS';
  END IF;
END $$;
--> statement-breakpoint
SELECT convert_room_replies();
