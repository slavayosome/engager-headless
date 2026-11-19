-- REPLY CHECKS GET THEIR OWN DAILY READ BUDGET. One defaulted column on
-- `channels`, beside the research-read budgets it is split from:
-- `daily_reply_check_cap` (20-300 a rolling day, default 80), what a look
-- under one of our own comments for replies spends, as a `reply_check` ledger
-- row. Research keeps `daily_thread_read_cap` to itself, so a day on which
-- verifying matches spends every post read no longer leaves replies unseen.
-- Expand-only: no existing column, constraint or row moves, and every account
-- reads the default at once.
ALTER TABLE "channels" ADD COLUMN "daily_reply_check_cap" bigint DEFAULT 80 NOT NULL;
