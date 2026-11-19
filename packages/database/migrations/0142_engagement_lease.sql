CREATE TABLE "engagement_leases" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"holder_id" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"claimed_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "engagement_leases" ADD CONSTRAINT "engagement_leases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;