-- One-way credential cutover. Existing unprofiled keys are intentionally
-- revoked rather than reclassified: their original purpose cannot be inferred
-- safely. Tombstoning the hash also prevents an older rollback verifier from
-- resurrecting them.
UPDATE "api_keys"
SET
	"credential_profile" = 'legacy',
	"revoked_at" = COALESCE("revoked_at", (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint),
	"hashed_key" = 'revoked:' || "id"::text
WHERE "credential_profile" = 'legacy';
--> statement-breakpoint
UPDATE "api_keys"
SET
	"revoked_at" = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
	"hashed_key" = 'revoked:' || "id"::text
WHERE "revoked_at" IS NULL
	AND (
		CASE
			WHEN jsonb_typeof("scopes") = 'array' THEN jsonb_array_length("scopes") = 0
			ELSE true
		END
		OR (
			"credential_profile" = 'runner'
			AND ("runner_id" IS NULL OR "scopes" <> '["runner:execute"]'::jsonb)
		)
	);
--> statement-breakpoint
WITH "duplicate_runners" AS (
	SELECT
		"id",
		row_number() OVER (
			PARTITION BY "organization_id", "runner_id"
			ORDER BY "created_at" DESC, "id" DESC
		) AS "rank"
	FROM "api_keys"
	WHERE "credential_profile" = 'runner' AND "revoked_at" IS NULL
)
UPDATE "api_keys"
SET
	"revoked_at" = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
	"hashed_key" = 'revoked:' || "api_keys"."id"::text
FROM "duplicate_runners"
WHERE "api_keys"."id" = "duplicate_runners"."id" AND "duplicate_runners"."rank" > 1;
--> statement-breakpoint
UPDATE "device_auth_requests"
SET
	"status" = 'denied',
	"token" = NULL,
	"credential_profile" = 'legacy'
WHERE "credential_profile" = 'legacy'
	AND "status" IN ('pending', 'approved');
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_no_active_legacy_check"
	CHECK ("credential_profile" <> 'legacy' OR "revoked_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_active_scope_check"
	CHECK (
		"revoked_at" IS NOT NULL
		OR CASE
			WHEN jsonb_typeof("scopes") = 'array' THEN jsonb_array_length("scopes") > 0
			ELSE false
		END
	);--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_runner_shape_check"
	CHECK (
		"credential_profile" <> 'runner'
		OR "revoked_at" IS NOT NULL
		OR ("runner_id" IS NOT NULL AND "scopes" = '["runner:execute"]'::jsonb)
	);--> statement-breakpoint
ALTER TABLE "device_auth_requests" ADD CONSTRAINT "device_auth_requests_no_active_legacy_check"
	CHECK ("credential_profile" <> 'legacy' OR "status" IN ('denied', 'claimed'));--> statement-breakpoint
ALTER TABLE "device_auth_requests" ADD CONSTRAINT "device_auth_requests_runner_shape_check"
	CHECK (
		("credential_profile" = 'runner' AND "runner_id" IS NOT NULL)
		OR ("credential_profile" = 'interactive' AND "runner_id" IS NULL)
		OR "credential_profile" = 'legacy'
	);
