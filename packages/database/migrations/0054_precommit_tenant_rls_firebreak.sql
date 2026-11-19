-- Vercel can activate application code before the migration workflow finishes.
-- The owner also grants new tables to engager_app by default, so tenant tables
-- must receive ENABLE + FORCE RLS and their final policy family in the same
-- Drizzle migration transaction that creates them. applyRls() still reconciles
-- every policy after migrate() returns; this migration closes the commit-to-
-- reconciliation window and is intentionally idempotent for already-migrated dev.
DO $tenant_rls_firebreak$
DECLARE
	table_name text;
	tenant_tables constant text[] := ARRAY[
		'leads',
		'unipile_connection_intents',
		'candidate_feedback',
		'runner_context_epochs',
		'runner_draft_schedules',
		'runner_protocol_transitions',
		'runner_work_events',
		'runner_work_orders',
		'candidate_actions',
		'candidate_mutation_receipts',
		'radar_daily_opportunities'
	];
	ordinary_tables constant text[] := ARRAY[
		'leads',
		'unipile_connection_intents',
		'candidate_feedback',
		'runner_draft_schedules',
		'candidate_actions'
	];
	limited_write_tables constant text[] := ARRAY[
		'runner_work_events',
		'runner_work_orders',
		'runner_protocol_transitions',
		'runner_context_epochs',
		'candidate_mutation_receipts',
		'radar_daily_opportunities'
	];
BEGIN
	FOREACH table_name IN ARRAY tenant_tables LOOP
		EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
		EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
		EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', table_name);
		EXECUTE format('DROP POLICY IF EXISTS tenant_read ON public.%I', table_name);
		EXECUTE format('DROP POLICY IF EXISTS tenant_append ON public.%I', table_name);
		EXECUTE format('DROP POLICY IF EXISTS tenant_update ON public.%I', table_name);
		EXECUTE format('DROP POLICY IF EXISTS tenant_retention_delete ON public.%I', table_name);
	END LOOP;

	FOREACH table_name IN ARRAY ordinary_tables LOOP
		EXECUTE format(
			'CREATE POLICY tenant_isolation ON public.%I ' ||
			'USING (organization_id = nullif(current_setting(''app.current_org'', true), '''')::uuid) ' ||
			'WITH CHECK (organization_id = nullif(current_setting(''app.current_org'', true), '''')::uuid)',
			table_name
		);
	END LOOP;

	FOREACH table_name IN ARRAY limited_write_tables LOOP
		EXECUTE format(
			'CREATE POLICY tenant_read ON public.%I FOR SELECT ' ||
			'USING (organization_id = nullif(current_setting(''app.current_org'', true), '''')::uuid)',
			table_name
		);
		EXECUTE format(
			'CREATE POLICY tenant_append ON public.%I FOR INSERT ' ||
			'WITH CHECK (organization_id = nullif(current_setting(''app.current_org'', true), '''')::uuid)',
			table_name
		);
	END LOOP;

	CREATE POLICY tenant_update ON public.runner_work_orders FOR UPDATE
		USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
		WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);

	CREATE POLICY tenant_retention_delete ON public.runner_work_orders FOR DELETE
		USING (
			organization_id = nullif(current_setting('app.current_org', true), '')::uuid
			AND status IN ('completed','partial','failed','expired','cancelled')
			AND coalesce(completed_at, updated_at) <
				(extract(epoch FROM clock_timestamp()) * 1000)::bigint - 7776000000
		);

	CREATE POLICY tenant_retention_delete ON public.runner_work_events FOR DELETE
		USING (
			organization_id = nullif(current_setting('app.current_org', true), '')::uuid
			AND (item_type <> 'system' OR input_id LIKE 'submission:%')
			AND EXISTS (
				SELECT 1 FROM public.runner_work_orders rwo
				WHERE rwo.id = public.runner_work_events.work_order_id
					AND rwo.organization_id = public.runner_work_events.organization_id
					AND rwo.status IN ('completed','partial','failed','expired','cancelled')
			)
			AND created_at <
				(extract(epoch FROM clock_timestamp()) * 1000)::bigint - 2592000000
		);
END
$tenant_rls_firebreak$;
