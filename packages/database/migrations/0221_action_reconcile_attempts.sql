-- A SEND NOBODY CAN VOUCH FOR IS READ BEFORE THE OWNER IS ASKED. While a DM's
-- outcome is open, the drain looks at the conversation for it; each look that
-- cannot tell is counted on the row, with when it looked, and the owner is
-- asked only once the looks give up (`RECONCILE_ASK_OWNER_AFTER`). A new
-- attempt starts the count again.
-- Expand-only: an integer defaulting to zero, which no read has made yet on
-- any existing row, and one nullable bigint; old code never names either.
ALTER TABLE "action_executions" ADD COLUMN "reconcile_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "action_executions" ADD COLUMN "last_reconcile_at" bigint;
