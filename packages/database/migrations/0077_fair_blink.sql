CREATE TABLE "organization_initial_hosted_lane_claims" (
	"initial_organization_id" uuid NOT NULL,
	"lane" text NOT NULL,
	"job_id" bigint NOT NULL,
	"job_generation" integer DEFAULT 0 NOT NULL,
	"claim_source" text DEFAULT 'runtime' NOT NULL,
	"claimed_at" bigint NOT NULL,
	CONSTRAINT "organization_initial_hosted_lane_claims_initial_organization_id_lane_pk" PRIMARY KEY("initial_organization_id","lane"),
	CONSTRAINT "organization_initial_hosted_lane_claims_lane_check" CHECK ("organization_initial_hosted_lane_claims"."lane" in ('ingest_product', 'import_voice', 'compile_campaign')),
	CONSTRAINT "organization_initial_hosted_lane_claims_source_check" CHECK ("organization_initial_hosted_lane_claims"."claim_source" in ('runtime', 'backfill', 'compatibility')),
	CONSTRAINT "organization_initial_hosted_lane_claims_job_check" CHECK ("organization_initial_hosted_lane_claims"."job_id" > 0 and "organization_initial_hosted_lane_claims"."job_generation" >= 0)
);
--> statement-breakpoint
CREATE TABLE "owner_initial_hosted_lane_claims" (
	"owner_user_id" uuid NOT NULL,
	"lane" text NOT NULL,
	"initial_organization_id" uuid NOT NULL,
	"job_id" bigint NOT NULL,
	"job_generation" integer DEFAULT 0 NOT NULL,
	"claim_source" text DEFAULT 'runtime' NOT NULL,
	"claimed_at" bigint NOT NULL,
	CONSTRAINT "owner_initial_hosted_lane_claims_owner_user_id_lane_pk" PRIMARY KEY("owner_user_id","lane"),
	CONSTRAINT "owner_initial_hosted_lane_claims_lane_check" CHECK ("owner_initial_hosted_lane_claims"."lane" in ('ingest_product', 'import_voice', 'compile_campaign')),
	CONSTRAINT "owner_initial_hosted_lane_claims_source_check" CHECK ("owner_initial_hosted_lane_claims"."claim_source" in ('runtime', 'backfill', 'compatibility')),
	CONSTRAINT "owner_initial_hosted_lane_claims_job_check" CHECK ("owner_initial_hosted_lane_claims"."job_id" > 0 and "owner_initial_hosted_lane_claims"."job_generation" >= 0)
);
DO $initial_hosted_lane_claim_acl_firebreak$
DECLARE
  target_table_name text;
  grantee_name text;
BEGIN
  FOREACH target_table_name IN ARRAY ARRAY[
    'organization_initial_hosted_lane_claims',
    'owner_initial_hosted_lane_claims'
  ] LOOP
    FOR grantee_name IN
      SELECT DISTINCT grantee
      FROM information_schema.table_privileges
      WHERE table_schema = current_schema()
        AND information_schema.table_privileges.table_name = target_table_name
        AND grantee NOT IN (current_user, 'PUBLIC')
    LOOP
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM %I',
        current_schema(), target_table_name, grantee_name
      );
      EXECUTE format(
        'GRANT SELECT, INSERT ON TABLE %I.%I TO %I',
        current_schema(), target_table_name, grantee_name
      );
    END LOOP;
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM PUBLIC',
      current_schema(), target_table_name
    );
  END LOOP;
