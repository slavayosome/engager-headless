CREATE TABLE "offers" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"product_id" bigint NOT NULL,
	"url" text NOT NULL,
	"what" text NOT NULL,
	"facts" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"approved_hash" text,
	"approved_by" text,
	"approved_at" bigint,
	"retired_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "offers_org_product_key" UNIQUE("organization_id","product_id")
);
--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "offers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "offers"
	USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
