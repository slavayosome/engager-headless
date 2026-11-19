ALTER TABLE "runner_protocol_transitions" DROP CONSTRAINT "runner_protocol_transitions_authority_check";--> statement-breakpoint
ALTER TABLE "runner_protocol_transitions" ADD CONSTRAINT "runner_protocol_transitions_scheduled_routine_evidence_check" CHECK ("runner_protocol_transitions"."authority" <> 'onboarding_scheduled_routine' or (
        "runner_protocol_transitions"."evidence" is not null and jsonb_typeof("runner_protocol_transitions"."evidence") = 'object' and
        "runner_protocol_transitions"."evidence" ?& array[
          'kind','ownerUserId','campaignId','subscriptionId','activationId',
          'previewId','targetRevision','contract','activationCapability',
          'enabled','environment','releaseId','databaseMarker','acceptedAt'
        ] and ("runner_protocol_transitions"."evidence" - array[
          'kind','ownerUserId','campaignId','subscriptionId','activationId',
          'previewId','targetRevision','contract','activationCapability',
          'enabled','environment','releaseId','databaseMarker','acceptedAt'
        ]) = '{}'::jsonb and
        "runner_protocol_transitions"."evidence"->>'kind' = 'onboarding_scheduled_routine' and
        "runner_protocol_transitions"."evidence"->>'contract' = '2.1' and
        "runner_protocol_transitions"."evidence"->>'activationCapability' = 'candidate-runtime-entitlement-v1' and
        "runner_protocol_transitions"."evidence"->'enabled' = 'true'::jsonb and
        "runner_protocol_transitions"."evidence"->>'environment' in ('dev','prod') and
        jsonb_typeof("runner_protocol_transitions"."evidence"->'ownerUserId') = 'string' and
        jsonb_typeof("runner_protocol_transitions"."evidence"->'campaignId') = 'number' and
        jsonb_typeof("runner_protocol_transitions"."evidence"->'subscriptionId') = 'string' and
        jsonb_typeof("runner_protocol_transitions"."evidence"->'activationId') = 'string' and
        jsonb_typeof("runner_protocol_transitions"."evidence"->'previewId') = 'string' and
        jsonb_typeof("runner_protocol_transitions"."evidence"->'targetRevision') = 'string' and
        jsonb_typeof("runner_protocol_transitions"."evidence"->'releaseId') = 'string' and
        jsonb_typeof("runner_protocol_transitions"."evidence"->'enabled') = 'boolean' and
        jsonb_typeof("runner_protocol_transitions"."evidence"->'acceptedAt') = 'number' and
        jsonb_typeof("runner_protocol_transitions"."evidence"->'databaseMarker') = 'object' and
        "runner_protocol_transitions"."evidence"->'databaseMarker' ?& array['environment','capabilityUpdatedAt','releaseId'] and
        (("runner_protocol_transitions"."evidence"->'databaseMarker') - array['environment','capabilityUpdatedAt','releaseId']) = '{}'::jsonb and
        "runner_protocol_transitions"."evidence"->'databaseMarker'->>'environment' = "runner_protocol_transitions"."evidence"->>'environment' and
        jsonb_typeof("runner_protocol_transitions"."evidence"->'databaseMarker'->'capabilityUpdatedAt') = 'number' and
        jsonb_typeof("runner_protocol_transitions"."evidence"->'databaseMarker'->'releaseId') = 'string' and
        "runner_protocol_transitions"."evidence"->>'releaseId' ~ '^[0-9a-f]{40}(-breakglass-[0-9]{14}-([0-9]+|[0-9a-f]{32}))?$' and
        "runner_protocol_transitions"."evidence"->'databaseMarker'->>'releaseId' = left("runner_protocol_transitions"."evidence"->>'releaseId', 40)
      ));--> statement-breakpoint
ALTER TABLE "runner_protocol_transitions" ADD CONSTRAINT "runner_protocol_transitions_authority_check" CHECK ("runner_protocol_transitions"."authority" = 'legacy_operator' or ("runner_protocol_transitions"."to_state" = 'cohort' and ("runner_protocol_transitions"."authority" = 'operator_cutover' or ("runner_protocol_transitions"."authority" in ('onboarding_setup_proof', 'onboarding_scheduled_routine') and "runner_protocol_transitions"."from_state" = 'legacy'))) or ("runner_protocol_transitions"."to_state" = 'rollback' and "runner_protocol_transitions"."authority" in ('operator_rollback', 'system_master_switch')));