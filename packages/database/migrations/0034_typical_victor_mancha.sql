CREATE TABLE "pacing_state" (
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"kind" text NOT NULL,
	"next_run_at" bigint DEFAULT 0 NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "pacing_state_organization_id_kind_pk" PRIMARY KEY("organization_id","kind")
);
--> statement-breakpoint
ALTER TABLE "pacing_state" ADD CONSTRAINT "pacing_state_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;