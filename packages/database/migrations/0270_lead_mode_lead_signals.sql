CREATE TABLE "lead_signals" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"campaign_id" bigint NOT NULL,
	"person_key" text NOT NULL,
	"profile_id" text,
	"member_urn" text,
	"name" text,
	"headline" text,
	"kind" text NOT NULL,
	"post_urn" text NOT NULL,
	"comment_urn" text,
	"url" text,
	"words" text NOT NULL,
	"said_at" bigint,
	"language_type" text,
	"phrase_id" bigint,
	"verdict" text DEFAULT 'pending' NOT NULL,
	"role" text,
	"drop_reason" text,
	"reason" text,
	"run_id" bigint,
	"seen_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "lead_signals_values_check" CHECK ("lead_signals"."person_key" ~ '^[pm][.]'
        and "lead_signals"."kind" in ('post', 'comment') and ("lead_signals"."kind" = 'comment') = ("lead_signals"."comment_urn" is not null)
        and ("lead_signals"."language_type" is null or "lead_signals"."language_type" in ('pain', 'desired_outcome', 'failed_alternative', 'comparison', 'direct_ask'))
        and "lead_signals"."verdict" in ('pending', 'passed', 'dropped')
        and ("lead_signals"."role" is null or "lead_signals"."role" in ('buyer', 'peer', 'competitor', 'partner', 'noise'))
        and ("lead_signals"."drop_reason" is null or "lead_signals"."drop_reason" in ('no_own_words', 'selling_similar', 'already_solved', 'recruiter', 'student'))
        and ("lead_signals"."verdict" = 'dropped') = ("lead_signals"."drop_reason" is not null))
);
--> statement-breakpoint
ALTER TABLE "lead_signals" ADD CONSTRAINT "lead_signals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_signals" ADD CONSTRAINT "lead_signals_org_campaign_fk" FOREIGN KEY ("organization_id","campaign_id") REFERENCES "public"."campaigns"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- A composite FK would null the required organization column too; only the phrase goes (PostgreSQL 15).
ALTER TABLE "lead_signals" ADD CONSTRAINT "lead_signals_org_phrase_fk" FOREIGN KEY ("organization_id","phrase_id") REFERENCES "public"."listening_phrases"("organization_id","id") ON DELETE set null ("phrase_id") ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lead_signals_org_campaign_words_unq" ON "lead_signals" USING btree ("organization_id","campaign_id",coalesce("comment_urn", "post_urn"));--> statement-breakpoint
CREATE INDEX "lead_signals_org_person_seen_idx" ON "lead_signals" USING btree ("organization_id","person_key","seen_at");--> statement-breakpoint
CREATE INDEX "lead_signals_org_campaign_verdict_idx" ON "lead_signals" USING btree ("organization_id","campaign_id","verdict","seen_at");
--> statement-breakpoint
-- Generated tenant policies from packages/database/rls.ts
ALTER TABLE "lead_signals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "lead_signals" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "lead_signals";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_read ON "lead_signals";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_append ON "lead_signals";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_update ON "lead_signals";
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_retention_delete ON "lead_signals";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "lead_signals" USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
