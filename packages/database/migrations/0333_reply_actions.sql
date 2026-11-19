-- A public reply sends as a `reply` action. The kind joins the action ledger's,
-- and its row names the `messages` row that holds the words (`message_id`), the
-- record every surface of the reply reads.
--
-- `convert_replies` is the whole conversion, so a restored pre-update archive
-- runs the same one (`portable-restore.ts`). Nothing sends twice:
--   * an approved reply with the owner's yes on its exact words (or the
--     owner's own words) becomes an `approved` action carrying that yes; any
--     other (an Automatic proposal nobody said yes to) becomes `reserved`, with
--     no binding, which the gate sends back to the owner. Its slot stays on the
--     message;
--   * a reply that was posting, or parked for review, becomes an `uncertain`
--     action fenced to the operation it went out under: it may have reached
--     LinkedIn, so nothing presses again until a read of the thread or the
--     owner says what happened. Its message waits for review;
--   * the queued `post:` job of each is retired: the message no longer
--     projects one.
ALTER TABLE "action_executions" DROP CONSTRAINT "action_executions_kind_check";--> statement-breakpoint
ALTER TABLE "action_executions" ADD CONSTRAINT "action_executions_kind_check" CHECK ("action_executions"."kind" in ('like_target', 'invite', 'accept_invite', 'dm', 'followup', 'withdraw_invite', 'room_reply', 'reply'));--> statement-breakpoint
CREATE FUNCTION convert_replies(p_org uuid DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $fn$
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
  now_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
BEGIN
  UPDATE jobs j
    SET status = 'done', last_error = 'superseded: reply action', updated_at = now_ms
    FROM messages msg
    WHERE msg.kind = 'reply' AND j.organization_id = msg.organization_id
      AND j.idempotency_key = 'post:' || msg.id AND j.status = 'queued'
      AND j.type IN ('post_comment', 'post_reply') AND (p_org IS NULL OR msg.organization_id = p_org);

  FOR m IN
    SELECT msg.*, c.channel_id AS channel, inc.comment_urn, inc.own_post_urn, inc.author_profile_id AS inc_author,
           inc.text_hash, inc.source AS inc_source
    FROM messages msg
    JOIN campaigns c ON c.id = msg.campaign_id AND c.organization_id = msg.organization_id
    JOIN incoming_comments inc ON inc.id = msg.incoming_comment_id AND inc.organization_id = msg.organization_id
    WHERE msg.kind = 'reply' AND msg.status IN ('approved', 'posting', 'needs_review')
      AND c.channel_id IS NOT NULL AND (p_org IS NULL OR msg.organization_id = p_org)
    ORDER BY msg.id
  LOOP
    txt := coalesce(m.final_text, m.proposed_text);
    chash := encode(sha256(convert_to('["reply",' || to_json(txt)::text || ']', 'UTF8')), 'hex');
    tgt := jsonb_strip_nulls(jsonb_build_object(
      'kind', 'their_reply', 'id', m.comment_urn, 'urn', m.comment_urn, 'postUrn', m.own_post_urn,
      'authorProfileId', m.inc_author, 'textHash', m.text_hash,
      'ownPost', CASE WHEN m.inc_source = 'own_post' THEN true END));
    cand := jsonb_build_object('text', txt, 'sources', '[]'::jsonb,
      'versions', jsonb_build_object('strategy', null, 'facts', '[]'::jsonb, 'memory', null, 'voice', null));
    SELECT coalesce(max(generation), 0) INTO gen FROM pause_controls WHERE organization_id = m.organization_id;
    submitted := coalesce(m.posting_started_at, m.last_attempt_at, m.created_at);
    aid := NULL;

    IF m.status = 'approved' THEN
      yes := m.publish_origin = 'owner';
      IF NOT yes THEN
        SELECT (f.verdict IN ('approve', 'edit') AND f.message_request_version = m.redraft_request_version
            AND f.final_text_hash = encode(sha256(convert_to(txt, 'UTF8')), 'hex'))
          INTO yes
          FROM feedback f WHERE f.message_id = m.id ORDER BY f.id DESC LIMIT 1;
      END IF;
      INSERT INTO action_executions (
        organization_id, channel_id, campaign_id, author_profile_id, message_id, kind, purpose, sequence,
        idempotency_key, target, content_hash, candidate, origin, status, status_reason,
        generation_seen, created_at, updated_at
      ) VALUES (
        m.organization_id, m.channel, m.campaign_id, m.target_profile_id, m.id, 'reply', 'reply', 1,
        'reply:' || m.channel || ':' || m.dedupe_key, tgt, chash, cand, m.publish_origin,
        CASE WHEN coalesce(yes, false) THEN 'approved' ELSE 'reserved' END, 'migrated_reply',
        gen, now_ms, now_ms
      ) ON CONFLICT (organization_id, idempotency_key) DO NOTHING
      RETURNING id INTO aid;
      IF aid IS NOT NULL AND coalesce(yes, false) THEN
        INSERT INTO action_approvals (
          organization_id, action_execution_id, approver, content_hash, target_hash, dependency_versions,
          expires_at, created_at
        ) VALUES (
          m.organization_id, aid, 'migrated_reply', chash,
          encode(sha256(convert_to('["their_reply",' || to_json(m.comment_urn)::text || ',' || to_json(m.comment_urn)::text || ']', 'UTF8')), 'hex'),
          jsonb_build_object('facts', '[]'::jsonb, 'memory', null, 'sources', '[]'::jsonb, 'authority', null,
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
        m.organization_id, m.channel, m.campaign_id, m.target_profile_id, m.id, 'reply', 'reply', 1,
        'reply:' || m.channel || ':' || m.dedupe_key, tgt, chash, cand,
        m.publish_origin, 'uncertain', 'migrated_reply', fence,
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

END
$fn$;--> statement-breakpoint
DO $$ BEGIN
  IF current_setting('is_superuser') <> 'on' AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolbypassrls) THEN
    RAISE EXCEPTION 'Data migration requires a role with BYPASSRLS';
  END IF;
END $$;
--> statement-breakpoint
SELECT convert_replies();
