ALTER TABLE "brain_state" ADD COLUMN "knowledge_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "compiled_brief" jsonb;