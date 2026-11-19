CREATE TABLE "owner_initial_trial_claims" (
	"owner_user_id" uuid PRIMARY KEY NOT NULL,
	"initial_organization_id" uuid NOT NULL,
	"claimed_at" bigint NOT NULL
);
DO $owner_initial_trial_claim_acl_firebreak$
DECLARE
  grantee_name text;
BEGIN
  FOR grantee_name IN
    SELECT DISTINCT grantee
    FROM information_schema.table_privileges
    WHERE table_schema = current_schema()
      AND table_name = 'owner_initial_trial_claims'
      AND grantee NOT IN (current_user, 'PUBLIC')
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM %I',
      current_schema(), 'owner_initial_trial_claims', grantee_name
    );
    EXECUTE format(
      'GRANT SELECT, INSERT ON TABLE %I.%I TO %I',
      current_schema(), 'owner_initial_trial_claims', grantee_name
    );
  END LOOP;
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM PUBLIC',
    current_schema(), 'owner_initial_trial_claims'
  );
END
$owner_initial_trial_claim_acl_firebreak$;
--> statement-breakpoint
ALTER TABLE "owner_initial_trial_claims" ADD CONSTRAINT "owner_initial_trial_claims_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Preserve pre-cutover subscription history. One current verified owner can
-- have histories in several organizations; the oldest immutable subscription
-- deterministically owns their one initial-trial authority.
INSERT INTO "owner_initial_trial_claims" (
	"owner_user_id",
	"initial_organization_id",
	"claimed_at"
)
SELECT DISTINCT ON (m."user_id")
	m."user_id",
	s."organization_id",
	s."created_at"
FROM "memberships" m
INNER JOIN "users" u ON u."id" = m."user_id"
INNER JOIN "subscriptions" s ON s."organization_id" = m."organization_id"
WHERE m."is_owner" = true
	AND u."email_verified" IS NOT NULL
ORDER BY m."user_id", s."created_at", s."organization_id", s."id"
ON CONFLICT ("owner_user_id") DO NOTHING;--> statement-breakpoint
CREATE INDEX "owner_initial_trial_claims_initial_org_idx" ON "owner_initial_trial_claims" USING btree ("initial_organization_id");
--> statement-breakpoint
-- Expand/contract fence for a pre-cutover dashboard or webhook which remains
-- live after this migration (including a compensated application rollback).
-- The old projection has no checkout_terms, so atomically bind its first
-- subscription carrying trial history to the same owner-global authority used
-- by v2 Checkout (even when a delayed event arrives after the trial ended).
-- A second subscription, organization, or owner transfer fails before it can
-- become local billing authority. New guarded projections carry versioned
-- checkout_terms and are already claimed before their provider call.
CREATE OR REPLACE FUNCTION "fence_legacy_owner_initial_trial_claim"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
	"principal_owner_user_id" uuid;
	"verified_owner_count" integer;
	"claim_initial_organization_id" uuid;
	"prior_subscription_organization_id" uuid;
	"organization_claim_owner_user_id" uuid;
