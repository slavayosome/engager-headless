CREATE TABLE "chat_pending_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"before" jsonb NOT NULL,
	"summary" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"outcome" jsonb,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"decided_at" bigint
);
--> statement-breakpoint
ALTER TABLE "chat_pending_changes" ADD CONSTRAINT "chat_pending_changes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_pending_changes" ADD CONSTRAINT "chat_pending_changes_session_fk" FOREIGN KEY ("organization_id","session_id") REFERENCES "public"."chat_sessions"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_pending_changes_session_idx" ON "chat_pending_changes" USING btree ("organization_id","session_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_pending_changes_turn_idx" ON "chat_pending_changes" USING btree ("organization_id","turn_id");--> statement-breakpoint
ALTER TABLE "chat_pending_changes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_pending_changes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "chat_pending_changes";--> statement-breakpoint
DROP POLICY IF EXISTS tenant_read ON "chat_pending_changes";--> statement-breakpoint
DROP POLICY IF EXISTS tenant_append ON "chat_pending_changes";--> statement-breakpoint
DROP POLICY IF EXISTS tenant_update ON "chat_pending_changes";--> statement-breakpoint
DROP POLICY IF EXISTS tenant_retention_delete ON "chat_pending_changes";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "chat_pending_changes" USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
