-- A JOURNEY'S DM THREAD AND THE INBOX'S COVERAGE (Phase 52). Two new tables,
-- each with its RLS family installed in this same file: `dm_threads`, a
-- tenant's own rows, and `inbox_reads`, append-only — read and insert, no
-- update or delete. Additive: no existing table, column or constraint moves.
CREATE TABLE "dm_threads" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"channel_id" bigint NOT NULL,
	"provider_thread_id" text NOT NULL,
	"journey_id" bigint,
	"binding" text NOT NULL,
	"participants" jsonb NOT NULL,
	"last_inbox_digest" text,
	"last_message_id" text,
	"last_observed_at" bigint NOT NULL,
	"last_thread_read_at" bigint,
	"human_draft_seen_at" bigint,
	"human_draft_hash" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "dm_threads_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "dm_threads_org_channel_provider_key" UNIQUE("organization_id","channel_id","provider_thread_id"),
	CONSTRAINT "dm_threads_binding_check" CHECK ("dm_threads"."binding" in ('bound', 'group', 'unmatched') and ("dm_threads"."binding" = 'bound') = ("dm_threads"."journey_id" is not null)),
	CONSTRAINT "dm_threads_draft_check" CHECK (("dm_threads"."human_draft_seen_at" is null) = ("dm_threads"."human_draft_hash" is null))
);
--> statement-breakpoint
CREATE TABLE "inbox_reads" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"channel_id" bigint NOT NULL,
	"campaign_id" bigint,
	"run_id" bigint,
	"outcome" text NOT NULL,
	"reason" text,
	"lookback_from" bigint NOT NULL,
	"threads_listed" integer DEFAULT 0 NOT NULL,
	"threads_read" integer DEFAULT 0 NOT NULL,
	"messages_recorded" integer DEFAULT 0 NOT NULL,
	"started_at" bigint NOT NULL,
	"finished_at" bigint NOT NULL,
	CONSTRAINT "inbox_reads_outcome_check" CHECK ("inbox_reads"."outcome" in ('read', 'refused', 'failed') and ("inbox_reads"."outcome" = 'read' or "inbox_reads"."reason" is not null))
);
--> statement-breakpoint
ALTER TABLE "dm_threads" ADD CONSTRAINT "dm_threads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_threads" ADD CONSTRAINT "dm_threads_org_channel_fk" FOREIGN KEY ("organization_id","channel_id") REFERENCES "public"."channels"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_threads" ADD CONSTRAINT "dm_threads_org_journey_fk" FOREIGN KEY ("organization_id","journey_id") REFERENCES "public"."journeys"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_reads" ADD CONSTRAINT "inbox_reads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_reads" ADD CONSTRAINT "inbox_reads_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_reads" ADD CONSTRAINT "inbox_reads_org_channel_fk" FOREIGN KEY ("organization_id","channel_id") REFERENCES "public"."channels"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dm_threads_org_journey_unq" ON "dm_threads" USING btree ("organization_id","journey_id") WHERE "dm_threads"."journey_id" is not null;--> statement-breakpoint
CREATE INDEX "inbox_reads_org_channel_finished_idx" ON "inbox_reads" USING btree ("organization_id","channel_id","finished_at");--> statement-breakpoint
ALTER TABLE "dm_threads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dm_threads" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "dm_threads"
	USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "inbox_reads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "inbox_reads" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_read ON "inbox_reads" FOR SELECT USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_append ON "inbox_reads" FOR INSERT WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
