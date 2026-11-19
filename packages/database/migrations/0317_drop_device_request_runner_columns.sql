-- Nothing reads these runner-only columns (the device flow in apps/cloud never touches them) and they hold only runner-era values. Constraints that post-migration maintenance installs on existing installs are dropped IF EXISTS.
DROP TRIGGER IF EXISTS "device_auth_requests_scheduled_identity_fence" ON "device_auth_requests";--> statement-breakpoint
DROP FUNCTION IF EXISTS enforce_scheduled_device_request_immutability();--> statement-breakpoint
ALTER TABLE "device_auth_requests" DROP CONSTRAINT IF EXISTS "device_auth_requests_purpose_check";--> statement-breakpoint
ALTER TABLE "device_auth_requests" DROP CONSTRAINT IF EXISTS "device_auth_requests_runner_shape_check";--> statement-breakpoint
ALTER TABLE "device_auth_requests" DROP CONSTRAINT IF EXISTS "device_auth_requests_org_bound_campaign_fk";--> statement-breakpoint
ALTER TABLE "organizations" DROP CONSTRAINT "organizations_runner_protocol_state_check";--> statement-breakpoint
ALTER TABLE "organizations" DROP CONSTRAINT "organizations_onboarding_operation_mode_check";--> statement-breakpoint
ALTER TABLE "device_auth_requests" DROP COLUMN "runner_id";--> statement-breakpoint
ALTER TABLE "device_auth_requests" DROP COLUMN "bound_campaign_id";--> statement-breakpoint
ALTER TABLE "device_auth_requests" DROP COLUMN "routine_id";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "onboarding_operation_mode";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "runner_protocol_state";
