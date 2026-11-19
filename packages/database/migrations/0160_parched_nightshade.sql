CREATE TABLE "chat_broker_turns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"credential_binding" text NOT NULL,
	"request_hash" text NOT NULL,
	"selection" jsonb NOT NULL,
	"status" text NOT NULL,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interactive_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"credential_binding" text NOT NULL,
	"kind" text NOT NULL,
	"context" jsonb NOT NULL,
	"context_revision" text NOT NULL,
	"status" text DEFAULT 'awaiting_agent' NOT NULL,
	"receipts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "agent_reference" jsonb;--> statement-breakpoint
ALTER TABLE "chat_broker_turns" ADD CONSTRAINT "chat_broker_turns_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_broker_turns" ADD CONSTRAINT "chat_broker_turns_organization_id_session_id_chat_sessions_organization_id_id_fk" FOREIGN KEY ("organization_id","session_id") REFERENCES "public"."chat_sessions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_stages" ADD CONSTRAINT "interactive_stages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_broker_turns_active" ON "chat_broker_turns" USING btree ("organization_id","session_id") WHERE "chat_broker_turns"."status" in ('running', 'recovery_required');
--> statement-breakpoint
ALTER TABLE "chat_broker_turns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_broker_turns" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "chat_broker_turns" USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);

--> statement-breakpoint
ALTER TABLE "interactive_stages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "interactive_stages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "interactive_stages" USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
