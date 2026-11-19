ALTER TABLE "channels" ADD COLUMN "execution_runtime_id" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "execution_account_id" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "execution_placement" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "execution_epoch" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "execution_state" text DEFAULT 'paused_recovery' NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "execution_holder" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "execution_lease_until" bigint;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "execution_transfer_id" text;