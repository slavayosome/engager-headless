ALTER TABLE "campaigns" ALTER COLUMN "lead_mode" SET DEFAULT true;
--> statement-breakpoint
DELETE FROM "jobs" WHERE "type" = 'lead_backtest';
--> statement-breakpoint
-- Retire Find posts under each tenant's RLS context. Keep the campaign and
-- its history, but take back all work that has not reached a provider.
DO $$
DECLARE
  tenant_id uuid;
  retired_ids bigint[];
  expected_count integer;
  actual_count integer;
  now_ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000);
  previous_org text := current_setting('app.current_org', true);
BEGIN
  FOR tenant_id IN SELECT id FROM organizations LOOP
    PERFORM set_config('app.current_org', tenant_id::text, true);
    SELECT coalesce(array_agg(c.id), ARRAY[]::bigint[]) INTO retired_ids
    FROM campaigns c
    WHERE c.organization_id = tenant_id AND c.deleted_at IS NULL
      AND (EXISTS (SELECT 1 FROM campaign_definitions d
        WHERE d.organization_id = tenant_id AND d.campaign_id = c.id
          AND d.status IN ('active', 'draft')
          AND d.document->'steps' @> '[{"catalog_step":"find_posts"}]'::jsonb)
        OR (NOT c.lead_mode AND NOT EXISTS (SELECT 1 FROM campaign_definitions d
          WHERE d.organization_id = tenant_id AND d.campaign_id = c.id
            AND d.status IN ('active', 'draft'))));
    expected_count := cardinality(retired_ids);

    UPDATE action_approvals SET invalidated_at = now_ms, invalidated_reason = 'cancelled:campaign_deleted'
    WHERE organization_id = tenant_id AND used_at IS NULL AND invalidated_at IS NULL
      AND action_execution_id IN (SELECT id FROM action_executions WHERE organization_id = tenant_id
        AND campaign_id = ANY(retired_ids) AND status IN ('reserved', 'awaiting_review', 'approved'));
    UPDATE live_checks SET state = 'closed', closed_reason = 'not_sent:cancelled', updated_at = now_ms
    WHERE organization_id = tenant_id AND state = 'writing'
      AND action_execution_id IN (SELECT id FROM action_executions WHERE organization_id = tenant_id
        AND campaign_id = ANY(retired_ids) AND status IN ('reserved', 'awaiting_review', 'approved'));
    UPDATE action_executions SET status = 'cancelled', status_reason = 'cancelled:campaign_deleted',
      settled_at = now_ms, updated_at = now_ms
    WHERE organization_id = tenant_id AND campaign_id = ANY(retired_ids)
      AND status IN ('reserved', 'awaiting_review', 'approved');
    UPDATE messages SET status = 'rejected', error = 'cancelled:campaign_deleted', scheduled_at = NULL
    WHERE organization_id = tenant_id AND campaign_id = ANY(retired_ids) AND status IN ('proposed', 'approved');
    UPDATE jobs SET status = 'done', last_error = 'cancelled:campaign_deleted', updated_at = now_ms
    WHERE organization_id = tenant_id AND status = 'queued' AND (
      (type = 'worker_run' AND payload->>'workerId' IN
        (SELECT id::text FROM workers WHERE organization_id = tenant_id AND campaign_id = ANY(retired_ids)))
      OR payload->>'campaignId' IN (SELECT unnest(retired_ids)::text)
      OR (type IN ('post_comment', 'post_reply') AND payload->>'messageId' IN
        (SELECT id::text FROM messages WHERE organization_id = tenant_id AND campaign_id = ANY(retired_ids)
          AND status = 'rejected' AND error = 'cancelled:campaign_deleted'))
      OR id::text IN (SELECT wait->>'timeoutJobId' FROM step_runs WHERE organization_id = tenant_id
        AND campaign_id = ANY(retired_ids) AND status = 'waiting' AND wait->>'consumedAt' IS NULL));
    UPDATE step_runs SET wait = wait || jsonb_build_object('consumedAt', now_ms, 'consumedBy', 'owner'), updated_at = now_ms
    WHERE organization_id = tenant_id AND campaign_id = ANY(retired_ids) AND status = 'waiting'
      AND wait IS NOT NULL AND wait->>'consumedAt' IS NULL;
    UPDATE workers SET enabled = false, next_run_at = NULL, updated_at = now_ms
    WHERE organization_id = tenant_id AND campaign_id = ANY(retired_ids);
    UPDATE automations SET enabled = false, next_run_at = NULL, updated_at = now_ms
    WHERE organization_id = tenant_id AND campaign_id = ANY(retired_ids);
    UPDATE journeys SET owning_campaign_id = NULL, updated_at = now_ms
    WHERE organization_id = tenant_id AND owning_campaign_id = ANY(retired_ids) AND closed_reason IS NULL;
    UPDATE pause_controls SET resumed_at = now_ms, resumed_by = 'migration'
    WHERE organization_id = tenant_id AND scope = 'campaign' AND scope_id = ANY(retired_ids)
      AND resumed_at IS NULL AND reason <> 'takeover';
    UPDATE chat_pending_changes SET status = 'stale', decided_at = now_ms,
      outcome = jsonb_build_object('campaignDeleted', (payload->>'campaignId')::bigint)
    WHERE organization_id = tenant_id AND status = 'pending'
      AND kind IN ('campaign.switch_scout', 'definition.patch', 'campaign.delete')
      AND payload->>'campaignId' IN (SELECT unnest(retired_ids)::text);
    UPDATE campaigns SET status = 'archived', deleted_at = now_ms, updated_at = now_ms,
      status_changed_at = CASE WHEN status <> 'archived' THEN now_ms ELSE status_changed_at END,
      status_changed_by = CASE WHEN status <> 'archived' THEN 'system' ELSE status_changed_by END
    WHERE organization_id = tenant_id AND id = ANY(retired_ids) AND deleted_at IS NULL;
    GET DIAGNOSTICS actual_count = ROW_COUNT;
    IF actual_count <> expected_count THEN RAISE EXCEPTION 'retired campaign count changed'; END IF;
    UPDATE leads l SET campaign_id = pick.campaign_id, updated_at = now_ms
    FROM (SELECT DISTINCT ON (s.lead_id) s.lead_id, s.campaign_id FROM lead_signals s
      JOIN campaigns c ON c.id = s.campaign_id AND c.organization_id = tenant_id AND c.deleted_at IS NULL
      WHERE s.organization_id = tenant_id ORDER BY s.lead_id, coalesce(s.said_at, s.seen_at) DESC, s.id DESC) pick
    WHERE l.organization_id = tenant_id AND l.campaign_id = ANY(retired_ids) AND l.id = pick.lead_id;
    UPDATE campaigns SET lead_mode = true WHERE organization_id = tenant_id AND deleted_at IS NULL AND NOT lead_mode;
  END LOOP;
  PERFORM set_config('app.current_org', coalesce(previous_org, ''), true);
END $$;
