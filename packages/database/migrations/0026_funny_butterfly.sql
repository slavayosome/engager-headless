CREATE TABLE "author_profiles" (
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"profile_id" text NOT NULL,
	"headline" text,
	"location" text,
	"country" text,
	"followers" bigint,
	"connections" bigint,
	"is_influencer" boolean,
	"is_premium" boolean,
	"fetched_at" bigint NOT NULL,
	"fetch_error" text,
	CONSTRAINT "author_profiles_organization_id_profile_id_pk" PRIMARY KEY("organization_id","profile_id")
);
--> statement-breakpoint
ALTER TABLE "discovered_posts" ADD COLUMN "author_followers" bigint;--> statement-breakpoint
ALTER TABLE "discovered_posts" ADD COLUMN "author_connections" bigint;--> statement-breakpoint
ALTER TABLE "author_profiles" ADD CONSTRAINT "author_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;