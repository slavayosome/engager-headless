ALTER TABLE "subscriptions" ADD COLUMN "guarded_cancellation_token" uuid;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "guarded_cancellation_started_at" bigint;