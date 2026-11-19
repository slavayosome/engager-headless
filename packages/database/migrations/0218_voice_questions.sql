-- THE VOICE QUESTIONS. One new table, `voice_questions`, with its RLS family
-- installed in this same file: one row per voice and question
-- (`VOICE_QUESTIONS`, core/voice/questions.ts) recording whether the owner
-- answered, cleared or skipped it, where — the Voice page or their agent —
-- and when. The value an answer sets stays in `voices.style_rules` (or its
-- examples), where every writer reads it; a row is written only when the
-- owner answers one, and goes with its voice.
-- Expand-only: no existing table, column, constraint or row moves, and old
-- code never names it.
CREATE TABLE "voice_questions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"voice_id" bigint NOT NULL,
	"key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"answer" jsonb,
	"answered_via" text,
	"answered_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "voice_questions" ADD CONSTRAINT "voice_questions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_questions" ADD CONSTRAINT "voice_questions_voice_id_voices_id_fk" FOREIGN KEY ("voice_id") REFERENCES "public"."voices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "voice_questions_org_voice_key_unq" ON "voice_questions" USING btree ("organization_id","voice_id","key");--> statement-breakpoint
ALTER TABLE "voice_questions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "voice_questions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "voice_questions"
	USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
