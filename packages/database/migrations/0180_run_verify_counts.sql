ALTER TABLE "automation_runs" ADD COLUMN "verified_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "verify_rejected_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "verify_cap_refused_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "rounds_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_verify_counts_check" CHECK ("automation_runs"."verified_count" >= 0 and "automation_runs"."verify_rejected_count" >= 0 and "automation_runs"."verify_cap_refused_count" >= 0 and "automation_runs"."rounds_count" >= 0);