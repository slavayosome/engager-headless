CREATE TABLE "room_reply_assists" (
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"target_key" text NOT NULL,
	"campaign_id" bigint NOT NULL,
	"channel_id" bigint NOT NULL,
	"target" jsonb NOT NULL,
	"deliverable" text NOT NULL,
	"texts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence_expires_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "room_reply_assists_organization_id_target_key_deliverable_pk" PRIMARY KEY("organization_id","target_key","deliverable"),
	CONSTRAINT "room_reply_assists_deliverable" CHECK ("room_reply_assists"."deliverable" in ('reply', 'invite_note'))
);
--> statement-breakpoint
ALTER TABLE "room_members" ADD COLUMN "draft_request_id" uuid;--> statement-breakpoint
ALTER TABLE "room_members" ADD COLUMN "draft_requested_at" bigint;--> statement-breakpoint
ALTER TABLE "room_members" ADD COLUMN "draft_request" jsonb;--> statement-breakpoint
ALTER TABLE "room_reply_assists" ADD CONSTRAINT "room_reply_assists_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_reply_assists" ADD CONSTRAINT "room_reply_assists_org_channel_fk" FOREIGN KEY ("organization_id","channel_id") REFERENCES "public"."channels"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_reply_assists" ADD CONSTRAINT "room_reply_assists_org_campaign_fk" FOREIGN KEY ("organization_id","campaign_id") REFERENCES "public"."campaigns"("organization_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Generated tenant policies from packages/database/rls.ts
ALTER TABLE "room_reply_assists" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "room_reply_assists" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "room_reply_assists";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_read ON "room_reply_assists";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_append ON "room_reply_assists";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_update ON "room_reply_assists";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_retention_delete ON "room_reply_assists";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "room_reply_assists" USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
