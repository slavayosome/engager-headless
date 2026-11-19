ALTER TABLE "leads" ADD COLUMN "profile_read" jsonb;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "profile_read_at" bigint;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_profile_read_check" CHECK (("leads"."profile_read" is null) = ("leads"."profile_read_at" is null));