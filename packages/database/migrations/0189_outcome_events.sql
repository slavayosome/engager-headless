CREATE TABLE "outcome_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"channel_id" bigint NOT NULL,
	"author_profile_id" text,
	"journey_id" bigint,
	"type" text NOT NULL,
	"occurred_at" bigint NOT NULL,
	"observed_at" bigint NOT NULL,
	"source_type" text NOT NULL,
	"source_event_id" text NOT NULL,
	"evidence_ref" text,
	"verification_status" text NOT NULL,
	"attribution_method" text NOT NULL,
	"customer_ref_hash" text,
	"note" text,
	"supersedes_event_id" bigint,
	"recorded_by" text NOT NULL,
	"retention_class" text DEFAULT 'audit' NOT NULL,
	"expires_at" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "outcome_events_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "outcome_events_org_source_key" UNIQUE("organization_id","source_type","source_event_id"),
	CONSTRAINT "outcome_events_type_check" CHECK ("outcome_events"."type" in ('cta_offered', 'booked', 'activated', 'paid', 'cancelled', 'refunded')),
	CONSTRAINT "outcome_events_verification_check" CHECK (("outcome_events"."source_type" = 'owner_attestation' and "outcome_events"."verification_status" = 'user_confirmed') or ("outcome_events"."source_type" = 'imported_receipt' and "outcome_events"."verification_status" = 'receipt_reviewed') or ("outcome_events"."source_type" = 'provider' and "outcome_events"."verification_status" = 'provider_verified')),
	CONSTRAINT "outcome_events_attribution_check" CHECK (("outcome_events"."attribution_method" = 'unknown' and "outcome_events"."journey_id" is null and "outcome_events"."author_profile_id" is null) or ("outcome_events"."attribution_method" in ('user_confirmed', 'consented_identifier') and "outcome_events"."journey_id" is not null and "outcome_events"."author_profile_id" is not null)),
	CONSTRAINT "outcome_events_reversal_check" CHECK ("outcome_events"."type" not in ('cancelled', 'refunded') or "outcome_events"."supersedes_event_id" is not null),
	CONSTRAINT "outcome_events_no_linkedin_identity_check" CHECK (("outcome_events"."source_event_id" || ' ' || coalesce("outcome_events"."evidence_ref", '') || ' ' || coalesce("outcome_events"."note", '')) !~* 'linkedin\.[a-z]|lnkd\.in|urn:li:' and ("outcome_events"."source_event_id" || ' ' || coalesce("outcome_events"."evidence_ref", '') || ' ' || coalesce("outcome_events"."note", '')) !~ 'ACoA[A-Za-z0-9_-]{8,}'),
	CONSTRAINT "outcome_events_retention_check" CHECK ("outcome_events"."retention_class" = 'audit')
);
--> statement-breakpoint
ALTER TABLE "journeys" DROP CONSTRAINT "journeys_derived_stage_check";--> statement-breakpoint
ALTER TABLE "journeys" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "journeys" ADD COLUMN "outcome_event_id" bigint;--> statement-breakpoint
ALTER TABLE "outcome_events" ADD CONSTRAINT "outcome_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_events" ADD CONSTRAINT "outcome_events_org_channel_fk" FOREIGN KEY ("organization_id","channel_id") REFERENCES "public"."channels"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_events" ADD CONSTRAINT "outcome_events_org_journey_fk" FOREIGN KEY ("organization_id","journey_id") REFERENCES "public"."journeys"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_events" ADD CONSTRAINT "outcome_events_org_person_fk" FOREIGN KEY ("organization_id","author_profile_id") REFERENCES "public"."author_profiles"("organization_id","profile_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_events" ADD CONSTRAINT "outcome_events_org_supersedes_fk" FOREIGN KEY ("organization_id","supersedes_event_id") REFERENCES "public"."outcome_events"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "outcome_events_org_supersedes_unq" ON "outcome_events" USING btree ("organization_id","supersedes_event_id") WHERE "outcome_events"."supersedes_event_id" is not null;--> statement-breakpoint
CREATE INDEX "outcome_events_org_journey_idx" ON "outcome_events" USING btree ("organization_id","journey_id") WHERE "outcome_events"."journey_id" is not null;--> statement-breakpoint
CREATE INDEX "outcome_events_org_channel_occurred_idx" ON "outcome_events" USING btree ("organization_id","channel_id","occurred_at");--> statement-breakpoint
CREATE INDEX "outcome_events_org_customer_idx" ON "outcome_events" USING btree ("organization_id","customer_ref_hash") WHERE "outcome_events"."customer_ref_hash" is not null;--> statement-breakpoint
ALTER TABLE "journeys" ADD CONSTRAINT "journeys_outcome_check" CHECK (("journeys"."outcome" is null and "journeys"."outcome_event_id" is null) or ("journeys"."outcome" in ('booked', 'activated', 'paid') and "journeys"."outcome_event_id" is not null));--> statement-breakpoint
ALTER TABLE "journeys" ADD CONSTRAINT "journeys_derived_stage_check" CHECK ("journeys"."derived_stage" in ('engaged', 'connected', 'conversing', 'interested', 'cta_offered', 'booked', 'activated', 'paid', 'closed'));--> statement-breakpoint
ALTER TABLE "outcome_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "outcome_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_read ON "outcome_events" FOR SELECT USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_append ON "outcome_events" FOR INSERT WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);