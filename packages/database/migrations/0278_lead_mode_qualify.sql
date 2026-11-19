ALTER TABLE "leads" ADD COLUMN "qualification" jsonb;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "angles" jsonb;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_angles_check" CHECK ("leads"."angles" is null or (jsonb_typeof("leads"."angles") = 'array' and jsonb_array_length("leads"."angles") <= 3));