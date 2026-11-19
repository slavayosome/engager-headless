-- TERMS ACCEPTANCE ON THE ACCOUNT (US-ONB-01). The cloud refuses to create
-- an account until the Terms box is ticked and records when, under which
-- version. Expand-only: both columns nullable, every existing row null.
-- Local installs never read them (MIG-8).
ALTER TABLE "users" ADD COLUMN "terms_accepted_at" bigint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "terms_version" text;