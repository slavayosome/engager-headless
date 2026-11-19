CREATE TABLE "incoming_invitations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"channel_id" bigint NOT NULL,
	"invitation_id" text NOT NULL,
	"sender_profile_id" text NOT NULL,
	"sender_url" text NOT NULL,
	"sender_display_name" text,
	"note" text,
	"received_at" bigint,
	"first_observed_at" bigint NOT NULL,
	"observed_at" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"status_at" bigint NOT NULL,
	"attribution" text DEFAULT 'unmatched' NOT NULL,
	"attribution_evidence" jsonb NOT NULL,
	"journey_id" bigint,
	"journey_event_id" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "incoming_invitations_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "incoming_invitations_org_channel_invitation_key" UNIQUE("organization_id","channel_id","invitation_id"),
	CONSTRAINT "incoming_invitations_status_check" CHECK ("incoming_invitations"."status" in ('pending', 'accepted', 'gone', 'dismissed')),
	CONSTRAINT "incoming_invitations_attribution_check" CHECK (("incoming_invitations"."attribution" = 'unmatched' and "incoming_invitations"."journey_id" is null and "incoming_invitations"."journey_event_id" is null) or ("incoming_invitations"."attribution" in ('verified_exchange', 'user_confirmed_link') and "incoming_invitations"."journey_id" is not null and "incoming_invitations"."journey_event_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "incoming_invitations" ADD CONSTRAINT "incoming_invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incoming_invitations" ADD CONSTRAINT "incoming_invitations_org_channel_fk" FOREIGN KEY ("organization_id","channel_id") REFERENCES "public"."channels"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incoming_invitations" ADD CONSTRAINT "incoming_invitations_org_journey_fk" FOREIGN KEY ("organization_id","journey_id") REFERENCES "public"."journeys"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incoming_invitations" ADD CONSTRAINT "incoming_invitations_org_event_fk" FOREIGN KEY ("organization_id","journey_event_id") REFERENCES "public"."journey_events"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "incoming_invitations_org_channel_status_idx" ON "incoming_invitations" USING btree ("organization_id","channel_id","status","observed_at");--> statement-breakpoint
ALTER TABLE "incoming_invitations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "incoming_invitations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "incoming_invitations"
	USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
