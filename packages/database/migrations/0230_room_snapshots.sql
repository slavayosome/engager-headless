CREATE TABLE "room_members" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"discovered_post_id" bigint NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"person_key" text NOT NULL,
	"person_ref" text NOT NULL,
	"profile_id" text,
	"member_urn" text,
	"name" text,
	"headline" text,
	"fit" text NOT NULL,
	"pain_id" text,
	"reason" text,
	"evidence_refs" jsonb NOT NULL,
	"comments" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"campaign_id" bigint NOT NULL,
	"discovered_post_id" bigint NOT NULL,
	"audience_revision" integer NOT NULL,
	"read_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"reader" text NOT NULL,
	"run_id" bigint,
	"total_comments" integer NOT NULL,
	"comments_read" integer NOT NULL,
	"pages" integer NOT NULL,
	"orders" jsonb NOT NULL,
	"coverage" text NOT NULL,
	"summary" jsonb NOT NULL,
	"join_lens" text NOT NULL,
	CONSTRAINT "room_snapshots_bounds" CHECK ("room_snapshots"."pages" between 1 and 2 and "room_snapshots"."comments_read" between 0 and 100 and "room_snapshots"."total_comments" >= 0)
);
--> statement-breakpoint
ALTER TABLE "candidate_research" ADD COLUMN "room_snapshot_id" uuid;--> statement-breakpoint
ALTER TABLE "candidate_research" ADD COLUMN "room_summary" jsonb;--> statement-breakpoint
ALTER TABLE "candidate_research" ADD COLUMN "join_lens" text;--> statement-breakpoint
ALTER TABLE "candidate_research" ADD COLUMN "author_fit" text;--> statement-breakpoint
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_snapshots" ADD CONSTRAINT "room_snapshots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- room_snapshots_org_campaign_post_fk is installed by migrate.ts after
-- the concurrent discovered_posts tenant key exists, like candidate_research.
--> statement-breakpoint
CREATE UNIQUE INDEX "room_members_org_snapshot_person_unq" ON "room_members" USING btree ("organization_id","snapshot_id","person_key");--> statement-breakpoint
CREATE UNIQUE INDEX "room_members_org_id_unq" ON "room_members" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "room_snapshots_org_post_id_unq" ON "room_snapshots" USING btree ("organization_id","discovered_post_id","id");
--> statement-breakpoint
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_org_post_snapshot_fk" FOREIGN KEY ("organization_id","discovered_post_id","snapshot_id") REFERENCES "public"."room_snapshots"("organization_id","discovered_post_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "room_snapshots" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "room_snapshots" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "room_snapshots"
  USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "room_members" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "room_members" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "room_members"
  USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
