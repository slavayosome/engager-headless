CREATE TABLE "voice_samples" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"voice_id" bigint,
	"text" text NOT NULL,
	"text_hash" text NOT NULL,
	"source" text NOT NULL,
	"assist_retention" real,
	"owner_origin" real,
	"eligible" boolean NOT NULL,
	"message_id" bigint,
	"campaign_id" bigint,
	"discovered_post_id" bigint,
	"onboarding_response_id" bigint,
	"captured_at" bigint NOT NULL,
	"used_in_voice_revision" integer,
	"disowned_at" bigint
);
--> statement-breakpoint
ALTER TABLE "voices" ADD COLUMN "style_rules_source" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "voice_samples" ADD CONSTRAINT "voice_samples_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "voice_samples_org_hash_unq" ON "voice_samples" USING btree ("organization_id","text_hash");--> statement-breakpoint
CREATE INDEX "voice_samples_org_voice_idx" ON "voice_samples" USING btree ("organization_id","voice_id","captured_at");--> statement-breakpoint
ALTER TABLE "voice_samples" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "voice_samples" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "voice_samples"
	USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
UPDATE "voices" SET "style_rules_source" = 'learned' WHERE "created_from" = 'learned';