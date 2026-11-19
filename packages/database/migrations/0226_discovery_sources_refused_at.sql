-- WHEN A SEARCH WAS FIRST REFUSED AS TOO LARGE. One nullable column on
-- `discovery_sources`: the start of the run in which LinkedIn first refused the
-- search (413), which the second refusal measures its distance and its
-- corroboration from before it parks the search. Null on every existing row,
-- and read only while `cursor_reason` is 'refused'.
-- Expand-only: one new nullable column; old code never names it.
ALTER TABLE "discovery_sources" ADD COLUMN "refused_at" bigint;
