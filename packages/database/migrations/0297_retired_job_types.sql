-- The server drafting chain is retired (US-RET-21): its four job types have
-- no handler any more, so their rows — queued ones would only be claimed to
-- fail — go with the handlers. `jobs` is outside RLS, so the delete reaches
-- every organization's rows, and it matches nothing on a second pass.
DELETE FROM "jobs" WHERE "type" IN ('discover_posts', 'process_post', 'select_drafts', 'triage_candidates');
