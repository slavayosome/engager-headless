-- A TEST BEFORE START IS A RUN OF ITS OWN KIND. A campaign not started yet
-- can run its Scout once to see what its searches find and what its audience
-- matches (`runCampaignTestOp`): a find and a triage, nothing drafted, liked
-- or sent, and nothing armed. The run row says it was one, so Runs marks it
-- "Test" and Overview's Last run reads what it found.
-- Expand-only: one column defaulting to false, which every existing run was;
-- old code never names it.
ALTER TABLE "automation_runs" ADD COLUMN "is_test" boolean DEFAULT false NOT NULL;
