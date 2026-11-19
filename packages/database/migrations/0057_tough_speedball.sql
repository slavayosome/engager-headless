CREATE TABLE "onboarding_preview_budgets" (
	"subject_hash" text PRIMARY KEY NOT NULL,
	"subject_type" text NOT NULL,
	"daily_window_started_at" bigint NOT NULL,
	"daily_attempts" integer DEFAULT 0 NOT NULL,
	"lifetime_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "onboarding_preview_budgets_counters_check" CHECK ("onboarding_preview_budgets"."daily_attempts" >= 0 and "onboarding_preview_budgets"."lifetime_attempts" >= 0 and "onboarding_preview_budgets"."daily_attempts" <= "onboarding_preview_budgets"."lifetime_attempts")
);
-- Default privileges used by older deploys grant broad DML to the app role.
-- Narrow every non-owner grantee inside this creating migration transaction,
-- before an interrupted migrator can commit destructive economic authority.
DO $onboarding_preview_budget_acl_firebreak$
DECLARE
  grantee_name text;
BEGIN
  FOR grantee_name IN
    SELECT DISTINCT grantee
    FROM information_schema.table_privileges
    WHERE table_schema = current_schema()
      AND table_name = 'onboarding_preview_budgets'
      AND grantee NOT IN (current_user, 'PUBLIC')
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM %I',
      current_schema(), 'onboarding_preview_budgets', grantee_name
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE ON TABLE %I.%I TO %I',
      current_schema(), 'onboarding_preview_budgets', grantee_name
    );
  END LOOP;
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM PUBLIC',
    current_schema(), 'onboarding_preview_budgets'
  );
END
$onboarding_preview_budget_acl_firebreak$;
--> statement-breakpoint
CREATE TABLE "stripe_projection_leases" (
	"subscription_id" text PRIMARY KEY NOT NULL,
	"lease_token" uuid NOT NULL,
	"lease_expires_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "checkout_terms" jsonb;--> statement-breakpoint
CREATE INDEX "stripe_projection_leases_expiry_idx" ON "stripe_projection_leases" USING btree ("lease_expires_at");
