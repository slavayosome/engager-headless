ALTER TABLE "organizations" ADD COLUMN "linkedin_risk_acknowledged_at" bigint;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "linkedin_risk_acknowledged_by_user_id" uuid;