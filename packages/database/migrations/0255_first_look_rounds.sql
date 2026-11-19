-- A QUICK CAMPAIGN'S FIRST LOOK, ON ITS RUN ROWS. Two columns on
-- `automation_runs`: `first_look_round`, the round of the first look a run was
-- (null on every other run), and `first_look_post_ids`, the posts its
-- first-look step put a draft in. The first look keeps no table of its own:
-- its rounds, its matches and its drafts are read off these rows
-- (`workers/firstLook.ts`), and a run page reads its round from its own.
-- Expand-only: no existing column, constraint or row moves. Every existing run
-- reads null and an empty list, which is what it was.
ALTER TABLE "automation_runs" ADD COLUMN "first_look_round" integer;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "first_look_post_ids" bigint[] DEFAULT '{}'::bigint[] NOT NULL;
