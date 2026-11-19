UPDATE "runner_protocol_transitions"
SET "authority" = 'legacy_operator',
    "evidence" = jsonb_build_object('legacy', true)
WHERE "to_state" = 'cohort'
  AND "evidence" IS NULL;--> statement-breakpoint
ALTER TABLE "runner_protocol_transitions" ALTER COLUMN "authority" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "runner_protocol_transitions" ADD CONSTRAINT "runner_protocol_transitions_authority_check" CHECK ("runner_protocol_transitions"."authority" = 'legacy_operator' or ("runner_protocol_transitions"."to_state" = 'cohort' and "runner_protocol_transitions"."authority" = 'operator_cutover') or ("runner_protocol_transitions"."to_state" = 'rollback' and "runner_protocol_transitions"."authority" in ('operator_rollback', 'system_master_switch')));--> statement-breakpoint
ALTER TABLE "runner_protocol_transitions" ADD CONSTRAINT "runner_protocol_transitions_cohort_evidence_check" CHECK ("runner_protocol_transitions"."to_state" <> 'cohort' or ("runner_protocol_transitions"."evidence" is not null and jsonb_typeof("runner_protocol_transitions"."evidence") = 'object' and "runner_protocol_transitions"."evidence" <> '{}'::jsonb));
