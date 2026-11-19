ALTER TABLE "license_refresh_tokens" ADD COLUMN "refresh_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "license_refresh_tokens" ADD COLUMN "refresh_response_ciphertext" text;--> statement-breakpoint
ALTER TABLE "license_refresh_tokens" ADD COLUMN "refresh_replay_expires_at" bigint;