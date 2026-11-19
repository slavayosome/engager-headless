CREATE TABLE "accounts" (
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" bigint,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "accounts_provider_provider_account_id_pk" PRIMARY KEY("provider","provider_account_id")
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"hashed_key" text NOT NULL,
	"name" text,
	"expires_at" bigint,
	"last_used_at" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "api_keys_hashed_key_unique" UNIQUE("hashed_key")
);
--> statement-breakpoint
CREATE TABLE "brain_questions" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"slot" text NOT NULL,
	"question" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"answer" text,
	"created_at" bigint NOT NULL,
	"answered_at" bigint
);
--> statement-breakpoint
CREATE TABLE "brain_state" (
	"organization_id" uuid PRIMARY KEY DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"slots" jsonb,
	"fill_score" real DEFAULT 0 NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_guidance" (
	"campaign_id" bigint PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"guidance" text DEFAULT '' NOT NULL,
	"derived_from" bigint DEFAULT 0 NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"run_mode" text DEFAULT 'shadow' NOT NULL,
	"approval_mode" text DEFAULT 'hybrid' NOT NULL,
	"discovery" jsonb,
	"max_post_age_days" bigint DEFAULT 3 NOT NULL,
	"ai_filter" jsonb,
	"tone" jsonb,
	"prompts" jsonb,
	"like_when_commenting" boolean DEFAULT true NOT NULL,
	"hourly_comment_cap" bigint DEFAULT 3 NOT NULL,
	"daily_comment_cap" bigint DEFAULT 20 NOT NULL,
	"per_profile_day_cap" bigint DEFAULT 1 NOT NULL,
	"per_profile_week_cap" bigint DEFAULT 2 NOT NULL,
	"per_profile_month_cap" bigint DEFAULT 4 NOT NULL,
	"daily_reply_cap" bigint DEFAULT 25 NOT NULL,
	"active_hours" jsonb,
	"active_days" jsonb,
	"min_delay_sec" bigint DEFAULT 40 NOT NULL,
	"max_delay_sec" bigint DEFAULT 180 NOT NULL,
	"warmup_weeks" bigint DEFAULT 3 NOT NULL,
	"warmup_started_at" bigint,
	"auto_reply" jsonb,
	"diversity_reject_threshold" real DEFAULT 0.92 NOT NULL,
	"premium_writer" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovered_posts" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"campaign_id" bigint NOT NULL,
	"post_urn" text NOT NULL,
	"author_profile_id" text,
	"author_name" text,
	"url" text,
	"content_text" text,
	"media" jsonb,
	"posted_at" bigint,
	"detected_language" text,
	"author_geo" text,
	"discovered_at" bigint NOT NULL,
	"metrics" jsonb,
	"filter_score" real,
	"filter_passed" boolean,
	"filter_reason" text,
	"meaningfulness" real,
	"status" text DEFAULT 'new' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "engaged_profiles" (
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"profile_id" text NOT NULL,
	"name" text,
	"headline" text,
	"company" text,
	"url" text,
	"first_engaged_at" bigint,
	"last_engaged_at" bigint,
	"total_comments" bigint DEFAULT 0 NOT NULL,
	"total_replies" bigint DEFAULT 0 NOT NULL,
	"do_not_engage" boolean DEFAULT false NOT NULL,
	"retain_until" bigint,
	"notes" text,
	CONSTRAINT "engaged_profiles_organization_id_profile_id_pk" PRIMARY KEY("organization_id","profile_id")
);
--> statement-breakpoint
CREATE TABLE "engagement_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"message_id" bigint,
	"own_post_urn" text,
	"actor_profile_id" text,
	"actor_name" text,
	"type" text NOT NULL,
	"ts" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exemplars" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"campaign_id" bigint,
	"kind" text NOT NULL,
	"context_text" text NOT NULL,
	"response_text" text NOT NULL,
	"label" text NOT NULL,
	"source" text NOT NULL,
	"embedding" jsonb,
	"embedding_model" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"message_id" bigint NOT NULL,
	"verdict" text NOT NULL,
	"edited_text" text,
	"reason_tags" jsonb,
	"free_text_note" text,
	"rating" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incoming_comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"campaign_id" bigint,
	"own_post_urn" text NOT NULL,
	"comment_urn" text NOT NULL,
	"commenter_profile_id" text,
	"commenter_name" text,
	"text" text NOT NULL,
	"received_at" bigint NOT NULL,
	"sensitivity" text DEFAULT 'ok' NOT NULL,
	"status" text DEFAULT 'new' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"token" uuid DEFAULT gen_random_uuid() NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "invitations_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"max_attempts" bigint DEFAULT 5 NOT NULL,
	"next_run_at" bigint NOT NULL,
	"locked_at" bigint,
	"idempotency_key" text,
	"last_error" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"slot" text NOT NULL,
	"title" text,
	"content" text NOT NULL,
	"tags" jsonb,
	"source" text NOT NULL,
	"source_path" text,
	"content_hash" text NOT NULL,
	"embedding" jsonb,
	"embedding_model" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"is_owner" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"kind" text NOT NULL,
	"campaign_id" bigint,
	"discovered_post_id" bigint,
	"incoming_comment_id" bigint,
	"target_profile_id" text,
	"comment_type" text,
	"proposed_text" text NOT NULL,
	"final_text" text,
	"status" text DEFAULT 'proposed' NOT NULL,
	"dedupe_key" text NOT NULL,
	"external_urn" text,
	"prompt_version_id" bigint,
	"loop_version" text,
	"model" text,
	"error" text,
	"created_at" bigint NOT NULL,
	"posted_at" bigint
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"logo" text,
	"billing_customer_id" text,
	"obsidian_vault_path" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "profile" (
	"organization_id" uuid PRIMARY KEY DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"display_name" text,
	"voice_persona" text,
	"voice_house_style" text,
	"voice_learned_from" bigint DEFAULT 0 NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompts" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"kind" text NOT NULL,
	"template" text NOT NULL,
	"hash" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit_ledger" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"ts" bigint NOT NULL,
	"action" text NOT NULL,
	"campaign_id" bigint,
	"target_profile_id" text,
	"message_id" bigint,
	"meta" jsonb
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"provider" text NOT NULL,
	"encrypted_state" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_validated_at" bigint,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"session_token" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"status" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"provider" text DEFAULT 'stripe' NOT NULL,
	"items" jsonb,
	"period_starts_at" bigint,
	"period_ends_at" bigint,
	"trial_ends_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_state" (
	"organization_id" uuid PRIMARY KEY DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"kill_switch" boolean DEFAULT false NOT NULL,
	"paused_reason" text,
	"paused_until" bigint,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text,
	"email" text NOT NULL,
	"email_verified" timestamp,
	"image" text,
	"password_hash" text,
	"completed_onboarding" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification_tokens" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp NOT NULL,
	CONSTRAINT "verification_tokens_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_questions" ADD CONSTRAINT "brain_questions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_state" ADD CONSTRAINT "brain_state_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_guidance" ADD CONSTRAINT "campaign_guidance_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_guidance" ADD CONSTRAINT "campaign_guidance_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovered_posts" ADD CONSTRAINT "discovered_posts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovered_posts" ADD CONSTRAINT "discovered_posts_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engaged_profiles" ADD CONSTRAINT "engaged_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_events" ADD CONSTRAINT "engagement_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_events" ADD CONSTRAINT "engagement_events_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exemplars" ADD CONSTRAINT "exemplars_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exemplars" ADD CONSTRAINT "exemplars_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incoming_comments" ADD CONSTRAINT "incoming_comments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incoming_comments" ADD CONSTRAINT "incoming_comments_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge" ADD CONSTRAINT "knowledge_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_discovered_post_id_discovered_posts_id_fk" FOREIGN KEY ("discovered_post_id") REFERENCES "public"."discovered_posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile" ADD CONSTRAINT "profile_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_limit_ledger" ADD CONSTRAINT "rate_limit_ledger_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_state" ADD CONSTRAINT "system_state_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_org_idx" ON "api_keys" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "brain_questions_org_status_idx" ON "brain_questions" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "campaigns_org_status_idx" ON "campaigns" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "discovered_posts_org_post_urn_unq" ON "discovered_posts" USING btree ("organization_id","post_urn");--> statement-breakpoint
CREATE INDEX "discovered_posts_org_campaign_status_idx" ON "discovered_posts" USING btree ("organization_id","campaign_id","status");--> statement-breakpoint
CREATE INDEX "engagement_events_org_type_ts_idx" ON "engagement_events" USING btree ("organization_id","type","ts");--> statement-breakpoint
CREATE INDEX "exemplars_org_campaign_label_idx" ON "exemplars" USING btree ("organization_id","campaign_id","label");--> statement-breakpoint
CREATE INDEX "feedback_org_message_idx" ON "feedback" USING btree ("organization_id","message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "incoming_comments_org_comment_urn_unq" ON "incoming_comments" USING btree ("organization_id","comment_urn");--> statement-breakpoint
CREATE INDEX "incoming_comments_org_status_idx" ON "incoming_comments" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "invitations_org_idx" ON "invitations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "jobs_status_next_run_idx" ON "jobs" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_org_idempotency_unq" ON "jobs" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_org_hash_unq" ON "knowledge" USING btree ("organization_id","content_hash");--> statement-breakpoint
CREATE INDEX "knowledge_org_slot_idx" ON "knowledge" USING btree ("organization_id","slot");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_org_user_unq" ON "memberships" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_org_dedupe_unq" ON "messages" USING btree ("organization_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "messages_org_status_idx" ON "messages" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "messages_org_kind_status_idx" ON "messages" USING btree ("organization_id","kind","status");--> statement-breakpoint
CREATE UNIQUE INDEX "prompts_org_hash_unq" ON "prompts" USING btree ("organization_id","hash");--> statement-breakpoint
CREATE INDEX "ledger_org_action_ts_idx" ON "rate_limit_ledger" USING btree ("organization_id","action","ts");--> statement-breakpoint
CREATE INDEX "ledger_org_profile_ts_idx" ON "rate_limit_ledger" USING btree ("organization_id","target_profile_id","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "secrets_org_provider_unq" ON "secrets" USING btree ("organization_id","provider");--> statement-breakpoint
CREATE INDEX "subscriptions_org_idx" ON "subscriptions" USING btree ("organization_id");