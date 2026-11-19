CREATE TABLE "campaign_audience_revisions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"campaign_id" bigint NOT NULL,
	"revision" integer NOT NULL,
	"profile" jsonb NOT NULL,
	"reason" text NOT NULL,
	"summary" text NOT NULL,
	"changed_by" text NOT NULL,
	"restored_from" integer,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "audience_profile" jsonb;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "audience_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_audience_revisions" ADD CONSTRAINT "campaign_audience_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_audience_revisions" ADD CONSTRAINT "campaign_audience_revisions_org_campaign_fk" FOREIGN KEY ("organization_id","campaign_id") REFERENCES "public"."campaigns"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_audience_revisions_org_campaign_revision_unq" ON "campaign_audience_revisions" USING btree ("organization_id","campaign_id","revision");
--> statement-breakpoint
ALTER TABLE "campaign_audience_revisions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "campaign_audience_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "campaign_audience_revisions"
  USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
--> statement-breakpoint
-- Preserve legacy matching without inferring structured facts. The predicate is
-- the missing profile, so an intentionally empty Who is never migrated twice.
DO $$
DECLARE
  tenant_id uuid;
  migrated_at bigint := floor(extract(epoch FROM clock_timestamp()) * 1000);
  previous_org text := current_setting('app.current_org', true);
BEGIN
  FOR tenant_id IN SELECT id FROM organizations LOOP
    PERFORM set_config('app.current_org', tenant_id::text, true);
    WITH moved AS (
      UPDATE campaigns SET
        audience_revision = 1,
        audience_profile = jsonb_build_object(
          'who', jsonb_build_object('summary', '', 'signals', '[]'::jsonb, 'companyKinds', '[]'::jsonb),
          'pains', '[]'::jsonb, 'notThem', '[]'::jsonb,
          'testSource', 'owner', 'ownerRule', coalesce(ai_filter->>'instruction', ''),
          'legacyResearchRestriction', 'product_builder',
          'revision', 1, 'updatedAt', migrated_at)
      WHERE organization_id = tenant_id AND audience_profile IS NULL
      RETURNING id, organization_id, audience_profile
    )
    INSERT INTO campaign_audience_revisions
      (organization_id, campaign_id, revision, profile, reason, summary, changed_by, created_at)
      SELECT organization_id, id, 1, audience_profile, 'migrated',
        'Preserved the original relevance rule', 'migration', migrated_at FROM moved;
  END LOOP;
  PERFORM set_config('app.current_org', coalesce(previous_org, ''), true);
END $$;
