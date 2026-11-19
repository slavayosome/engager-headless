CREATE TABLE "room_exclusions" (
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"identity_key" text NOT NULL,
	"person_key" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "room_exclusions_organization_id_identity_key_pk" PRIMARY KEY("organization_id","identity_key"),
	CONSTRAINT "room_exclusions_identity" CHECK ("room_exclusions"."identity_key" ~ '^[pm]\..+' and "room_exclusions"."person_key" ~ '^[pm]\..+')
);
--> statement-breakpoint
ALTER TABLE "journeys" ADD COLUMN "opened_from" text;--> statement-breakpoint
ALTER TABLE "journeys" ADD COLUMN "opened_from_post_id" bigint;--> statement-breakpoint
ALTER TABLE "room_exclusions" ADD CONSTRAINT "room_exclusions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "room_exclusions_org_person" ON "room_exclusions" USING btree ("organization_id","person_key");
--> statement-breakpoint
ALTER TABLE "room_exclusions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "room_exclusions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "room_exclusions"
  USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
