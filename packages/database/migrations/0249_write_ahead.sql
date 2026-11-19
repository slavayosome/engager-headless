-- HOW FAR AHEAD AN AUTOMATIC COMMENT STEP WRITES. One defaulted column on
-- `channels`, beside the pacing numbers it joins: `write_ahead` is
-- `next_few` (the plan's next few slots) or `rest_of_day` (every slot the
-- account's current day still holds). Drafting only — posting stays paced by
-- the day plan's slots, caps and gaps either way.
-- Expand-only: no existing column, constraint or row moves. Every account,
-- existing ones included, reads `rest_of_day`, the owner's default.
ALTER TABLE "channels" ADD COLUMN "write_ahead" text DEFAULT 'rest_of_day' NOT NULL;
