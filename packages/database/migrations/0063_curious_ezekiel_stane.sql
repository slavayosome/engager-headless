ALTER TABLE "onboarding_radar_previews" ADD COLUMN "reactivation_subscription_id" text;--> statement-breakpoint
ALTER TABLE "onboarding_radar_previews" ADD COLUMN "checkout_materializing_session_id" text;--> statement-breakpoint
ALTER TABLE "onboarding_radar_previews" ADD COLUMN "checkout_materializing_at" bigint;--> statement-breakpoint
-- Installed NOT VALID and validated by migrate.ts after the parent
-- subscriptions_org_id_unq index has been built concurrently.
CREATE UNIQUE INDEX "onboarding_radar_previews_org_reactivation_subscription_unq" ON "onboarding_radar_previews" USING btree ("organization_id","reactivation_subscription_id") WHERE "onboarding_radar_previews"."reactivation_subscription_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_radar_previews_checkout_materializing_session_unq" ON "onboarding_radar_previews" USING btree ("checkout_materializing_session_id") WHERE "onboarding_radar_previews"."checkout_materializing_session_id" is not null;
