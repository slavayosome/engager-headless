ALTER TABLE "leads" ADD COLUMN "contacted_at" bigint;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "first_send" jsonb;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "relationship_at" bigint;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_first_send_check" CHECK (("leads"."contacted_at" is null) = ("leads"."first_send" is null));