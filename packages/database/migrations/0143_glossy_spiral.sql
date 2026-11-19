ALTER TABLE "channels" ADD COLUMN "writes_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "model_overrides" jsonb;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "agent_cli_bin" text;