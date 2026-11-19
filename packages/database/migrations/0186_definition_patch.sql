ALTER TABLE "campaign_definitions" DROP CONSTRAINT "campaign_definitions_status_check";--> statement-breakpoint
ALTER TABLE "chat_pending_changes" ALTER COLUMN "session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_pending_changes" ALTER COLUMN "turn_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_definitions" ADD CONSTRAINT "campaign_definitions_status_check" CHECK ("campaign_definitions"."status" in ('draft', 'active', 'archived', 'pending_review', 'cancelled'));