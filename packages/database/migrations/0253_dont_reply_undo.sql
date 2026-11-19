-- WHAT A DON'T REPLY TOOK, SO UNDO CAN GIVE IT BACK. Five nullable columns
-- on `incoming_comments`, written in the transaction that dismisses a reply:
-- `dismissed_at`, `dismissed_from` (the status it left), `dismissed_reply_id`
-- and `dismissed_reply_version` (the reply draft of ours it withdrew, and the
-- request version it left that draft at) and `dismissed_by` (`owner` or
-- `agent`). Undo puts the status back and, while that draft is still rejected
-- at that version, the draft.
-- Expand-only: no existing column, constraint or row moves. A reply dismissed
-- before this reads null, which no Undo takes back.
ALTER TABLE "incoming_comments" ADD COLUMN "dismissed_at" bigint;--> statement-breakpoint
ALTER TABLE "incoming_comments" ADD COLUMN "dismissed_from" text;--> statement-breakpoint
ALTER TABLE "incoming_comments" ADD COLUMN "dismissed_reply_id" bigint;--> statement-breakpoint
ALTER TABLE "incoming_comments" ADD COLUMN "dismissed_reply_version" integer;--> statement-breakpoint
ALTER TABLE "incoming_comments" ADD COLUMN "dismissed_by" text;
