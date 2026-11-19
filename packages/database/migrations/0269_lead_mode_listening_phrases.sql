CREATE TABLE "listening_phrases" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"campaign_id" bigint NOT NULL,
	"source_key" text NOT NULL,
	"lane" text NOT NULL,
	"term" text NOT NULL,
	"display_name" text,
	"target_ref" text,
	"language_type" text,
	"pain_id" text,
	"origin" text NOT NULL,
	"source_role" text,
	"status" text DEFAULT 'active' NOT NULL,
	"refused_at" bigint,
	"pinned" boolean DEFAULT false NOT NULL,
	"rationale" text,
	"retired_at" bigint,
	"retired_by" text,
	"sort" text DEFAULT 'relevance' NOT NULL,
	"date_posted" text DEFAULT 'past_week' NOT NULL,
	"pages_per_sweep" integer DEFAULT 5 NOT NULL,
	"cursor" text,
	"last_swept_at" bigint,
	"buyers" integer DEFAULT 0 NOT NULL,
	"peers" integer DEFAULT 0 NOT NULL,
	"noise" integer DEFAULT 0 NOT NULL,
	"last_checked_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "listening_phrases_values_check" CHECK ("listening_phrases"."lane" in ('keywords', 'creators', 'competitors', 'one_thread')
        and ("listening_phrases"."language_type" is null or "listening_phrases"."language_type" in ('pain', 'desired_outcome', 'failed_alternative', 'comparison', 'direct_ask'))
        and "listening_phrases"."origin" in ('pains', 'scout', 'owner', 'like_a_post')
        and ("listening_phrases"."source_role" is null or "listening_phrases"."source_role" in ('peer', 'competitor'))
        and "listening_phrases"."status" in ('active', 'parked', 'retired')
        and ("listening_phrases"."retired_by" is null or "listening_phrases"."retired_by" in ('scout', 'owner'))
        and "listening_phrases"."sort" in ('relevance', 'latest')
        and "listening_phrases"."date_posted" in ('past_day', 'past_week', 'past_month')
        and "listening_phrases"."buyers" >= 0 and "listening_phrases"."peers" >= 0 and "listening_phrases"."noise" >= 0),
	CONSTRAINT "listening_phrases_language_type_check" CHECK (case when "listening_phrases"."lane" = 'keywords'
        then "listening_phrases"."origin" = 'like_a_post' or "listening_phrases"."language_type" is not null
        else "listening_phrases"."language_type" is null end),
	CONSTRAINT "listening_phrases_source_role_check" CHECK ("listening_phrases"."source_role" is null or "listening_phrases"."lane" in ('creators', 'competitors')),
	CONSTRAINT "listening_phrases_retired_check" CHECK (("listening_phrases"."retired_at" is null) = ("listening_phrases"."retired_by" is null)
        and ("listening_phrases"."retired_at" is not null) = ("listening_phrases"."status" = 'retired'))
);
--> statement-breakpoint
ALTER TABLE "listening_phrases" ADD CONSTRAINT "listening_phrases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listening_phrases" ADD CONSTRAINT "listening_phrases_org_campaign_fk" FOREIGN KEY ("organization_id","campaign_id") REFERENCES "public"."campaigns"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "listening_phrases_org_campaign_key_unq" ON "listening_phrases" USING btree ("organization_id","campaign_id","source_key");--> statement-breakpoint
CREATE UNIQUE INDEX "listening_phrases_org_id_unq" ON "listening_phrases" USING btree ("organization_id","id");
--> statement-breakpoint
-- Generated tenant policies from packages/database/rls.ts
ALTER TABLE "listening_phrases" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "listening_phrases" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "listening_phrases";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_read ON "listening_phrases";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_append ON "listening_phrases";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_update ON "listening_phrases";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_retention_delete ON "listening_phrases";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "listening_phrases" USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
