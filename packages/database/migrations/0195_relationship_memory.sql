CREATE TABLE "memory_records" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"channel_id" bigint NOT NULL,
	"slot" text NOT NULL,
	"scope" text NOT NULL,
	"scope_ref" text,
	"key" text NOT NULL,
	"value" text,
	"source_ref" text NOT NULL,
	"author_type" text NOT NULL,
	"observed_at" bigint NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"retention_class" text DEFAULT 'content' NOT NULL,
	"supersedes_id" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "memory_records_org_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "memory_records_identity_version_key" UNIQUE NULLS NOT DISTINCT("organization_id","channel_id","slot","scope","scope_ref","key","version"),
	CONSTRAINT "memory_records_slot_check" CHECK ("memory_records"."slot" in ('relationship_memory')),
	CONSTRAINT "memory_records_scope_check" CHECK ("memory_records"."scope" in ('account', 'campaign', 'step', 'person') and (("memory_records"."scope" = 'account') = ("memory_records"."scope_ref" is null))),
	CONSTRAINT "memory_records_author_check" CHECK ("memory_records"."author_type" in ('owner', 'observed', 'inferred')),
	CONSTRAINT "memory_records_retention_check" CHECK ("memory_records"."retention_class" in ('content', 'no_retention') and (("memory_records"."retention_class" = 'content') = ("memory_records"."value" is not null))),
	CONSTRAINT "memory_records_version_check" CHECK ("memory_records"."version" >= 1 and (("memory_records"."version" = 1) = ("memory_records"."supersedes_id" is null)))
);
--> statement-breakpoint
ALTER TABLE "step_runs" ADD COLUMN "memory_refs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "step_runs" ADD COLUMN "redacted_at" bigint;--> statement-breakpoint
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_records_org_channel_fk" FOREIGN KEY ("organization_id","channel_id") REFERENCES "public"."channels"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_records_org_scope_idx" ON "memory_records" USING btree ("organization_id","channel_id","scope","scope_ref");--> statement-breakpoint
ALTER TABLE "memory_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memory_records" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "memory_records"
	USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);
