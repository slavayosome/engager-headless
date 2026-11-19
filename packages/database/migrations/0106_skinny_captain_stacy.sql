CREATE TABLE "angle_profile_revisions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"revision" integer NOT NULL,
	"weights" jsonb NOT NULL,
	"sample_count" integer NOT NULL,
	"source" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "angle_profile_revisions_revision_check" CHECK ("angle_profile_revisions"."revision" >= 1 and "angle_profile_revisions"."sample_count" >= 0),
	CONSTRAINT "angle_profile_revisions_source_check" CHECK ("angle_profile_revisions"."source" in ('client', 'backfill'))
);
--> statement-breakpoint
ALTER TABLE "voice_samples" ADD COLUMN "angle_labels" jsonb;--> statement-breakpoint
ALTER TABLE "voice_samples" ADD COLUMN "angle_matched_offered" boolean;--> statement-breakpoint
ALTER TABLE "voice_samples" ADD COLUMN "angle_classified_at" bigint;--> statement-breakpoint
ALTER TABLE "angle_profile_revisions" ADD CONSTRAINT "angle_profile_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "angle_profile_revisions_org_revision_unq" ON "angle_profile_revisions" USING btree ("organization_id","revision");--> statement-breakpoint
ALTER TABLE "angle_profile_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "angle_profile_revisions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "angle_profile_revisions"
	USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
