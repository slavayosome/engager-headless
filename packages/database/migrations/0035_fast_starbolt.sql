CREATE TABLE "comment_watches" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"message_id" bigint NOT NULL,
	"campaign_id" bigint,
	"post_urn" text NOT NULL,
	"comment_urn" text NOT NULL,
	"resolved_comment_id" text,
	"last_reply_count" integer DEFAULT 0 NOT NULL,
	"last_reaction_count" integer DEFAULT 0 NOT NULL,
	"seen_reactor_ids" jsonb,
	"quiet_checks" integer DEFAULT 0 NOT NULL,
	"next_check_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "incoming_comments" ADD COLUMN "source" text DEFAULT 'own_post' NOT NULL;--> statement-breakpoint
ALTER TABLE "incoming_comments" ADD COLUMN "thread_parent_urn" text;--> statement-breakpoint
ALTER TABLE "comment_watches" ADD CONSTRAINT "comment_watches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_watches" ADD CONSTRAINT "comment_watches_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_watches" ADD CONSTRAINT "comment_watches_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "comment_watches_org_message_unq" ON "comment_watches" USING btree ("organization_id","message_id");--> statement-breakpoint
CREATE INDEX "comment_watches_org_state_next_idx" ON "comment_watches" USING btree ("organization_id","state","next_check_at");