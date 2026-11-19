-- Drafting always runs the dispatcher (US-RET-13), so `draft_dispatcher` is
-- read by nothing. Every row is already true (0293 set the default and filled
-- the rest), so the drop loses no choice anyone made.
--
-- DESTRUCTIVE. A bare drizzle `.select()` names every declared column, so a
-- build from before this change takes 42703 on `organizations` reads once it
-- is applied; the app migrates immediately before it starts the matching
-- build.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "organizations" WHERE "draft_dispatcher" = false) THEN
    RAISE EXCEPTION 'organizations still have draft_dispatcher disabled';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "draft_dispatcher";
