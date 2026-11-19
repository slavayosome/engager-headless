ALTER TABLE "mcp_app_card_sessions" ADD COLUMN "adopted_card_id" uuid;--> statement-breakpoint
ALTER TABLE "mcp_app_card_sessions" ADD COLUMN "adopted_claim_seq" bigint;--> statement-breakpoint
-- Under the old claim-at-render semantics, adopted_at != null meant the row's
-- card_id/claim_seq holder had mounted. Carry those holders into the new
-- adopted columns so live decks survive the deploy; unadopted grants stay
-- null and are inert, which is the point of the change.
UPDATE "mcp_app_card_sessions"
SET "adopted_card_id" = "card_id",
    "adopted_claim_seq" = "claim_seq"
WHERE "adopted_at" IS NOT NULL;