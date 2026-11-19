ALTER TABLE "email_delivery_receipts" DROP CONSTRAINT "email_delivery_receipts_kind_chk";--> statement-breakpoint
ALTER TABLE "tenant_runtimes" ADD COLUMN "health_checked_at" bigint;--> statement-breakpoint
ALTER TABLE "tenant_runtimes" ADD COLUMN "health_failure_since" bigint;--> statement-breakpoint
ALTER TABLE "tenant_runtimes" ADD COLUMN "health_runtime_updated_at" bigint;--> statement-breakpoint
ALTER TABLE "email_delivery_receipts" ADD CONSTRAINT "email_delivery_receipts_kind_chk" CHECK ("email_delivery_receipts"."kind" in ('batch_refill', 'lead_hot', 'lead_nudge', 'checkpoint', 'runtime_alert'));