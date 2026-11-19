ALTER TABLE "system_state" ADD COLUMN "transfer_paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_runtimes" ADD COLUMN "runtime_organization_id" uuid;--> statement-breakpoint
ALTER TABLE "tenant_runtimes" ADD COLUMN "fly_volume_id" text;