BEGIN
	-- The compatibility write fence is load-bearing only on hosted databases.
	-- Tests may opt into the exact trigger path transaction-locally without
	-- relabeling their immutable deployment marker.
	IF NOT EXISTS (
		SELECT 1
		FROM "deployment_metadata" d
		WHERE d."id" = 'runtime_environment'
			AND d."environment" IN ('dev', 'prod')
	) AND current_setting('app.test_legacy_trial_fence', true) IS DISTINCT FROM '1' THEN
		RETURN NEW;
	END IF;

	IF NEW."provider" <> 'stripe'
		OR NEW."trial_ends_at" IS NULL
		OR NEW."checkout_terms" IS NOT NULL THEN
		RETURN NEW;
	END IF;

	-- A redelivery of the same already-projected legacy subscription changes no
	-- trial authority. This also keeps ownership transfers from manufacturing a
	-- new owner claim merely because Stripe repeated an old status event.
	IF TG_OP = 'UPDATE'
		AND OLD."organization_id" = NEW."organization_id"
		AND OLD."provider" = 'stripe'
		AND OLD."trial_ends_at" IS NOT NULL
		AND OLD."checkout_terms" IS NULL THEN
		RETURN NEW;
	END IF;

	SELECT
		count(*)::integer,
		(array_agg(m."user_id" ORDER BY m."created_at", m."id"))[1]
	INTO "verified_owner_count", "principal_owner_user_id"
	FROM "memberships" m
	INNER JOIN "users" u ON u."id" = m."user_id"
	WHERE m."organization_id" = NEW."organization_id"
		AND m."is_owner" = true
		AND u."email_verified" IS NOT NULL;
	IF "verified_owner_count" <> 1 OR "principal_owner_user_id" IS NULL THEN
		RAISE EXCEPTION 'legacy initial trial requires exactly one verified durable owner'
			USING ERRCODE = '23514';
	END IF;

	-- This is the same mutex as checkoutAuthority(). It serializes old webhook
	-- projections against new Checkout decisions and against another old webhook
	-- arriving for a second organization at the same time.
	PERFORM pg_advisory_xact_lock(hashtextextended(
		'initial-trial-owner:' || "principal_owner_user_id"::text, 0
	));

	SELECT c."initial_organization_id"
	INTO "claim_initial_organization_id"
	FROM "owner_initial_trial_claims" c
	WHERE c."owner_user_id" = "principal_owner_user_id";

	-- Recover history created after the migration backfill (for example, an owner
	-- who verified later). Exclude this physical row on an INSERT ... ON CONFLICT
	-- update: a subscription redelivery is not a second trial.
	SELECT s."organization_id"
	INTO "prior_subscription_organization_id"
	FROM "subscriptions" s
	INNER JOIN "memberships" m ON m."organization_id" = s."organization_id"
	WHERE m."user_id" = "principal_owner_user_id"
		AND m."is_owner" = true
		AND s."id" <> NEW."id"
	ORDER BY s."created_at", s."organization_id", s."id"
	LIMIT 1;

	-- Organization provenance survives ownership transfer. A claim left by a
	-- former owner is still proof that this project is not a fresh trial target.
	SELECT c."owner_user_id"
	INTO "organization_claim_owner_user_id"
	FROM "owner_initial_trial_claims" c
	WHERE c."initial_organization_id" = NEW."organization_id"
	ORDER BY c."claimed_at", c."owner_user_id"
	LIMIT 1;

	IF "claim_initial_organization_id" IS NULL THEN
		INSERT INTO "owner_initial_trial_claims" (
			"owner_user_id", "initial_organization_id", "claimed_at"
		) VALUES (
			"principal_owner_user_id",
			coalesce("prior_subscription_organization_id", NEW."organization_id"),
			floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
		)
		ON CONFLICT ("owner_user_id") DO NOTHING;

		SELECT c."initial_organization_id"
		INTO "claim_initial_organization_id"
		FROM "owner_initial_trial_claims" c
		WHERE c."owner_user_id" = "principal_owner_user_id";
	END IF;

	IF "claim_initial_organization_id" IS NULL
		OR "claim_initial_organization_id" <> NEW."organization_id"
		OR "prior_subscription_organization_id" IS NOT NULL
		OR (
			"organization_claim_owner_user_id" IS NOT NULL
			AND "organization_claim_owner_user_id" <> "principal_owner_user_id"
		) THEN
		RAISE EXCEPTION 'legacy initial trial is already consumed by an owner or organization'
			USING ERRCODE = '23514';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "fence_legacy_owner_initial_trial_claim"
BEFORE INSERT OR UPDATE OF "organization_id", "provider", "status", "active", "trial_ends_at", "checkout_terms"
ON "subscriptions"
FOR EACH ROW
EXECUTE FUNCTION "fence_legacy_owner_initial_trial_claim"();
--> statement-breakpoint
-- Reconciliation writes immutable per-item Price authority before the v2 app is
-- activated. A still-live Phase5 webhook replaces the complete items array and
-- does not know the priceAuthorized field. Preserve that marker across this one
-- expand/contract shape only: exactly one incoming legacy item, no authority key,
-- and the same already-authorized Price id + quantity. Any explicit v2 decision,
-- mixed subscription, changed Price/quantity, or untrusted old row passes through
-- unchanged and therefore fails closed under the v2 entitlement projection.
CREATE OR REPLACE FUNCTION "preserve_legacy_subscription_price_authority"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
	"old_item" jsonb;
	"new_item" jsonb;
BEGIN
	IF OLD."items" IS NULL
		OR NEW."items" IS NULL
		OR jsonb_typeof(OLD."items") IS DISTINCT FROM 'array'
		OR jsonb_typeof(NEW."items") IS DISTINCT FROM 'array'
		OR jsonb_array_length(OLD."items") <> 1
		OR jsonb_array_length(NEW."items") <> 1 THEN
		RETURN NEW;
	END IF;

	"old_item" := OLD."items" -> 0;
	"new_item" := NEW."items" -> 0;
	IF jsonb_typeof("old_item") IS DISTINCT FROM 'object'
		OR jsonb_typeof("new_item") IS DISTINCT FROM 'object'
		-- A present key, including explicit false/null, is a v2 decision.
		OR "new_item" ? 'priceAuthorized'
		OR "old_item" -> 'priceAuthorized' IS DISTINCT FROM 'true'::jsonb
		OR jsonb_typeof("old_item" -> 'priceId') IS DISTINCT FROM 'string'
		OR jsonb_typeof("new_item" -> 'priceId') IS DISTINCT FROM 'string'
		OR "old_item" -> 'priceId' IS DISTINCT FROM "new_item" -> 'priceId'
		OR jsonb_typeof("old_item" -> 'quantity') IS DISTINCT FROM 'number'
		OR jsonb_typeof("new_item" -> 'quantity') IS DISTINCT FROM 'number'
		OR "old_item" -> 'quantity' IS DISTINCT FROM "new_item" -> 'quantity' THEN
		RETURN NEW;
	END IF;

	NEW."items" := jsonb_build_array(
		"new_item" || jsonb_build_object('priceAuthorized', true)
	);
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "preserve_legacy_subscription_price_authority"
BEFORE UPDATE OF "items"
ON "subscriptions"
FOR EACH ROW
WHEN (OLD."items" IS DISTINCT FROM NEW."items")
EXECUTE FUNCTION "preserve_legacy_subscription_price_authority"();