END
$initial_hosted_lane_claim_acl_firebreak$;
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "execution_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Preserve EVERY historical organization+lane independently. Terminal evidence
-- wins, so an old successful/dead execution cannot be displaced by a newer queued
-- row and accidentally receive another provider run after cutover.
WITH "historical_organization_lane_jobs" AS (
	SELECT DISTINCT ON (j."organization_id", j."type")
		j."organization_id" AS "initial_organization_id",
		j."type" AS "lane",
		j."id" AS "job_id",
		j."execution_generation" AS "job_generation",
		j."created_at" AS "claimed_at"
	FROM "jobs" j
	WHERE j."type" IN ('ingest_product', 'import_voice', 'compile_campaign')
	ORDER BY
		j."organization_id",
		j."type",
		CASE j."status"
			WHEN 'done' THEN 0
			WHEN 'dead' THEN 0
			WHEN 'failed' THEN 0
			WHEN 'running' THEN 1
			ELSE 2
		END,
		j."created_at",
		j."id"
)
INSERT INTO "organization_initial_hosted_lane_claims" (
	"initial_organization_id", "lane", "job_id", "job_generation",
	"claim_source", "claimed_at"
)
SELECT
	"initial_organization_id", "lane", "job_id", "job_generation",
	'backfill', "claimed_at"
FROM "historical_organization_lane_jobs"
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Preserve one owner-global lane independently of the complete organization
-- history above. Immutable trial provenance is the best surviving transfer
-- history; otherwise the pre-cutover schema retained only current ownership.
WITH "organization_principal_candidates" AS (
	SELECT
		"owner_user_id",
		"initial_organization_id" AS "organization_id",
		0 AS "source_priority",
		"claimed_at" AS "principal_at"
	FROM "owner_initial_trial_claims"
	UNION ALL
	SELECT
		"user_id" AS "owner_user_id",
		"organization_id",
		1 AS "source_priority",
		"created_at" AS "principal_at"
	FROM "memberships"
	WHERE "is_owner" = true
),
"organization_principals" AS (
	SELECT DISTINCT ON ("organization_id")
		"owner_user_id", "organization_id"
	FROM "organization_principal_candidates"
	ORDER BY
		"organization_id", "source_priority", "principal_at", "owner_user_id"
),
"historical_owner_lane_jobs" AS (
	SELECT DISTINCT ON (op."owner_user_id", j."type")
		op."owner_user_id",
		j."type" AS "lane",
		j."organization_id" AS "initial_organization_id",
		j."id" AS "job_id",
		j."execution_generation" AS "job_generation",
		j."created_at" AS "claimed_at"
	FROM "organization_principals" op
	INNER JOIN "jobs" j ON j."organization_id" = op."organization_id"
	WHERE j."type" IN ('ingest_product', 'import_voice', 'compile_campaign')
	ORDER BY
		op."owner_user_id",
		j."type",
		CASE j."status"
			WHEN 'done' THEN 0
			WHEN 'dead' THEN 0
			WHEN 'failed' THEN 0
			WHEN 'running' THEN 1
			ELSE 2
		END,
		j."created_at",
		j."id"
)
INSERT INTO "owner_initial_hosted_lane_claims" (
	"owner_user_id", "lane", "initial_organization_id", "job_id",
	"job_generation", "claim_source", "claimed_at"
)
SELECT
	"owner_user_id", "lane", "initial_organization_id", "job_id",
	"job_generation", 'backfill', "claimed_at"
FROM "historical_owner_lane_jobs"
ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "owner_initial_hosted_lane_claims" ADD CONSTRAINT "owner_initial_hosted_lane_claims_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "owner_initial_hosted_lane_claims_initial_org_idx" ON "owner_initial_hosted_lane_claims" USING btree ("initial_organization_id");--> statement-breakpoint
-- Online compatibility fence for migrate-before-stage deployments and app-only
-- compensation. Old binaries do not know either claim table; their queued ->
-- running update atomically establishes both fences. The v2 worker sets the GUC
-- in claimNextJob and deliberately consumes only at its provider boundary.
CREATE OR REPLACE FUNCTION "fence_legacy_initial_hosted_lane_claim"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	"organization_claim" "organization_initial_hosted_lane_claims"%ROWTYPE;
	"owner_claim" "owner_initial_hosted_lane_claims"%ROWTYPE;
	"principal_owner_user_id" uuid;
	"current_owner_count" integer;
