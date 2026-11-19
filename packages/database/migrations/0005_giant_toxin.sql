CREATE TABLE "campaign_products" (
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"campaign_id" bigint NOT NULL,
	"product_id" bigint NOT NULL,
	CONSTRAINT "campaign_products_campaign_id_product_id_pk" PRIMARY KEY("campaign_id","product_id")
);
--> statement-breakpoint
CREATE TABLE "product_facts" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"product_id" bigint NOT NULL,
	"facet" text NOT NULL,
	"content" text NOT NULL,
	"source" text NOT NULL,
	"source_path" text,
	"content_hash" text NOT NULL,
	"embedding" jsonb,
	"embedding_model" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"name" text NOT NULL,
	"one_liner" text,
	"status" text DEFAULT 'idea' NOT NULL,
	"link" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"fill_score" real DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "key_prefix" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "scopes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "brain_questions" ADD COLUMN "product_id" bigint;--> statement-breakpoint
ALTER TABLE "brain_questions" ADD COLUMN "product_facet" text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "objective" text DEFAULT 'visibility' NOT NULL;--> statement-breakpoint
ALTER TABLE "profile" ADD COLUMN "voice_channels" jsonb DEFAULT '{"linkedin":true,"brain":true,"vault":false}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_products" ADD CONSTRAINT "campaign_products_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_products" ADD CONSTRAINT "campaign_products_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_products" ADD CONSTRAINT "campaign_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_facts" ADD CONSTRAINT "product_facts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_facts" ADD CONSTRAINT "product_facts_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_facts_org_hash_unq" ON "product_facts" USING btree ("organization_id","content_hash");--> statement-breakpoint
CREATE INDEX "product_facts_org_product_facet_idx" ON "product_facts" USING btree ("organization_id","product_id","facet");--> statement-breakpoint
CREATE INDEX "products_org_idx" ON "products" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "brain_questions_org_product_idx" ON "brain_questions" USING btree ("organization_id","product_id");
--> statement-breakpoint
-- ============================================================================
-- Data backfill (idempotent). Runs once with the rest of 0005, as the DB owner
-- (RLS bypassed), so cross-org statements set organization_id explicitly.
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;--> statement-breakpoint
-- 1. Campaigns that carried product intent in `tone` become product-objective.
UPDATE "campaigns" SET "objective" = 'product'
WHERE "objective" = 'visibility'
  AND (
    coalesce(nullif(trim("tone"->>'product_name'), ''), '') <> ''
    OR coalesce(nullif(trim("tone"->>'usp'), ''), '') <> ''
  );--> statement-breakpoint
-- 2. One product per distinct (org, lower(name)) from campaigns with a product name.
INSERT INTO "products" ("organization_id","name","one_liner","source","status","fill_score","created_at","updated_at")
SELECT DISTINCT ON (c."organization_id", lower(trim(c."tone"->>'product_name')))
  c."organization_id",
  trim(c."tone"->>'product_name'),
  nullif(trim(c."tone"->>'product_description'), ''),
  'manual', 'idea', 0,
  (extract(epoch from now())*1000)::bigint,
  (extract(epoch from now())*1000)::bigint
FROM "campaigns" c
WHERE coalesce(nullif(trim(c."tone"->>'product_name'), ''), '') <> ''
  AND NOT EXISTS (
    SELECT 1 FROM "products" p
    WHERE p."organization_id" = c."organization_id"
      AND lower(p."name") = lower(trim(c."tone"->>'product_name'))
  )
ORDER BY c."organization_id", lower(trim(c."tone"->>'product_name')), c."id";--> statement-breakpoint
-- 3. Link each product-bearing campaign to its product.
INSERT INTO "campaign_products" ("organization_id","campaign_id","product_id")
SELECT c."organization_id", c."id", p."id"
FROM "campaigns" c
JOIN "products" p
  ON p."organization_id" = c."organization_id"
 AND lower(p."name") = lower(trim(c."tone"->>'product_name'))
WHERE coalesce(nullif(trim(c."tone"->>'product_name'), ''), '') <> ''
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- 4. Seed a `value` fact from each campaign's USP.
INSERT INTO "product_facts" ("organization_id","product_id","facet","content","source","content_hash","created_at","updated_at")
SELECT DISTINCT ON (p."organization_id", p."id", encode(digest(trim(c."tone"->>'usp'),'sha256'),'hex'))
  p."organization_id", p."id", 'value', trim(c."tone"->>'usp'), 'manual',
  encode(digest(trim(c."tone"->>'usp'),'sha256'),'hex'),
  (extract(epoch from now())*1000)::bigint,
  (extract(epoch from now())*1000)::bigint
FROM "campaigns" c
JOIN "products" p
  ON p."organization_id" = c."organization_id"
 AND lower(p."name") = lower(trim(c."tone"->>'product_name'))
WHERE coalesce(nullif(trim(c."tone"->>'usp'), ''), '') <> ''
ORDER BY p."organization_id", p."id", encode(digest(trim(c."tone"->>'usp'),'sha256'),'hex')
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- 5. For orgs that stored Brain `product`-slot knowledge but have no product yet,
--    create a holder product so that knowledge has somewhere to live.
INSERT INTO "products" ("organization_id","name","one_liner","source","status","fill_score","created_at","updated_at")
SELECT DISTINCT k."organization_id", 'Product', NULL, 'brain', 'idea', 0,
  (extract(epoch from now())*1000)::bigint,
  (extract(epoch from now())*1000)::bigint
FROM "knowledge" k
WHERE k."slot" = 'product'
  AND NOT EXISTS (SELECT 1 FROM "products" p WHERE p."organization_id" = k."organization_id");--> statement-breakpoint
-- 6. Move `product`-slot knowledge into the org's earliest product, facet `what`.
INSERT INTO "product_facts" ("organization_id","product_id","facet","content","source","content_hash","created_at","updated_at")
SELECT DISTINCT ON (k."organization_id", first_p.id, k."content_hash")
  k."organization_id", first_p.id, 'what', k."content",
  CASE WHEN k."source" IN ('obsidian','interview','manual') THEN k."source" ELSE 'manual' END,
  k."content_hash",
  (extract(epoch from now())*1000)::bigint,
  (extract(epoch from now())*1000)::bigint
FROM "knowledge" k
JOIN LATERAL (
  SELECT p."id" FROM "products" p
  WHERE p."organization_id" = k."organization_id"
  ORDER BY p."id" LIMIT 1
) first_p ON true
WHERE k."slot" = 'product'
ORDER BY k."organization_id", first_p.id, k."content_hash"
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- 7. Remove the migrated product-slot knowledge (Products now own product facts).
DELETE FROM "knowledge" WHERE "slot" = 'product';--> statement-breakpoint
-- 8. Recompute fill scores (fraction of the 6 facets with ≥1 fact).
UPDATE "products" p
SET "fill_score" = sub.score, "updated_at" = (extract(epoch from now())*1000)::bigint
FROM (
  SELECT "product_id", (count(DISTINCT "facet")::real / 6.0) AS score
  FROM "product_facts" GROUP BY "product_id"
) sub
WHERE p."id" = sub."product_id";
