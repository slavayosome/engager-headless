-- THE MOVE EACH ANGLE MAKES, BESIDE ITS WORDS. A delivered angle can name its
-- move (agree +, push back, your story, a question) for the owner's Angles
-- rows. `angles` stays the bare words every release before this one reads and
-- measures a saved comment against; the moves live here, keyed by those words.
-- Expand-only: a jsonb array defaulting to empty, which old code never names.
ALTER TABLE "candidate_draft_requests" ADD COLUMN "angle_items" jsonb DEFAULT '[]'::jsonb NOT NULL;