BEGIN
	IF current_setting('app.initial_hosted_claim_protocol', true) = '2' THEN
		RETURN NEW;
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM "organizations" o
		WHERE o."id" = NEW."organization_id"
			AND o."onboarding_completed_at" IS NULL
			AND o."onboarding_step" IS NOT NULL
			AND o."onboarding_step" <> 'done'
	) OR EXISTS (
		SELECT 1 FROM "subscriptions" s
		WHERE s."organization_id" = NEW."organization_id"
			AND s."status" <> 'incomplete_expired'
	) THEN
		RETURN NEW;
	END IF;

	PERFORM pg_advisory_xact_lock(hashtextextended(
		'initial-hosted-org-lane:' || NEW."organization_id"::text || ':' || NEW."type", 0
	));
	SELECT * INTO "organization_claim"
	FROM "organization_initial_hosted_lane_claims" c
	WHERE c."initial_organization_id" = NEW."organization_id"
		AND c."lane" = NEW."type"
	LIMIT 1;
	IF FOUND THEN
		SELECT * INTO "owner_claim"
		FROM "owner_initial_hosted_lane_claims" c
		WHERE c."initial_organization_id" = NEW."organization_id"
			AND c."lane" = NEW."type"
			AND c."job_id" = NEW."id"
			AND c."job_generation" = NEW."execution_generation"
		LIMIT 1;
		IF "owner_claim"."owner_user_id" IS NOT NULL THEN
			PERFORM pg_advisory_xact_lock(hashtextextended(
				'initial-hosted-lane:' || "owner_claim"."owner_user_id"::text || ':' || NEW."type", 0
			));
			SELECT * INTO "owner_claim"
			FROM "owner_initial_hosted_lane_claims" c
			WHERE c."owner_user_id" = "owner_claim"."owner_user_id"
				AND c."initial_organization_id" = NEW."organization_id"
				AND c."lane" = NEW."type"
				AND c."job_id" = NEW."id"
				AND c."job_generation" = NEW."execution_generation"
			LIMIT 1;
		END IF;
		IF "organization_claim"."job_id" = NEW."id"
			AND "organization_claim"."job_generation" = NEW."execution_generation"
			AND "owner_claim"."owner_user_id" IS NOT NULL THEN
			RETURN NEW;
		END IF;
		RAISE EXCEPTION 'initial hosted organization lane already belongs to another logical job'
			USING ERRCODE = '23514';
	END IF;

	SELECT c."owner_user_id" INTO "principal_owner_user_id"
	FROM "owner_initial_trial_claims" c
	WHERE c."initial_organization_id" = NEW."organization_id"
	ORDER BY c."claimed_at", c."owner_user_id"
	LIMIT 1;
	IF "principal_owner_user_id" IS NULL THEN
		SELECT count(*)::integer,
			(array_agg(m."user_id" ORDER BY m."created_at", m."id"))[1]
		INTO "current_owner_count", "principal_owner_user_id"
		FROM "memberships" m
		WHERE m."organization_id" = NEW."organization_id"
			AND m."is_owner" = true;
		IF "current_owner_count" <> 1 OR "principal_owner_user_id" IS NULL THEN
			RAISE EXCEPTION 'initial hosted lane requires exactly one durable owner'
				USING ERRCODE = '23514';
		END IF;
	END IF;

	PERFORM pg_advisory_xact_lock(hashtextextended(
		'initial-hosted-lane:' || "principal_owner_user_id"::text || ':' || NEW."type", 0
	));
	SELECT * INTO "owner_claim"
	FROM "owner_initial_hosted_lane_claims" c
	WHERE c."owner_user_id" = "principal_owner_user_id"
		AND c."lane" = NEW."type"
	LIMIT 1;
	IF FOUND AND NOT (
		"owner_claim"."initial_organization_id" = NEW."organization_id"
		AND "owner_claim"."job_id" = NEW."id"
		AND "owner_claim"."job_generation" = NEW."execution_generation"
	) THEN
		RAISE EXCEPTION 'initial hosted owner lane already belongs to another organization or logical job'
			USING ERRCODE = '23514';
	END IF;

	IF "owner_claim"."owner_user_id" IS NULL THEN
		INSERT INTO "owner_initial_hosted_lane_claims" (
			"owner_user_id", "lane", "initial_organization_id", "job_id",
			"job_generation", "claim_source", "claimed_at"
		) VALUES (
			"principal_owner_user_id", NEW."type", NEW."organization_id", NEW."id",
			NEW."execution_generation", 'compatibility',
			floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
		)
		ON CONFLICT DO NOTHING;
	END IF;
	INSERT INTO "organization_initial_hosted_lane_claims" (
		"initial_organization_id", "lane", "job_id", "job_generation",
		"claim_source", "claimed_at"
	) VALUES (
		NEW."organization_id", NEW."type", NEW."id", NEW."execution_generation",
		'compatibility', floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
	)
	ON CONFLICT DO NOTHING;

	SELECT * INTO "owner_claim"
	FROM "owner_initial_hosted_lane_claims" c
	WHERE c."owner_user_id" = "principal_owner_user_id" AND c."lane" = NEW."type";
	SELECT * INTO "organization_claim"
	FROM "organization_initial_hosted_lane_claims" c
	WHERE c."initial_organization_id" = NEW."organization_id" AND c."lane" = NEW."type";
	IF "owner_claim"."initial_organization_id" = NEW."organization_id"
		AND "owner_claim"."job_id" = NEW."id"
		AND "owner_claim"."job_generation" = NEW."execution_generation"
		AND "organization_claim"."job_id" = NEW."id"
		AND "organization_claim"."job_generation" = NEW."execution_generation" THEN
		RETURN NEW;
	END IF;
	RAISE EXCEPTION 'initial hosted compatibility claim lost its unique race'
		USING ERRCODE = '23514';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "fence_legacy_initial_hosted_lane_claim"
