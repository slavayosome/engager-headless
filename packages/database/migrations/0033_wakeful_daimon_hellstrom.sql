CREATE TABLE "voices" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"language" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"channels" jsonb,
	"style_rules" jsonb,
	"structural_range" jsonb,
	"created_from" text DEFAULT 'manual' NOT NULL,
	"cloned_from_id" bigint,
	"card" jsonb,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "voice_id" bigint;--> statement-breakpoint
ALTER TABLE "exemplars" ADD COLUMN "voice_id" bigint;--> statement-breakpoint
ALTER TABLE "voices" ADD CONSTRAINT "voices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "voices_org_idx" ON "voices" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "voices_org_default_unq" ON "voices" USING btree ("organization_id") WHERE is_default;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_voice_id_voices_id_fk" FOREIGN KEY ("voice_id") REFERENCES "public"."voices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exemplars" ADD CONSTRAINT "exemplars_voice_id_voices_id_fk" FOREIGN KEY ("voice_id") REFERENCES "public"."voices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO "voices" (organization_id, name, is_default, channels, structural_range, card, created_from, created_at, updated_at)
SELECT
  p.organization_id,
  'My voice',
  true,
  COALESCE(
    p.voices,
    CASE WHEN p.voice_persona IS NOT NULL OR p.voice_house_style IS NOT NULL THEN
      jsonb_build_object('comment', jsonb_build_object(
        'persona', p.voice_persona,
        'houseStyle', p.voice_house_style,
        'learnedFrom', COALESCE(p.voice_learned_from, 0),
        'sources', '["legacy"]'::jsonb,
        'updatedAt', (extract(epoch from now())*1000)::bigint
      ))
    ELSE NULL END
  ),
  p.voice_structural_range,
  p.voice_card,
  'migrated',
  (extract(epoch from now())*1000)::bigint,
  (extract(epoch from now())*1000)::bigint
FROM "profile" p
WHERE p.voices IS NOT NULL OR p.voice_persona IS NOT NULL OR p.voice_house_style IS NOT NULL;--> statement-breakpoint
ALTER TABLE "profile" FORCE ROW LEVEL SECURITY;
