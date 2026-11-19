CREATE TABLE "journey_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"journey_id" bigint NOT NULL,
	"type" text NOT NULL,
	"source" text NOT NULL,
	"source_ref" jsonb NOT NULL,
	"provider_event_id" text,
	"digest" text NOT NULL,
	"content" text,
	"content_hash" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"occurred_at" bigint NOT NULL,
	"observed_at" bigint NOT NULL,
	"cursor" text,
	"attribution" jsonb NOT NULL,
	"evidence_spans" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decision" jsonb,
	"supersedes_event_id" bigint,
	"retention_class" text NOT NULL,
	"expires_at" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "journey_events_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "journey_events_digest_key" UNIQUE("journey_id","digest"),
	CONSTRAINT "journey_events_content_hash_check" CHECK (("journey_events"."content" is null) = ("journey_events"."content_hash" is null)),
	CONSTRAINT "journey_events_revision_check" CHECK ("journey_events"."revision" >= 1),
	CONSTRAINT "journey_events_retention_check" CHECK ("journey_events"."retention_class" in ('content', 'audit', 'suppression'))
);
--> statement-breakpoint
CREATE TABLE "journey_sources" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"journey_id" bigint NOT NULL,
	"campaign_id" bigint,
	"incoming_comment_id" bigint NOT NULL,
	"comment_watch_id" bigint,
	"source_ref" text NOT NULL,
	"deleted_at" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "journey_sources_org_incoming_key" UNIQUE("organization_id","incoming_comment_id")
);
--> statement-breakpoint
CREATE TABLE "journeys" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"channel_id" bigint NOT NULL,
	"author_profile_id" text NOT NULL,
	"owning_campaign_id" bigint,
	"relationship" text DEFAULT 'unknown' NOT NULL,
	"relationship_checked_at" bigint,
	"ops_status" text DEFAULT 'runnable' NOT NULL,
	"ops_status_at" bigint,
	"derived_stage" text DEFAULT 'engaged' NOT NULL,
	"interest_evidence_event_id" bigint,
	"cta_event_id" bigint,
	"canonical_dm_thread_id" bigint,
	"closed_reason" text,
	"closed_at" bigint,
	"retention_class" text DEFAULT 'audit' NOT NULL,
	"expires_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "journeys_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "journeys_relationship_check" CHECK ("journeys"."relationship" in ('unknown', 'not_connected', 'outgoing_pending', 'incoming_pending', 'connected')),
	CONSTRAINT "journeys_ops_status_check" CHECK ("journeys"."ops_status" in ('runnable', 'awaiting_review', 'paused', 'human_owned', 'blocked', 'uncertain')),
	CONSTRAINT "journeys_derived_stage_check" CHECK ("journeys"."derived_stage" in ('engaged', 'connected', 'conversing', 'interested', 'cta_offered', 'closed')),
	CONSTRAINT "journeys_closed_check" CHECK (("journeys"."closed_reason" is null and "journeys"."closed_at" is null) or ("journeys"."closed_reason" in ('opt_out', 'manual_exclude') and "journeys"."closed_at" is not null)),
	CONSTRAINT "journeys_retention_check" CHECK ("journeys"."retention_class" in ('audit', 'suppression'))
);
--> statement-breakpoint
ALTER TABLE "incoming_comments" ADD COLUMN "observed_at" bigint;--> statement-breakpoint
ALTER TABLE "journey_events" ADD CONSTRAINT "journey_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_events" ADD CONSTRAINT "journey_events_org_journey_fk" FOREIGN KEY ("organization_id","journey_id") REFERENCES "public"."journeys"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_events" ADD CONSTRAINT "journey_events_org_supersedes_fk" FOREIGN KEY ("organization_id","supersedes_event_id") REFERENCES "public"."journey_events"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_sources" ADD CONSTRAINT "journey_sources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_sources" ADD CONSTRAINT "journey_sources_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_sources" ADD CONSTRAINT "journey_sources_incoming_comment_id_incoming_comments_id_fk" FOREIGN KEY ("incoming_comment_id") REFERENCES "public"."incoming_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_sources" ADD CONSTRAINT "journey_sources_comment_watch_id_comment_watches_id_fk" FOREIGN KEY ("comment_watch_id") REFERENCES "public"."comment_watches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_sources" ADD CONSTRAINT "journey_sources_org_journey_fk" FOREIGN KEY ("organization_id","journey_id") REFERENCES "public"."journeys"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journeys" ADD CONSTRAINT "journeys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journeys" ADD CONSTRAINT "journeys_owning_campaign_id_campaigns_id_fk" FOREIGN KEY ("owning_campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journeys" ADD CONSTRAINT "journeys_org_channel_fk" FOREIGN KEY ("organization_id","channel_id") REFERENCES "public"."channels"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journeys" ADD CONSTRAINT "journeys_org_person_fk" FOREIGN KEY ("organization_id","author_profile_id") REFERENCES "public"."author_profiles"("organization_id","profile_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "journey_events_provider_event_unq" ON "journey_events" USING btree ("journey_id","provider_event_id") WHERE "journey_events"."provider_event_id" is not null;--> statement-breakpoint
CREATE INDEX "journey_events_journey_occurred_idx" ON "journey_events" USING btree ("organization_id","journey_id","occurred_at");--> statement-breakpoint
CREATE INDEX "journey_sources_org_journey_idx" ON "journey_sources" USING btree ("organization_id","journey_id");--> statement-breakpoint
CREATE UNIQUE INDEX "journeys_open_person_unq" ON "journeys" USING btree ("organization_id","channel_id","author_profile_id") WHERE "journeys"."closed_reason" is null;--> statement-breakpoint
CREATE INDEX "journeys_org_person_idx" ON "journeys" USING btree ("organization_id","author_profile_id","updated_at");--> statement-breakpoint
ALTER TABLE "journeys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "journeys" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "journeys"
	USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "journey_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "journey_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_read ON "journey_events" FOR SELECT USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_append ON "journey_events" FOR INSERT WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "journey_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "journey_sources" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "journey_sources"
	USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);