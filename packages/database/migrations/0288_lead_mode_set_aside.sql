-- Why a lead is set aside, beside when: the owner's own press, which their
-- next words undo, or their rating Not a fit or A peer, which nothing undoes
-- but the owner.
--
-- Until now only the rating Not a fit set a lead aside, so a row set aside
-- before this shipped is given that reason when its rating says so, and the
-- owner's otherwise. Expand-only: one nullable column no old code names; the
-- fill moves only that column and matches nothing on a second pass or a fresh
-- database, and it runs before the check that needs it.
ALTER TABLE "leads" ADD COLUMN "set_aside_reason" text;--> statement-breakpoint
UPDATE "leads"
   SET "set_aside_reason" = CASE WHEN "rating" = 'not_a_fit' THEN 'not_a_fit' ELSE 'owner' END
 WHERE "set_aside_at" IS NOT NULL
   AND "set_aside_reason" IS NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_set_aside_check" CHECK (("leads"."set_aside_reason" is null or "leads"."set_aside_reason" in ('owner', 'not_a_fit', 'a_peer'))
        and ("leads"."set_aside_reason" is null) = ("leads"."set_aside_at" is null));
