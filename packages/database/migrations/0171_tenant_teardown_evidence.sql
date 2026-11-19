ALTER TABLE "tenant_runtimes" DROP CONSTRAINT "tenant_runtimes_status_check";--> statement-breakpoint
ALTER TABLE "tenant_runtimes" ADD COLUMN "teardown_evidence" jsonb;--> statement-breakpoint
ALTER TABLE "tenant_runtimes" ADD CONSTRAINT "tenant_runtimes_status_check" CHECK ("tenant_runtimes"."status" in ('provisioning', 'active', 'stopped', 'retired', 'disconnected', 'torn_down'));