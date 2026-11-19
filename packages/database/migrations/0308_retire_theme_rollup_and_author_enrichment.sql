-- The audience-theme rollup and the author-impact enrichment are retired
-- (US-RET-02): their two job types have no handler any more, so their rows —
-- queued ones would only be claimed to fail — go with the handlers. `jobs` is
-- outside RLS, so the delete reaches every organization's rows, and it matches
-- nothing on a second pass.
DELETE FROM "jobs" WHERE "type" IN ('rollup_audience_themes', 'enrich_authors');
