ALTER TABLE "channels" ADD COLUMN "execution_authority_lease_until" bigint;--> statement-breakpoint
ALTER TABLE "engagement_leases" ADD COLUMN "account_key" text;--> statement-breakpoint
ALTER TABLE "engagement_leases" ADD COLUMN "epoch" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "engagement_leases" ADD COLUMN "authority_state" text DEFAULT 'paused_recovery' NOT NULL;--> statement-breakpoint
ALTER TABLE "engagement_leases" ADD CONSTRAINT "engagement_leases_account_key_unique" UNIQUE("account_key");