-- WHAT A SCOUT'S TUNE MOVED. The Scout's plan trims or deepens a search, or
-- changes its sort or window, and recorded nothing of it: the Searches tab
-- could say the owner's tunes ("Set how it reads") but never "Trimmed “MRR”
-- from 6 to 5 pages". Expand-only: one nullable column holding the parts the
-- tune changed, before and after; every older row and every other change
-- leaves it null.
ALTER TABLE "discovery_source_changes" ADD COLUMN "reading" jsonb;
