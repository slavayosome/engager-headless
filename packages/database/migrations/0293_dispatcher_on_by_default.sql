ALTER TABLE "organizations" ALTER COLUMN "draft_dispatcher" SET DEFAULT true;--> statement-breakpoint
-- Every existing `false` is 0267's default, never an owner's choice: nothing
-- in the product has ever set this column. `organizations` is outside RLS, so
-- the owner's UPDATE reaches every row, and the predicate matches nothing on a
-- second pass.
UPDATE "organizations" SET "draft_dispatcher" = true WHERE "draft_dispatcher" = false;
