ALTER TABLE "messages" ADD COLUMN "room_reply_target" jsonb;--> statement-breakpoint
ALTER TABLE "rate_limit_ledger" ADD COLUMN "target_member_urn" text;