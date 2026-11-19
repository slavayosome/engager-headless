-- 0079 already shipped release_transaction_id and the setup-proof evidence
-- constraint; drizzle re-flagged them because the 0079/0081 snapshots lagged
-- the schema. The 0082 snapshot now absorbs that drift; only the new column
-- may run here — re-adding the others would roll this migration back on
-- dev/prod (see migrate-reach-columns trap).
ALTER TABLE "discovered_posts" ADD COLUMN "agent_angle" text;
