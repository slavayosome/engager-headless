-- Dropped tables hold no live data: the OAuth, sessions and lane-claim tables had no writer, and the Brain vault replaced knowledge long ago (its row count is logged below). Dropped columns were never read. batch_refill receipts were dedup keys for a sender that no longer exists, so they are deleted to let the kind check narrow.
DO $$ DECLARE refill_count bigint; knowledge_count bigint; BEGIN
  SELECT count(*) INTO refill_count FROM email_delivery_receipts WHERE kind = 'batch_refill';
  RAISE NOTICE 'Deleting % retired batch_refill receipts', refill_count;
  SELECT count(*) INTO knowledge_count FROM knowledge;
  RAISE NOTICE 'Dropping knowledge table with % rows', knowledge_count;
END $$;--> statement-breakpoint
DELETE FROM email_delivery_receipts WHERE kind = 'batch_refill';--> statement-breakpoint
DROP TABLE "knowledge";--> statement-breakpoint
DROP TABLE "oauth_grants";--> statement-breakpoint
DROP TABLE "oauth_authorization_codes";--> statement-breakpoint
DROP TABLE "oauth_clients";--> statement-breakpoint
DROP TABLE "organization_initial_hosted_lane_claims";--> statement-breakpoint
DROP TABLE "owner_initial_hosted_lane_claims";--> statement-breakpoint
DROP TABLE "sessions";--> statement-breakpoint
ALTER TABLE "campaigns" DROP CONSTRAINT "campaigns_reply_auto_post_consent_check";--> statement-breakpoint
ALTER TABLE "campaigns" DROP CONSTRAINT "campaigns_comment_auto_post_consent_check";--> statement-breakpoint
ALTER TABLE "email_delivery_receipts" DROP CONSTRAINT "email_delivery_receipts_kind_chk";--> statement-breakpoint
ALTER TABLE "organizations" DROP CONSTRAINT "organizations_own_post_reply_auto_post_consent_check";--> statement-breakpoint
ALTER TABLE "campaigns" DROP COLUMN "reply_auto_post_consented_at";--> statement-breakpoint
ALTER TABLE "campaigns" DROP COLUMN "reply_auto_post_consent_version";--> statement-breakpoint
ALTER TABLE "campaigns" DROP COLUMN "reply_auto_post_consented_by";--> statement-breakpoint
ALTER TABLE "campaigns" DROP COLUMN "comment_auto_post_consented_at";--> statement-breakpoint
ALTER TABLE "campaigns" DROP COLUMN "comment_auto_post_consent_version";--> statement-breakpoint
ALTER TABLE "campaigns" DROP COLUMN "comment_auto_post_consented_by";--> statement-breakpoint
ALTER TABLE "channels" DROP COLUMN "risk_acknowledged_by_user_id";--> statement-breakpoint
ALTER TABLE "exemplars" DROP COLUMN "embedding";--> statement-breakpoint
ALTER TABLE "exemplars" DROP COLUMN "embedding_model";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "draft_fit_embed_sim";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "linkedin_risk_acknowledged_by_user_id";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "mode_gate1_overridden_at";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "mode_gate1_overridden_by";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "own_post_reply_auto_post_consented_at";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "own_post_reply_auto_post_consent_version";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "own_post_reply_auto_post_consented_by";--> statement-breakpoint
ALTER TABLE "product_facts" DROP COLUMN "embedding";--> statement-breakpoint
ALTER TABLE "product_facts" DROP COLUMN "embedding_model";--> statement-breakpoint
ALTER TABLE "email_delivery_receipts" ADD CONSTRAINT "email_delivery_receipts_kind_chk" CHECK ("email_delivery_receipts"."kind" in ('lead_hot', 'lead_nudge', 'checkpoint', 'runtime_alert', 'trial_started', 'trial_ending', 'payment_failed'));
