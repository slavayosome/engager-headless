-- A CONVERSATION'S HISTORY KEEPS ITS OWN ANCHOR. The inbox now reads
-- LinkedIn's conversation data, and a bound conversation's one new message can
-- be recorded from the list alone: `last_message_id` moves to it, and a DM is
-- written after it. A message the owner sent BEFORE it is shown only by the
-- conversation's history — its page, or LinkedIn's message history for it — so
-- a history read looks for one from where the last history read stopped:
-- `last_history_message_id`, which only a history read moves.
-- Every `last_message_id` before this release was a page read's, so each row
-- starts from it; a row no read has shown stays null, and its first history
-- read looks at every message, as before.
-- Expand-only: one nullable column, filled from a column that does not move;
-- no existing column, constraint or row of any other column changes, and old
-- code never names it.
ALTER TABLE "dm_threads" ADD COLUMN "last_history_message_id" text;--> statement-breakpoint
UPDATE "dm_threads" SET "last_history_message_id" = "last_message_id" WHERE "last_message_id" IS NOT NULL;
