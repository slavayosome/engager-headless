CREATE TABLE "onboarding_radar_responses" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"client_mutation_id" uuid NOT NULL,
	"preview_id" uuid NOT NULL,
	"campaign_id" bigint NOT NULL,
	"discovered_post_id" bigint NOT NULL,
	"voice_id" bigint,
	"action" text NOT NULL,
	"comment_text" text,
	"comment_text_hash" text,
	"origin" text NOT NULL,
	"created_by_user_id" uuid,
	"revision" integer NOT NULL,
	"candidate_feedback_id" bigint,
	"materialized_message_id" bigint,
	"materialized_at" bigint,
	"created_at" bigint NOT NULL,
	"superseded_at" bigint,
	"superseded_by" text,
	"superseded_by_mutation_id" uuid,
	CONSTRAINT "onboarding_radar_responses_response_check" CHECK ("onboarding_radar_responses"."revision" > 0 and (("onboarding_radar_responses"."action" = 'comment' and "onboarding_radar_responses"."comment_text" is not null and length(btrim("onboarding_radar_responses"."comment_text")) > 0 and "onboarding_radar_responses"."comment_text_hash" is not null and "onboarding_radar_responses"."comment_text_hash" ~ '^[0-9a-f]{64}$' and "onboarding_radar_responses"."candidate_feedback_id" is not null) or ("onboarding_radar_responses"."action" = 'skip' and "onboarding_radar_responses"."comment_text" is null and "onboarding_radar_responses"."comment_text_hash" is null and "onboarding_radar_responses"."candidate_feedback_id" is null) or ("onboarding_radar_responses"."action" in ('good_match', 'not_relevant') and "onboarding_radar_responses"."comment_text" is null and "onboarding_radar_responses"."comment_text_hash" is null and "onboarding_radar_responses"."candidate_feedback_id" is not null))),
	CONSTRAINT "onboarding_radar_responses_materialization_check" CHECK (("onboarding_radar_responses"."materialized_message_id" is null and "onboarding_radar_responses"."materialized_at" is null) or ("onboarding_radar_responses"."action" = 'comment' and "onboarding_radar_responses"."materialized_message_id" is not null and "onboarding_radar_responses"."materialized_at" is not null)),
	CONSTRAINT "onboarding_radar_responses_superseded_check" CHECK (("onboarding_radar_responses"."superseded_at" is null and "onboarding_radar_responses"."superseded_by" is null and "onboarding_radar_responses"."superseded_by_mutation_id" is null) or ("onboarding_radar_responses"."superseded_at" is not null and "onboarding_radar_responses"."superseded_by" is not null and "onboarding_radar_responses"."superseded_by_mutation_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "onboarding_radar_responses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "onboarding_radar_responses" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "onboarding_radar_responses"
	USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_authorization_purpose_check";--> statement-breakpoint
ALTER TABLE "device_auth_requests" DROP CONSTRAINT "device_auth_requests_purpose_check";--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "bound_campaign_id" bigint;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "routine_id" uuid;--> statement-breakpoint
ALTER TABLE "device_auth_requests" ADD COLUMN "bound_campaign_id" bigint;--> statement-breakpoint
ALTER TABLE "device_auth_requests" ADD COLUMN "routine_id" uuid;--> statement-breakpoint
ALTER TABLE "exemplars" ADD COLUMN "source_ref" text;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "decision_origin" text;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "final_text_hash" text;--> statement-breakpoint
ALTER TABLE "onboarding_radar_previews" ADD COLUMN "flow_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "onboarding_radar_previews" ADD COLUMN "operating_level" text;--> statement-breakpoint
ALTER TABLE "onboarding_radar_previews" ADD COLUMN "voice_id" bigint;--> statement-breakpoint
ALTER TABLE "onboarding_radar_previews" ADD COLUMN "response_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "onboarding_radar_previews" ADD COLUMN "responses_frozen_at" bigint;--> statement-breakpoint
ALTER TABLE "onboarding_radar_previews" ADD COLUMN "calibration_status" text;--> statement-breakpoint
ALTER TABLE "onboarding_radar_previews" ADD COLUMN "calibration_sample_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "onboarding_radar_previews" ADD COLUMN "calibration_base_voice_revision" integer;--> statement-breakpoint
ALTER TABLE "onboarding_radar_previews" ADD COLUMN "calibration_job_id" bigint;--> statement-breakpoint
ALTER TABLE "onboarding_radar_previews" ADD COLUMN "calibration_error" text;--> statement-breakpoint
ALTER TABLE "onboarding_radar_previews" ADD COLUMN "calibration_continued_at" bigint;--> statement-breakpoint
ALTER TABLE "onboarding_radar_previews" ADD COLUMN "calibration_continued_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "onboarding_radar_level" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "onboarding_execution_mode" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "onboarding_first_run_choice" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "onboarding_host_approval_state" text;--> statement-breakpoint
ALTER TABLE "voices" ADD COLUMN "maturity" text DEFAULT 'calibrated' NOT NULL;--> statement-breakpoint
ALTER TABLE "voices" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "voices" ADD COLUMN "calibration_sample_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "voices" ADD COLUMN "calibrated_at" bigint;--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_radar_responses_org_client_mutation_uidx" ON "onboarding_radar_responses" USING btree ("organization_id","client_mutation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_radar_responses_org_preview_revision_uidx" ON "onboarding_radar_responses" USING btree ("organization_id","preview_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_radar_responses_org_preview_candidate_active_uidx" ON "onboarding_radar_responses" USING btree ("organization_id","preview_id","discovered_post_id") WHERE "onboarding_radar_responses"."superseded_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_radar_responses_org_materialized_message_uidx" ON "onboarding_radar_responses" USING btree ("organization_id","materialized_message_id") WHERE "onboarding_radar_responses"."materialized_message_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_radar_responses_org_superseded_mutation_uidx" ON "onboarding_radar_responses" USING btree ("organization_id","superseded_by_mutation_id") WHERE "onboarding_radar_responses"."superseded_by_mutation_id" is not null;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_authorization_purpose_check" CHECK (("api_keys"."authorization_purpose" = 'general' and "api_keys"."bound_campaign_id" is null and "api_keys"."routine_id" is null) or ("api_keys"."authorization_purpose" = 'runner_setup_proof' and "api_keys"."credential_profile" = 'runner' and "api_keys"."runner_id" is not null and "api_keys"."created_by_user_id" is not null and "api_keys"."bound_campaign_id" is null and "api_keys"."routine_id" is null) or ("api_keys"."authorization_purpose" in ('scheduled_curate', 'scheduled_review') and "api_keys"."credential_profile" = 'runner' and "api_keys"."runner_id" is not null and "api_keys"."created_by_user_id" is not null and "api_keys"."bound_campaign_id" is not null and "api_keys"."routine_id" is not null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "device_auth_requests" ADD CONSTRAINT "device_auth_requests_purpose_check" CHECK (("device_auth_requests"."purpose" = 'general' and "device_auth_requests"."requested_organization_id" is null and "device_auth_requests"."bound_campaign_id" is null and "device_auth_requests"."routine_id" is null) or ("device_auth_requests"."purpose" = 'runner_setup_proof' and "device_auth_requests"."credential_profile" = 'runner' and "device_auth_requests"."runner_id" is not null and "device_auth_requests"."delivery_protocol" = 2 and "device_auth_requests"."requested_organization_id" is not null and "device_auth_requests"."bound_campaign_id" is null and "device_auth_requests"."routine_id" is null) or ("device_auth_requests"."purpose" in ('scheduled_curate', 'scheduled_review') and "device_auth_requests"."credential_profile" = 'runner' and "device_auth_requests"."runner_id" is not null and "device_auth_requests"."delivery_protocol" = 2 and "device_auth_requests"."requested_organization_id" is not null and "device_auth_requests"."bound_campaign_id" is not null and "device_auth_requests"."routine_id" is not null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_final_text_hash_check" CHECK ("feedback"."final_text_hash" is null or "feedback"."final_text_hash" ~ '^[0-9a-f]{64}$') NOT VALID;--> statement-breakpoint
ALTER TABLE "onboarding_radar_previews" ADD CONSTRAINT "onboarding_radar_previews_response_state_check" CHECK ("onboarding_radar_previews"."flow_version" in (1, 2) and "onboarding_radar_previews"."response_revision" >= 0 and "onboarding_radar_previews"."calibration_sample_count" >= 0 and ("onboarding_radar_previews"."calibration_base_voice_revision" is null or "onboarding_radar_previews"."calibration_base_voice_revision" >= 0) and ("onboarding_radar_previews"."flow_version" = 1 or ("onboarding_radar_previews"."operating_level" in ('curate', 'review') and "onboarding_radar_previews"."calibration_status" in ('collecting', 'queued', 'running', 'calibrated', 'provisional', 'failed', 'continued_interim')))) NOT VALID;--> statement-breakpoint
ALTER TABLE "onboarding_radar_previews" ADD CONSTRAINT "onboarding_radar_previews_calibration_continue_check" CHECK (("onboarding_radar_previews"."calibration_status" = 'continued_interim' and "onboarding_radar_previews"."calibration_continued_at" is not null and "onboarding_radar_previews"."calibration_continued_by_user_id" is not null) or ("onboarding_radar_previews"."calibration_status" <> 'continued_interim' and "onboarding_radar_previews"."calibration_continued_at" is null and "onboarding_radar_previews"."calibration_continued_by_user_id" is null) or "onboarding_radar_previews"."calibration_status" is null) NOT VALID;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_onboarding_radar_level_check" CHECK ("organizations"."onboarding_radar_level" is null or "organizations"."onboarding_radar_level" in ('curate', 'review')) NOT VALID;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_onboarding_execution_mode_check" CHECK (("organizations"."onboarding_execution_mode" is null and "organizations"."onboarding_first_run_choice" is null and "organizations"."onboarding_host_approval_state" is null) or ("organizations"."onboarding_execution_mode" = 'manual' and "organizations"."onboarding_first_run_choice" = 'manual' and "organizations"."onboarding_host_approval_state" is null) or ("organizations"."onboarding_execution_mode" = 'scheduled' and ("organizations"."onboarding_first_run_choice" is null or "organizations"."onboarding_first_run_choice" in ('run_now', 'next_schedule')) and ("organizations"."onboarding_host_approval_state" is null or "organizations"."onboarding_host_approval_state" in ('pending', 'enabled', 'declined', 'unsupported')))) NOT VALID;--> statement-breakpoint
ALTER TABLE "voices" ADD CONSTRAINT "voices_revision_check" CHECK ("voices"."revision" >= 0 and "voices"."calibration_sample_count" >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "voices" ADD CONSTRAINT "voices_maturity_check" CHECK ("voices"."maturity" in ('provisional', 'calibrating', 'calibrated', 'failed')) NOT VALID;--> statement-breakpoint

-- Keep the existing full runner-identity fence on every scheduled-binding
-- update. A dedicated immutable-binding trigger below closes the new columns
-- without weakening the legacy v0.8 bind, setup-proof promotion, or canonical
-- revocation exceptions inside enforce_runner_api_key_revocation().
DROP TRIGGER IF EXISTS "api_keys_runner_revocation_fence" ON "api_keys";--> statement-breakpoint
CREATE TRIGGER "api_keys_runner_revocation_fence"
BEFORE UPDATE OF "id", "organization_id", "credential_profile", "authorization_purpose", "runner_id", "bound_campaign_id", "routine_id", "scopes", "revoked_at", "hashed_key", "revoked_by_user_id" ON "api_keys"
FOR EACH ROW
EXECUTE FUNCTION "enforce_runner_api_key_revocation"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "enforce_scheduled_runner_binding_immutability"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF OLD."credential_profile" = 'runner'
		AND (
			NEW."bound_campaign_id" IS DISTINCT FROM OLD."bound_campaign_id"
			OR NEW."routine_id" IS DISTINCT FROM OLD."routine_id"
		) THEN
		RAISE EXCEPTION 'runner credential campaign and routine binding is immutable'
			USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "api_keys_scheduled_binding_fence"
BEFORE UPDATE OF "bound_campaign_id", "routine_id" ON "api_keys"
FOR EACH ROW
EXECUTE FUNCTION "enforce_scheduled_runner_binding_immutability"();--> statement-breakpoint

-- Device approval locks a request, but the request's scheduled identity must
-- also be immutable against any direct app-role update before that lock.
CREATE OR REPLACE FUNCTION "enforce_scheduled_device_request_immutability"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF OLD."purpose" IN ('scheduled_curate', 'scheduled_review')
		OR NEW."purpose" IN ('scheduled_curate', 'scheduled_review') THEN
		IF NEW."purpose" IS DISTINCT FROM OLD."purpose"
			OR NEW."requested_organization_id" IS DISTINCT FROM OLD."requested_organization_id"
			OR NEW."runner_id" IS DISTINCT FROM OLD."runner_id"
			OR NEW."bound_campaign_id" IS DISTINCT FROM OLD."bound_campaign_id"
			OR NEW."routine_id" IS DISTINCT FROM OLD."routine_id" THEN
			RAISE EXCEPTION 'scheduled device request identity is immutable'
				USING ERRCODE = '23514';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "device_auth_requests_scheduled_identity_fence"
BEFORE UPDATE OF "purpose", "requested_organization_id", "runner_id", "bound_campaign_id", "routine_id" ON "device_auth_requests"
FOR EACH ROW
EXECUTE FUNCTION "enforce_scheduled_device_request_immutability"();
