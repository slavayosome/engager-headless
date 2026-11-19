CREATE TABLE "search_lookalikes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"campaign_id" bigint NOT NULL,
	"channel_id" bigint NOT NULL,
	"audience_revision" integer NOT NULL,
	"context_revision" text NOT NULL,
	"post_urn" text NOT NULL,
	"url" text NOT NULL,
	"status" text NOT NULL,
	"reader" text NOT NULL,
	"failure" text,
	"refusal_reason" text,
	"author_profile_id" text,
	"author_name" text,
	"author_headline" text,
	"opening" text DEFAULT '' NOT NULL,
	"comments" integer DEFAULT 0 NOT NULL,
	"judged" integer DEFAULT 0 NOT NULL,
	"fits" integer DEFAULT 0 NOT NULL,
	"pains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"proposals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	"read_started_at" bigint,
	"read_spent_at" bigint,
	"read_at" bigint,
	CONSTRAINT "search_lookalikes_bounds" CHECK ("search_lookalikes"."audience_revision" >= 0 and "search_lookalikes"."comments" >= 0 and "search_lookalikes"."judged" >= 0
    and "search_lookalikes"."fits" between 0 and "search_lookalikes"."judged" and length("search_lookalikes"."opening") <= 280 and jsonb_array_length("search_lookalikes"."proposals") <= 4),
	CONSTRAINT "search_lookalikes_status" CHECK ("search_lookalikes"."status" in ('reading', 'read', 'failed')),
	CONSTRAINT "search_lookalikes_reader" CHECK ("search_lookalikes"."reader" in ('server', 'agent'))
);
--> statement-breakpoint
ALTER TABLE "search_lookalikes" ADD CONSTRAINT "search_lookalikes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_lookalikes" ADD CONSTRAINT "search_lookalikes_org_campaign_fk" FOREIGN KEY ("organization_id","campaign_id") REFERENCES "public"."campaigns"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_lookalikes" ADD CONSTRAINT "search_lookalikes_org_channel_fk" FOREIGN KEY ("organization_id","channel_id") REFERENCES "public"."channels"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "search_lookalikes_org_campaign_created_idx" ON "search_lookalikes" USING btree ("organization_id","campaign_id","created_at");
--> statement-breakpoint
-- Generated tenant policies from packages/database/rls.ts
ALTER TABLE "search_lookalikes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "search_lookalikes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "search_lookalikes";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_read ON "search_lookalikes";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_append ON "search_lookalikes";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_update ON "search_lookalikes";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_retention_delete ON "search_lookalikes";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "search_lookalikes" USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
