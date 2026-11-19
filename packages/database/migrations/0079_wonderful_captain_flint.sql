ALTER TABLE "runner_protocol_transitions" DROP CONSTRAINT "runner_protocol_transitions_authority_check";--> statement-breakpoint
ALTER TABLE "deployment_metadata" ADD COLUMN "release_id" text;--> statement-breakpoint
ALTER TABLE "deployment_metadata" ADD COLUMN "release_transaction_id" text;--> statement-breakpoint
-- oauth-provider-token-fence:start
-- Databases which already journaled 0067 must receive the same persistent
-- compatibility fence through the ordinary forward-only upgrade path.
CREATE OR REPLACE FUNCTION "normalize_oauth_provider_tokens"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW."refresh_token" := NULL;
  NEW."access_token" := NULL;
  NEW."expires_at" := NULL;
  NEW."token_type" := NULL;
  NEW."scope" := NULL;
  NEW."id_token" := NULL;
  NEW."session_state" := NULL;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "normalize_oauth_provider_tokens_insert" ON "accounts";--> statement-breakpoint
CREATE TRIGGER "normalize_oauth_provider_tokens_insert"
BEFORE INSERT ON "accounts"
FOR EACH ROW
EXECUTE FUNCTION "normalize_oauth_provider_tokens"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "normalize_oauth_provider_tokens_update" ON "accounts";--> statement-breakpoint
CREATE TRIGGER "normalize_oauth_provider_tokens_update"
BEFORE UPDATE OF
  "refresh_token", "access_token", "expires_at", "token_type", "scope",
  "id_token", "session_state"
ON "accounts"
FOR EACH ROW
EXECUTE FUNCTION "normalize_oauth_provider_tokens"();--> statement-breakpoint
-- Close the upgrade window as well as future writes: an old callback may have
-- repopulated tokens after 0067 was journaled but before this forward fence.
UPDATE "accounts"
SET
  "refresh_token" = NULL,
  "access_token" = NULL,
  "expires_at" = NULL,
  "token_type" = NULL,
  "scope" = NULL,
  "id_token" = NULL,
  "session_state" = NULL
WHERE
  "refresh_token" IS NOT NULL
  OR "access_token" IS NOT NULL
  OR "expires_at" IS NOT NULL
  OR "token_type" IS NOT NULL
  OR "scope" IS NOT NULL
  OR "id_token" IS NOT NULL
  OR "session_state" IS NOT NULL;
-- oauth-provider-token-fence:end
--> statement-breakpoint
ALTER TABLE "runner_protocol_transitions" ADD CONSTRAINT "runner_protocol_transitions_setup_proof_evidence_check" CHECK ("runner_protocol_transitions"."authority" <> 'onboarding_setup_proof' or (
        "runner_protocol_transitions"."evidence" is not null and jsonb_typeof("runner_protocol_transitions"."evidence") = 'object' and
        "runner_protocol_transitions"."evidence" ?& array[
          'kind','workOrderId','runnerWorkEventId','credentialKeyId','ownerUserId',
          'runnerId','campaignId','candidateId','subscriptionId','activationId',
          'previewId','targetRevision','contextRevision','receiptHash','contract',
          'activationCapability','enabled','environment','releaseId','databaseMarker','acceptedAt'
        ] and ("runner_protocol_transitions"."evidence" - array[
          'kind','workOrderId','runnerWorkEventId','credentialKeyId','ownerUserId',
          'runnerId','campaignId','candidateId','subscriptionId','activationId',
          'previewId','targetRevision','contextRevision','receiptHash','contract',
          'activationCapability','enabled','environment','releaseId','databaseMarker','acceptedAt'
        ]) = '{}'::jsonb and
        "runner_protocol_transitions"."evidence"->>'kind' = 'onboarding_setup_proof' and
        "runner_protocol_transitions"."evidence"->>'contract' = '2.1' and
        "runner_protocol_transitions"."evidence"->>'activationCapability' = 'candidate-runtime-entitlement-v1' and
        "runner_protocol_transitions"."evidence"->'enabled' = 'true'::jsonb and
        "runner_protocol_transitions"."evidence"->>'environment' in ('dev','prod') and
        jsonb_typeof("runner_protocol_transitions"."evidence"->'workOrderId') = 'string' and
        jsonb_typeof("runner_protocol_transitions"."evidence"->'runnerWorkEventId') = 'number' and
        jsonb_typeof("runner_protocol_transitions"."evidence"->'credentialKeyId') = 'string' and
        jsonb_typeof("runner_protocol_transitions"."evidence"->'ownerUserId') = 'string' and
        jsonb_typeof("runner_protocol_transitions"."evidence"->'runnerId') = 'string' and
        jsonb_typeof("runner_protocol_transitions"."evidence"->'campaignId') = 'number' and
        jsonb_typeof("runner_protocol_transitions"."evidence"->'candidateId') = 'number' and
        jsonb_typeof("runner_protocol_transitions"."evidence"->'subscriptionId') = 'string' and
        jsonb_typeof("runner_protocol_transitions"."evidence"->'activationId') = 'string' and
        jsonb_typeof("runner_protocol_transitions"."evidence"->'previewId') = 'string' and
        jsonb_typeof("runner_protocol_transitions"."evidence"->'targetRevision') = 'string' and
        jsonb_typeof("runner_protocol_transitions"."evidence"->'contextRevision') = 'string' and
        jsonb_typeof("runner_protocol_transitions"."evidence"->'receiptHash') = 'string' and
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
ALTER TABLE "runner_protocol_transitions" ADD CONSTRAINT "runner_protocol_transitions_authority_check" CHECK ("runner_protocol_transitions"."authority" = 'legacy_operator' or ("runner_protocol_transitions"."to_state" = 'cohort' and ("runner_protocol_transitions"."authority" = 'operator_cutover' or ("runner_protocol_transitions"."authority" = 'onboarding_setup_proof' and "runner_protocol_transitions"."from_state" = 'legacy'))) or ("runner_protocol_transitions"."to_state" = 'rollback' and "runner_protocol_transitions"."authority" in ('operator_rollback', 'system_master_switch')));
