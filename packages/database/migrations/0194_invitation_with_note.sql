-- AN INVITATION WITH A NOTE (Phase 50). WIDENS journeys_closed_check by one
-- value, `reopened` — the close an owner's explicit reopening writes on the
-- journey it ends — which accepts every row the old constraint did. No table
-- or column is added or removed.
ALTER TABLE "journeys" DROP CONSTRAINT "journeys_closed_check";--> statement-breakpoint
ALTER TABLE "journeys" ADD CONSTRAINT "journeys_closed_check" CHECK (("journeys"."closed_reason" is null and "journeys"."closed_at" is null) or ("journeys"."closed_reason" in ('opt_out', 'manual_exclude', 'reopened') and "journeys"."closed_at" is not null));