BEFORE UPDATE OF "status" ON "jobs"
FOR EACH ROW
WHEN (
	NEW."status" = 'running'
	AND OLD."status" IS DISTINCT FROM 'running'
	AND NEW."type" IN ('ingest_product', 'import_voice', 'compile_campaign')
)
EXECUTE FUNCTION "fence_legacy_initial_hosted_lane_claim"();
--> statement-breakpoint
-- A fresh posting marker is an active provider write, not proof of an interrupted
-- process. Preserve a bounded recovery grace across app/worker processes and make
-- migrate-before-stage safe for old binaries that only update messages.status.
ALTER TABLE "messages" ADD COLUMN "posting_started_at" bigint;--> statement-breakpoint
UPDATE "messages"
SET "posting_started_at" = floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
WHERE "status" = 'posting';--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_posting_marker_check"
CHECK (
	("status" = 'posting' AND "posting_started_at" IS NOT NULL)
	OR ("status" <> 'posting' AND "posting_started_at" IS NULL)
);--> statement-breakpoint
CREATE OR REPLACE FUNCTION "normalize_message_posting_marker"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
	IF NEW."status" = 'posting' AND NEW."posting_started_at" IS NULL THEN
		NEW."posting_started_at" := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
	ELSIF NEW."status" <> 'posting' THEN
		NEW."posting_started_at" := NULL;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "normalize_message_posting_marker_insert"
BEFORE INSERT ON "messages"
FOR EACH ROW
EXECUTE FUNCTION "normalize_message_posting_marker"();--> statement-breakpoint
CREATE TRIGGER "normalize_message_posting_marker_update"
BEFORE UPDATE OF "status", "posting_started_at" ON "messages"
FOR EACH ROW
EXECUTE FUNCTION "normalize_message_posting_marker"();
