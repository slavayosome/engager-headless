LOCK TABLE "api_keys" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE "runner_work_orders" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE "agent_runners" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
CREATE TABLE "runner_disconnect_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"runner_id" text NOT NULL,
	"api_key_id" uuid NOT NULL,
	"client_request_id" uuid NOT NULL,
	"credential_fingerprint" text NOT NULL,
	"approved_by_user_id" uuid NOT NULL,
	"credential_was_active" boolean NOT NULL,
	"credential_revoked_at" bigint NOT NULL,
	"cancelled_work_order_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"legacy_cancelled_work_order_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"receipt_version" integer DEFAULT 1 NOT NULL,
	"receipt_hash" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "runner_disconnect_receipts_request_id_unique" UNIQUE("request_id"),
	CONSTRAINT "runner_disconnect_receipts_receipt_hash_unique" UNIQUE("receipt_hash"),
	CONSTRAINT "runner_disconnect_receipts_version_check" CHECK ("runner_disconnect_receipts"."receipt_version" = 1)
);
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "runner_disconnect_receipts" FROM PUBLIC;--> statement-breakpoint
ALTER TABLE "runner_disconnect_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "runner_disconnect_receipts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_read" ON "runner_disconnect_receipts" FOR SELECT USING ("organization_id" = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_append" ON "runner_disconnect_receipts" FOR INSERT WITH CHECK ("organization_id" = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
CREATE TABLE "runner_disconnect_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_request_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"device_code_hash" text NOT NULL,
	"user_code" text NOT NULL,
	"client_name" text,
	"organization_id" uuid NOT NULL,
	"runner_id" text NOT NULL,
	"api_key_id" uuid NOT NULL,
	"credential_fingerprint" text NOT NULL,
	"derivation_key_version" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by_user_id" uuid,
	"decision_reason" text,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"decided_at" bigint,
	"acknowledged_at" bigint,
	CONSTRAINT "runner_disconnect_requests_device_code_hash_unique" UNIQUE("device_code_hash"),
	CONSTRAINT "runner_disconnect_requests_user_code_unique" UNIQUE("user_code"),
	CONSTRAINT "runner_disconnect_requests_status_check" CHECK ("runner_disconnect_requests"."status" in ('pending', 'approved', 'denied', 'expired', 'acknowledged')),
	CONSTRAINT "runner_disconnect_requests_derivation_version_check" CHECK ("runner_disconnect_requests"."derivation_key_version" > 0),
	CONSTRAINT "runner_disconnect_requests_expiry_check" CHECK ("runner_disconnect_requests"."expires_at" > "runner_disconnect_requests"."created_at"),
	CONSTRAINT "runner_disconnect_requests_decision_state_check" CHECK (("runner_disconnect_requests"."status" in ('pending', 'expired') and "runner_disconnect_requests"."decided_by_user_id" is null and "runner_disconnect_requests"."decided_at" is null and "runner_disconnect_requests"."decision_reason" is null) or ("runner_disconnect_requests"."status" in ('approved', 'denied', 'acknowledged') and "runner_disconnect_requests"."decided_by_user_id" is not null and "runner_disconnect_requests"."decided_at" is not null and "runner_disconnect_requests"."decision_reason" is not null)),
	CONSTRAINT "runner_disconnect_requests_ack_state_check" CHECK (("runner_disconnect_requests"."status" = 'acknowledged' and "runner_disconnect_requests"."acknowledged_at" is not null) or ("runner_disconnect_requests"."status" <> 'acknowledged' and "runner_disconnect_requests"."acknowledged_at" is null))
);
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "runner_disconnect_requests" FROM PUBLIC;--> statement-breakpoint
ALTER TABLE "agent_runners" ADD COLUMN "credential_key_id" uuid;--> statement-breakpoint
ALTER TABLE "runner_work_orders" ADD COLUMN "claimed_by_credential_key_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_org_id_runner_uidx" ON "api_keys" USING btree ("organization_id","id","runner_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "enforce_runner_api_key_enrollment"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	"operation_mode" text;
	"protocol_state" text;
	"creates_authority" boolean := false;
BEGIN
	IF NEW."credential_profile" = 'runner' AND NEW."revoked_at" IS NULL THEN
		IF TG_OP = 'INSERT' THEN
			"creates_authority" := true;
		ELSIF OLD."credential_profile" <> 'runner'
			OR OLD."revoked_at" IS NOT NULL
			OR (
				OLD."expires_at" IS NOT NULL
				AND (
					NEW."expires_at" IS NULL
					OR NEW."expires_at" > OLD."expires_at"
				)
			) THEN
			"creates_authority" := true;
		END IF;
	END IF;
	IF "creates_authority" THEN
		-- Old application processes and direct app-role writes must meet the
		-- same cutover fence as current enrollment before creating authority.
		PERFORM pg_advisory_xact_lock(
			hashtext('runner-claim:' || NEW."organization_id"::text)
		);
		SELECT "onboarding_operation_mode", "runner_protocol_state"
		INTO "operation_mode", "protocol_state"
		FROM "organizations"
		WHERE "id" = NEW."organization_id";
		IF NOT FOUND
			OR "operation_mode" = 'interactive'
			OR "protocol_state" = 'rollback' THEN
			RAISE EXCEPTION 'runner credential enrollment is disabled for this organization'
				USING ERRCODE = '42501';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "api_keys_runner_enrollment_fence"
BEFORE INSERT OR UPDATE OF "organization_id", "credential_profile", "revoked_at", "expires_at" ON "api_keys"
FOR EACH ROW
EXECUTE FUNCTION "enforce_runner_api_key_enrollment"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "enforce_runner_api_key_revocation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF OLD."credential_profile" = 'runner' THEN
		-- The released v0.8 client omitted runnerId during device enrollment.
		-- Permit exactly one marked first-heartbeat promotion from the server-only
		-- pending namespace to a valid stable identity while the claimed v1
		-- enrollment proof and its one-hour deadline are still present.
		IF current_setting('app.runner_legacy_binding_key_id', true) = OLD."id"::text
			AND OLD."authorization_purpose" = 'general'
			AND OLD."revoked_at" IS NULL
			AND OLD."runner_id" ~ '^legacy-v08:[A-Za-z0-9_-]{24}$'
			AND NEW."runner_id" ~ '^[A-Za-z0-9._:-]{3,200}$'
			AND NEW."runner_id" NOT LIKE 'legacy-v08:%'
			AND NEW."expires_at" IS NULL
			AND coalesce(OLD."expires_at", OLD."created_at" + 3600000) >
				(extract(epoch FROM statement_timestamp()) * 1000)::bigint
			AND (
				to_jsonb(NEW) - 'runner_id' - 'expires_at'
			) IS NOT DISTINCT FROM (
				to_jsonb(OLD) - 'runner_id' - 'expires_at'
			)
			AND EXISTS (
				SELECT 1
				FROM "device_auth_requests" AS "legacy_request"
				WHERE "legacy_request"."api_key_id" = OLD."id"
					AND "legacy_request"."organization_id" = OLD."organization_id"
					AND "legacy_request"."credential_profile" = 'runner'
					AND "legacy_request"."purpose" = 'general'
					AND "legacy_request"."delivery_protocol" = 1
					AND "legacy_request"."status" = 'claimed'
					AND "legacy_request"."runner_id" = OLD."runner_id"
			) THEN
			RETURN NEW;
		END IF;
		-- The accepted setup proof promotes this exact active bearer in place.
		-- A transaction-local marker plus a full-row comparison makes the one-way
		-- purpose change possible without weakening runner identity immutability.
		IF current_setting('app.runner_setup_proof_promotion_key_id', true) = OLD."id"::text
			AND OLD."authorization_purpose" = 'runner_setup_proof'
			AND NEW."authorization_purpose" = 'general'
			AND OLD."revoked_at" IS NULL
			AND (
				to_jsonb(NEW) - 'authorization_purpose'
			) IS NOT DISTINCT FROM (
				to_jsonb(OLD) - 'authorization_purpose'
			) THEN
			RETURN NEW;
		END IF;
		-- A runner key's authorization identity is immutable for its lifetime.
		-- This also keeps the transaction-local revocation marker from being
		-- combined with a profile/scope rewrite and then used to resurrect the
		-- tombstoned digest through the non-runner branch on a later statement.
		IF NEW."id" IS DISTINCT FROM OLD."id"
			OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
			OR NEW."credential_profile" IS DISTINCT FROM OLD."credential_profile"
			OR NEW."authorization_purpose" IS DISTINCT FROM OLD."authorization_purpose"
			OR NEW."runner_id" IS DISTINCT FROM OLD."runner_id"
			OR NEW."scopes" IS DISTINCT FROM OLD."scopes" THEN
			RAISE EXCEPTION 'runner credential identity is immutable'
				USING ERRCODE = '23514';
		END IF;
		IF OLD."revoked_at" IS NOT NULL
			AND NEW."revoked_at" IS NOT DISTINCT FROM OLD."revoked_at"
			AND NEW."hashed_key" IS NOT DISTINCT FROM OLD."hashed_key"
			AND OLD."revoked_by_user_id" IS NOT NULL
			AND NEW."revoked_by_user_id" IS NULL
			-- Only PostgreSQL's nested ON DELETE SET NULL action may clear the
			-- audit FK. A direct app-role UPDATE runs at depth 1 and is rejected.
			AND pg_trigger_depth() > 1
			AND (
				to_jsonb(NEW) - 'revoked_by_user_id' - 'created_by_user_id'
			) IS NOT DISTINCT FROM (
				to_jsonb(OLD) - 'revoked_by_user_id' - 'created_by_user_id'
			)
			AND (
				NEW."created_by_user_id" IS NOT DISTINCT FROM OLD."created_by_user_id"
				OR (
					OLD."created_by_user_id" IS NOT DISTINCT FROM OLD."revoked_by_user_id"
					AND NEW."created_by_user_id" IS NULL
				)
			) THEN
			RETURN NEW;
		END IF;
		-- Retention cleanup is allowed to revoke only the exact stale abandoned
		-- credential that its claimed device-auth request would otherwise orphan,
		-- including a malformed permanent protocol-2 key from a rolling rollback.
		-- The statement timestamp and full-row comparison prevent this narrowly
		-- scoped mode from becoming a general runner-key mutation backdoor.
		IF current_setting('app.runner_revocation_mode', true) = 'expired_device_auth_cleanup'
			AND OLD."revoked_at" IS NULL
			AND NEW."revoked_at" = (extract(epoch FROM statement_timestamp()) * 1000)::bigint
			AND NEW."hashed_key" = ('revoked:' || OLD."id"::text)
			AND (
				to_jsonb(NEW) - 'revoked_at' - 'hashed_key'
			) IS NOT DISTINCT FROM (
				to_jsonb(OLD) - 'revoked_at' - 'hashed_key'
			)
			AND EXISTS (
				SELECT 1
				FROM "device_auth_requests" AS "retained_request"
				WHERE "retained_request"."api_key_id" = OLD."id"
					AND "retained_request"."status" = 'claimed'
					AND "retained_request"."expires_at" <=
						(extract(epoch FROM statement_timestamp()) * 1000)::bigint - 86400000
					AND (
					(
						"retained_request"."delivery_protocol" = 2
						AND "retained_request"."delivery_acknowledged_at" IS NULL
					)
						OR "retained_request"."runner_id" LIKE 'legacy-v08:%'
						OR OLD."expires_at" <=
							(extract(epoch FROM statement_timestamp()) * 1000)::bigint
					)
			) THEN
			RETURN NEW;
		END IF;
		IF current_setting('app.runner_revocation_key_id', true) IS DISTINCT FROM OLD."id"::text THEN
			RAISE EXCEPTION 'runner credential revocation must use canonical fencing'
				USING ERRCODE = '42501';
		END IF;
		IF OLD."revoked_at" IS NOT NULL
			OR NEW."revoked_at" IS NULL
			OR NEW."hashed_key" IS DISTINCT FROM ('revoked:' || OLD."id"::text) THEN
			RAISE EXCEPTION 'runner credential tombstone is malformed'
				USING ERRCODE = '23514';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "api_keys_runner_revocation_fence"
BEFORE UPDATE OF "id", "organization_id", "credential_profile", "authorization_purpose", "runner_id", "scopes", "revoked_at", "hashed_key", "revoked_by_user_id" ON "api_keys"
FOR EACH ROW
EXECUTE FUNCTION "enforce_runner_api_key_revocation"();--> statement-breakpoint
CREATE UNIQUE INDEX "runner_disconnect_requests_key_client_request_uidx" ON "runner_disconnect_requests" USING btree ("api_key_id","client_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runner_disconnect_requests_open_key_uidx" ON "runner_disconnect_requests" USING btree ("api_key_id") WHERE "runner_disconnect_requests"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "runner_disconnect_requests_org_id_uidx" ON "runner_disconnect_requests" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "runner_disconnect_requests_receipt_binding_uidx" ON "runner_disconnect_requests" USING btree ("organization_id","id","api_key_id","runner_id","client_request_id","credential_fingerprint");--> statement-breakpoint
ALTER TABLE "runner_disconnect_receipts" ADD CONSTRAINT "runner_disconnect_receipts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_disconnect_receipts" ADD CONSTRAINT "runner_disconnect_receipts_request_binding_fk" FOREIGN KEY ("organization_id","request_id","api_key_id","runner_id","client_request_id","credential_fingerprint") REFERENCES "public"."runner_disconnect_requests"("organization_id","id","api_key_id","runner_id","client_request_id","credential_fingerprint") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_disconnect_receipts" ADD CONSTRAINT "runner_disconnect_receipts_exact_credential_fk" FOREIGN KEY ("organization_id","api_key_id","runner_id") REFERENCES "public"."api_keys"("organization_id","id","runner_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_disconnect_requests" ADD CONSTRAINT "runner_disconnect_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_disconnect_requests" ADD CONSTRAINT "runner_disconnect_requests_exact_credential_fk" FOREIGN KEY ("organization_id","api_key_id","runner_id") REFERENCES "public"."api_keys"("organization_id","id","runner_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runners" ADD CONSTRAINT "agent_runners_credential_fk" FOREIGN KEY ("organization_id","credential_key_id","runner_id") REFERENCES "public"."api_keys"("organization_id","id","runner_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_work_orders" ADD CONSTRAINT "runner_work_orders_claimed_credential_fk" FOREIGN KEY ("organization_id","claimed_by_credential_key_id","claimed_by_runner_id") REFERENCES "public"."api_keys"("organization_id","id","runner_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runner_work_orders_org_credential_status_idx" ON "runner_work_orders" USING btree ("organization_id","claimed_by_credential_key_id","status");--> statement-breakpoint
UPDATE "agent_runners"
SET "state" = 'stopped',
    "credential_key_id" = NULL,
    "next_wake_at" = NULL,
    "updated_at" = (extract(epoch FROM clock_timestamp()) * 1000)::bigint;--> statement-breakpoint
WITH "cancelled" AS (
	UPDATE "runner_work_orders"
	SET "status" = 'cancelled',
		"lease_token_hash" = NULL,
		"lease_expires_at" = NULL,
		"result" = coalesce("result", '{}'::jsonb) || jsonb_build_object(
			'reason', 'runner credential cutover cancelled an unbound legacy lease'
		),
		"completed_at" = (extract(epoch FROM clock_timestamp()) * 1000)::bigint,
		"updated_at" = (extract(epoch FROM clock_timestamp()) * 1000)::bigint
	WHERE "status" = 'claimed'
		AND "claimed_by_credential_key_id" IS NULL
	RETURNING "organization_id", "id", "attempt"
)
INSERT INTO "runner_work_events" (
	"organization_id",
	"work_order_id",
	"item_type",
	"input_id",
	"action",
	"outcome",
	"detail",
	"created_at"
)
SELECT
	"organization_id",
	"id",
	'system',
	'credential-cutover:' || "attempt"::text,
	'cancelled',
	'accepted',
	jsonb_build_object(
		'reason', 'runner credential cutover cancelled an unbound legacy lease'
	),
	(extract(epoch FROM clock_timestamp()) * 1000)::bigint
FROM "cancelled";--> statement-breakpoint
ALTER TABLE "agent_runners" ADD CONSTRAINT "agent_runners_active_credential_check" CHECK ("agent_runners"."state" = 'stopped' or "agent_runners"."credential_key_id" is not null);--> statement-breakpoint
ALTER TABLE "runner_work_orders" ADD CONSTRAINT "runner_work_orders_claimed_credential_pair_check" CHECK ("runner_work_orders"."claimed_by_credential_key_id" is null or "runner_work_orders"."claimed_by_runner_id" is not null);--> statement-breakpoint
ALTER TABLE "runner_work_orders" ADD CONSTRAINT "runner_work_orders_claimed_credential_required_check" CHECK ("runner_work_orders"."status" <> 'claimed' or ("runner_work_orders"."claimed_by_credential_key_id" is not null and "runner_work_orders"."claimed_by_runner_id" is not null));
