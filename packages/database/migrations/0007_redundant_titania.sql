CREATE TABLE "ai_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"operation" text NOT NULL,
	"stage" text,
	"source" text,
	"job_id" bigint,
	"campaign_id" bigint,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_creation_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd_micros" bigint,
	"latency_ms" integer,
	"ok" boolean DEFAULT true NOT NULL,
	"error_kind" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_org_created_idx" ON "ai_usage" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_usage_model_created_idx" ON "ai_usage" USING btree ("model","created_at");--> statement-breakpoint
CREATE INDEX "ai_usage_job_idx" ON "ai_usage" USING btree ("job_id");