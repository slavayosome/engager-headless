-- Every like is a `like_target` action. The action ledger gains the message a
-- like rides with (`message_id`), one reaction identity per post or comment,
-- and the like receipts in `rate_limit_ledger.meta` move onto action rows.
--
-- `convert_like_receipts` is the whole conversion, so a restored pre-update
-- archive runs the same one (`portable-restore.ts`):
--   * a like of one comment is one identity whichever target kind aimed it
--     (their reply, the comment it answers, a room comment): the key names
--     "comment", not the kind. Where several actions hold one comment, the one
--     furthest along keeps the key and the queued others are cancelled;
--   * a succeeded receipt becomes a `confirmed` action under that key, so no
--     later action presses the target again. Its ledger row stays as it is;
--   * an open receipt (`reserved` or `uncertain`) becomes an `uncertain`
--     action fenced to the holder it took: it may or may not have reached its
--     click, so nothing presses again until the gate reads the post back or the
--     owner says what they saw. Where the target already has an action, that
--     action takes the obligation instead (a `confirmed` one already answers
--     it); a queued one is fenced uncertain, never left to press.
ALTER TABLE "action_executions" ADD COLUMN "message_id" bigint;--> statement-breakpoint
CREATE INDEX "action_executions_org_message_idx" ON "action_executions" USING btree ("organization_id","message_id");--> statement-breakpoint
CREATE FUNCTION convert_like_receipts(p_org uuid DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  r record;
  existing record;
  aim jsonb;
  fence text;
  comment_urn text;
  key text;
  submitted bigint;
  settled bigint;
  attempt jsonb;
  aid bigint;
  holder text;
  now_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
BEGIN
  WITH ranked AS (
    SELECT id,
      row_number() OVER (
        PARTITION BY organization_id, channel_id, (CASE WHEN target->>'kind' = 'post' THEN 'post' ELSE 'comment' END), target->>'id'
        ORDER BY (CASE WHEN status IN ('dispatching', 'uncertain') THEN 0 WHEN status = 'confirmed' THEN 1
                       WHEN status IN ('approved', 'reserved', 'awaiting_review') THEN 2 ELSE 3 END), id DESC) AS rn
    FROM action_executions
    WHERE kind = 'like_target' AND (p_org IS NULL OR organization_id = p_org)
  )
  UPDATE action_executions a
    SET idempotency_key = CASE WHEN ranked.rn = 1
          THEN 'react:' || a.channel_id || ':' || (CASE WHEN a.target->>'kind' = 'post' THEN 'post' ELSE 'comment' END) || ':' || (a.target->>'id') || ':like'
          ELSE a.idempotency_key END,
        status = CASE WHEN ranked.rn > 1 AND a.status IN ('awaiting_review', 'approved', 'reserved') THEN 'cancelled' ELSE a.status END,
        status_reason = CASE WHEN ranked.rn > 1 AND a.status IN ('awaiting_review', 'approved', 'reserved') THEN 'duplicate_reaction' ELSE a.status_reason END,
        settled_at = CASE WHEN ranked.rn > 1 AND a.status IN ('awaiting_review', 'approved', 'reserved') THEN now_ms ELSE a.settled_at END
    FROM ranked WHERE a.id = ranked.id;
  UPDATE action_approvals p SET invalidated_at = now_ms, invalidated_reason = 'duplicate_reaction'
    FROM action_executions a
    WHERE p.action_execution_id = a.id AND a.status = 'cancelled' AND a.status_reason = 'duplicate_reaction'
      AND p.used_at IS NULL AND p.invalidated_at IS NULL AND (p_org IS NULL OR a.organization_id = p_org);

  FOR r IN
    SELECT l.id, l.organization_id, l.campaign_id, l.target_profile_id, l.message_id, l.ts, l.meta,
           coalesce(l.channel_id, ((l.meta->'execution')->>'channelId')::bigint) AS channel_id
    FROM rate_limit_ledger l
    WHERE l.action = 'like'
      AND (l.meta->>'kind') IN ('standalone_like_receipt', 'followup_like_receipt', 'dismissal_like_receipt')
      AND (l.meta->>'state') IN ('reserved', 'uncertain', 'succeeded')
      AND (p_org IS NULL OR l.organization_id = p_org)
    ORDER BY ((l.meta->>'state') = 'succeeded') DESC, l.id DESC
  LOOP
    CONTINUE WHEN r.channel_id IS NULL;
    fence := CASE r.meta->>'kind'
      WHEN 'followup_like_receipt' THEN 'followup:' || r.id
      WHEN 'dismissal_like_receipt' THEN 'dismissal:' || r.id
      ELSE 'like:' || r.id || ':' || coalesce(r.meta->>'attempts', '1')
    END;
    comment_urn := r.meta->>'commentUrn';
    IF comment_urn IS NULL THEN
      aim := jsonb_build_object('kind', 'post', 'id', r.meta->>'postUrn', 'urn', r.meta->>'postUrn');
      key := 'react:' || r.channel_id || ':post:' || (aim->>'id') || ':like';
    ELSE
      aim := jsonb_build_object(
        'kind', 'room_comment',
        'id', coalesce(
          substring(comment_urn from ',([A-Za-z0-9_-]+)\)$'),
          substring(comment_urn from '^urn:li:comment:([A-Za-z0-9_-]+)$'),
          comment_urn),
        'urn', comment_urn,
        'postUrn', r.meta->>'postUrn');
      key := 'react:' || r.channel_id || ':comment:' || (aim->>'id') || ':like';
    END IF;
    submitted := coalesce((r.meta->>'reservedAt')::bigint, r.ts);
    settled := coalesce((r.meta->>'settledAt')::bigint, r.ts);
    attempt := jsonb_build_object(
      'attempt', 1, 'operationId', fence, 'epoch', coalesce(((r.meta->'execution')->>'epoch')::int, 0),
      'startedAt', submitted, 'settledAt', NULL, 'outcome', NULL, 'settledBy', NULL, 'evidence', NULL);
    aid := NULL;

    IF (r.meta->>'state') = 'succeeded' THEN
      INSERT INTO action_executions (
        organization_id, channel_id, campaign_id, author_profile_id, message_id, kind, purpose, sequence,
        idempotency_key, target, content_hash, candidate, origin, status, status_reason, fence_token,
        generation_seen, submitted_at, external_receipt, attempts, created_at, updated_at, settled_at
      ) VALUES (
        r.organization_id, r.channel_id, r.campaign_id, r.target_profile_id, r.message_id, 'like_target', 'reaction', 1,
        key, aim, encode(sha256('["like_target",null]'::bytea), 'hex'),
        '{"text":null,"sources":[],"versions":{"strategy":null,"facts":[],"memory":null,"voice":null}}'::jsonb,
        CASE WHEN (r.meta->>'kind') = 'dismissal_like_receipt' AND (r.meta->>'origin') = 'owner' THEN 'owner' ELSE 'worker' END,
        'confirmed', 'migrated_receipt', fence, 0, submitted,
        '{"migrated":true,"status":"confirmed"}'::jsonb,
        jsonb_build_array(attempt || jsonb_build_object('settledAt', settled, 'outcome', 'confirmed', 'settledBy', 'gate')),
        submitted, settled, settled
      )
      ON CONFLICT (organization_id, idempotency_key) DO NOTHING;
      -- Already liked: whatever else waits on the target has nothing left to press.
      UPDATE action_executions SET status = 'confirmed', status_reason = 'already_liked', settled_at = settled, updated_at = now_ms,
          external_receipt = '{"migrated":true,"status":"confirmed","noop":true}'::jsonb
        WHERE organization_id = r.organization_id AND idempotency_key = key
          AND status IN ('awaiting_review', 'approved', 'reserved', 'cancelled', 'blocked', 'definitely_not_sent');
      CONTINUE;
    END IF;

    SELECT execution_holder INTO holder FROM channels WHERE id = r.channel_id;
    INSERT INTO action_executions (
      organization_id, channel_id, campaign_id, author_profile_id, message_id, kind, purpose, sequence,
      idempotency_key, target, content_hash, candidate, origin, status, status_reason, fence_token,
      generation_seen, submitted_at, attempts, created_at, updated_at
    ) VALUES (
      r.organization_id, r.channel_id, r.campaign_id, r.target_profile_id, r.message_id, 'like_target', 'reaction', 1,
      key, aim, encode(sha256('["like_target",null]'::bytea), 'hex'),
      '{"text":null,"sources":[],"versions":{"strategy":null,"facts":[],"memory":null,"voice":null}}'::jsonb,
      CASE WHEN (r.meta->>'kind') = 'dismissal_like_receipt' AND (r.meta->>'origin') = 'owner' THEN 'owner' ELSE 'worker' END,
      'uncertain', 'migrated_receipt', fence, 0, submitted, jsonb_build_array(attempt), submitted, submitted
    )
    ON CONFLICT (organization_id, idempotency_key) DO NOTHING
    RETURNING id INTO aid;
    IF aid IS NULL THEN
      SELECT * INTO existing FROM action_executions
        WHERE organization_id = r.organization_id AND idempotency_key = key FOR UPDATE;
      IF existing.status IN ('dispatching', 'uncertain') THEN
        -- Its own attempt keeps the fence, unless this receipt holds the account.
        IF holder = fence THEN
          UPDATE action_executions SET fence_token = fence,
              attempts = existing.attempts || jsonb_build_array(attempt || jsonb_build_object('attempt', jsonb_array_length(existing.attempts) + 1))
            WHERE id = existing.id;
          aid := existing.id;
        END IF;
      ELSIF existing.status <> 'confirmed' THEN
        UPDATE action_executions SET status = 'uncertain', status_reason = 'migrated_receipt', fence_token = fence,
            submitted_at = submitted, settled_at = NULL, updated_at = now_ms,
            message_id = coalesce(existing.message_id, r.message_id),
            attempts = existing.attempts || jsonb_build_array(attempt || jsonb_build_object('attempt', jsonb_array_length(existing.attempts) + 1))
          WHERE id = existing.id;
        UPDATE action_approvals SET invalidated_at = now_ms, invalidated_reason = 'migrated_receipt'
          WHERE action_execution_id = existing.id AND used_at IS NULL AND invalidated_at IS NULL;
        aid := existing.id;
      END IF;
    END IF;
    IF aid IS NULL THEN
      UPDATE rate_limit_ledger
        SET meta = r.meta || jsonb_build_object('state', 'cancelled_before_provider', 'error', 'superseded by a like action')
        WHERE id = r.id;
    ELSE
      UPDATE rate_limit_ledger
        SET action = 'like_target',
            meta = jsonb_build_object('kind', 'action_execution_receipt', 'actionExecutionId', aid, 'operationId', fence, 'state', 'uncertain')
        WHERE id = r.id;
      UPDATE messages
        SET like_outcome = jsonb_set(like_outcome, '{receiptId}', to_jsonb(aid))
        WHERE id = r.message_id AND organization_id = r.organization_id AND like_outcome IS NOT NULL;
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
SELECT convert_like_receipts();
