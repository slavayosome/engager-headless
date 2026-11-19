CREATE TABLE "agent_runners" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"runner_id" text NOT NULL,
	"hostname" text,
	"version" text,
	"campaign_id" integer,
	"state" text NOT NULL,
	"interval_minutes" integer,
	"last_seen_at" bigint NOT NULL,
	"last_cycle_at" bigint,
	"last_outcome" jsonb,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"sessions_today" integer DEFAULT 0 NOT NULL,
	"next_wake_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runners" ADD CONSTRAINT "agent_runners_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runners_org_runner_unq" ON "agent_runners" USING btree ("organization_id","runner_id");