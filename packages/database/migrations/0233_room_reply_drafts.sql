CREATE TABLE "room_reply_drafts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"channel_id" bigint NOT NULL,
	"campaign_id" bigint NOT NULL,
	"target_key" text NOT NULL,
	"target" jsonb,
	"text" text DEFAULT '' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"authorship" text DEFAULT 'unknown' NOT NULL,
	"assist_texts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"owner_words" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"assist_retention" real,
	"owner_origin" real,
	"evidence_expires_at" bigint NOT NULL,
	"erased_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "room_reply_drafts_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "room_reply_drafts_values_check" CHECK ("room_reply_drafts"."revision" >= 0 and "room_reply_drafts"."authorship" in ('unknown', 'owner', 'assisted')
    and ("room_reply_drafts"."assist_retention" is null or "room_reply_drafts"."assist_retention" between 0 and 1)
    and ("room_reply_drafts"."owner_origin" is null or "room_reply_drafts"."owner_origin" between 0 and 1)),
	CONSTRAINT "room_reply_drafts_erasure_check" CHECK (("room_reply_drafts"."erased_at" is null) = ("room_reply_drafts"."target" is not null))
);
--> statement-breakpoint
ALTER TABLE "room_reply_drafts" ADD CONSTRAINT "room_reply_drafts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_reply_drafts" ADD CONSTRAINT "room_reply_drafts_org_channel_fk" FOREIGN KEY ("organization_id","channel_id") REFERENCES "public"."channels"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_reply_drafts" ADD CONSTRAINT "room_reply_drafts_org_campaign_fk" FOREIGN KEY ("organization_id","campaign_id") REFERENCES "public"."campaigns"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "room_reply_drafts_org_target_unq" ON "room_reply_drafts" USING btree ("organization_id","target_key");--> statement-breakpoint
CREATE INDEX "room_reply_drafts_org_campaign_idx" ON "room_reply_drafts" USING btree ("organization_id","campaign_id");
--> statement-breakpoint
ALTER TABLE "room_reply_drafts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "room_reply_drafts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "room_reply_drafts"
  USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
