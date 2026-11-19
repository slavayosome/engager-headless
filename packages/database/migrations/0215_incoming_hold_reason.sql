-- A HELD REPLY SAYS WHY IT IS HELD. Intake holds a reply for the owner
-- (`incoming_comments.sensitivity = 'hold'`) for three reasons the Inbox tells
-- apart: it was backlog when first seen, it came in where nothing reads it
-- yet (a campaign whose replies are kept held, a notification card no thread
-- read confirmed), or the sensitivity check judged it — and only the last is
-- a reply Engager read and left to the owner. `hold_reason` records which,
-- written with `sensitivity` wherever intake sets it.
-- Expand-only: one nullable text column no old code names; existing rows keep
-- null, which reads as held from intake.
ALTER TABLE "incoming_comments" ADD COLUMN "hold_reason" text;
