CREATE TABLE "discovery_sources" (
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"campaign_id" bigint NOT NULL,
	"source_key" text NOT NULL,
	"source_type" text NOT NULL,
	"term" text NOT NULL,
	"origin" text DEFAULT 'seed' NOT NULL,
	"cursor" text,
	"cursor_reason" text DEFAULT 'active' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"origin_config_hash" text,
	"new_posts_total" bigint DEFAULT 0 NOT NULL,
	"dup_page_streak" integer DEFAULT 0 NOT NULL,
	"cold_pages_remaining" integer DEFAULT 0 NOT NULL,
	"last_swept_at" bigint DEFAULT 0 NOT NULL,
	"last_new_at" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "discovery_sources_organization_id_campaign_id_source_key_pk" PRIMARY KEY("organization_id","campaign_id","source_key")
);
--> statement-breakpoint
CREATE TABLE "discovery_state" (
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"campaign_id" bigint NOT NULL,
	"rotation_index" bigint DEFAULT 0 NOT NULL,
	"seed_config_hash" text DEFAULT '' NOT NULL,
	"last_enriched_at" bigint DEFAULT 0 NOT NULL,
	"last_reset_at" bigint DEFAULT 0 NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "discovery_state_organization_id_campaign_id_pk" PRIMARY KEY("organization_id","campaign_id")
);
--> statement-breakpoint
ALTER TABLE "discovery_sources" ADD CONSTRAINT "discovery_sources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_sources" ADD CONSTRAINT "discovery_sources_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_state" ADD CONSTRAINT "discovery_state_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_state" ADD CONSTRAINT "discovery_state_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "discovery_sources_rank_idx" ON "discovery_sources" USING btree ("organization_id","campaign_id","status","last_new_at");