-- Contract migration: retire the unused device authorization table, the Find
-- posts campaign flag and the runner-v2 capability marker row.
--
-- DESTRUCTIVE. A bare drizzle `.select()` names every declared column, so a
-- build from before this change takes 42703 on `campaigns` reads once it is
-- applied; the app migrates immediately before it starts the matching build.
DO $$ BEGIN
  IF current_setting('is_superuser') <> 'on' AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolbypassrls) THEN
    RAISE EXCEPTION 'Contract migration requires a role with BYPASSRLS';
  END IF;
  IF EXISTS (SELECT 1 FROM campaigns WHERE deleted_at IS NULL AND lead_mode = false) THEN
    RAISE EXCEPTION 'Cannot drop lead_mode: a non-deleted campaign still finds posts';
  END IF;
END $$;
--> statement-breakpoint
DROP TABLE "device_auth_requests";--> statement-breakpoint
ALTER TABLE "campaigns" DROP COLUMN "lead_mode";--> statement-breakpoint
DELETE FROM "deployment_metadata" WHERE "id" = 'runtime_capability:runner_v2_1_0080_exact_credentials_ready';
