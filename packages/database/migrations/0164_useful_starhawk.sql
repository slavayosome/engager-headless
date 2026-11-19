DROP INDEX "commercial_offer_intents_open_org_unq";--> statement-breakpoint
ALTER TABLE "commercial_offer_intents" ADD COLUMN "effective_at" bigint;--> statement-breakpoint
CREATE UNIQUE INDEX "commercial_offer_intents_open_org_unq" ON "commercial_offer_intents" USING btree ("organization_id") WHERE "commercial_offer_intents"."status" in ('recorded', 'dispatched', 'scheduled');