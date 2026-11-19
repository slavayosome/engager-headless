CREATE TABLE "voice_revisions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"voice_id" bigint NOT NULL,
	"revision" integer NOT NULL,
	"source" text NOT NULL,
	"style_rules" jsonb,
	"channels" jsonb,
	"consumed_sample_ids" jsonb,
	"created_at" bigint NOT NULL,
	CONSTRAINT "voice_revisions_revision_check" CHECK ("voice_revisions"."revision" >= 0),
	CONSTRAINT "voice_revisions_source_check" CHECK ("voice_revisions"."source" in ('initial', 'client_calibration', 'hosted_fallback', 'relearn', 'manual'))
);
--> statement-breakpoint
ALTER TABLE "voice_revisions" ADD CONSTRAINT "voice_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "voice_revisions_org_voice_revision_unq" ON "voice_revisions" USING btree ("organization_id","voice_id","revision");--> statement-breakpoint
CREATE INDEX "voice_revisions_org_voice_idx" ON "voice_revisions" USING btree ("organization_id","voice_id","revision");--> statement-breakpoint
ALTER TABLE "voice_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "voice_revisions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "voice_revisions"
	USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);