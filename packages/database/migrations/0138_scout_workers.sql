-- THE RUN LOG'S PARENT MOVES WITH THE WORKER. `automation_runs.automation_id`
-- keeps its physical name forever, but what it points AT is a worker — and a
-- scout exists ONLY in `workers`, because the source table has no shape for a
-- worker that finds and does not write. Left pointing at `automations`, the FK
-- refuses every run row a scout would write.
--
-- No data moves with it. Every run row validates against the new parent
-- unchanged, because the ids are one space: `workers.id` defaults from
-- `automations_id_seq`. And there is no split to perform — this is a greenfield
-- project with no installed base, so the row that swept AND wrote never existed
-- outside a fixture. Scouts come from `createCampaignOp` (T-8.17), not from a
-- backfill.
ALTER TABLE "automation_runs" DROP CONSTRAINT "automation_runs_org_automation_fk";
--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_org_worker_fk" FOREIGN KEY ("organization_id","automation_id") REFERENCES "public"."workers"("organization_id","id") ON DELETE cascade ON UPDATE no action;
