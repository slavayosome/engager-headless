ALTER TABLE "hosted_ai_spend_ledger" DROP CONSTRAINT "hosted_ai_spend_ledger_reservation_fk";
--> statement-breakpoint
DROP INDEX "hosted_ai_spend_reservations_org_id_unq";--> statement-breakpoint
CREATE UNIQUE INDEX "hosted_ai_spend_reservations_org_period_id_unq" ON "hosted_ai_spend_reservations" USING btree ("organization_id","period_start","id");--> statement-breakpoint
ALTER TABLE "hosted_ai_spend_ledger" ADD CONSTRAINT "hosted_ai_spend_ledger_reservation_fk" FOREIGN KEY ("organization_id","period_start","reservation_id") REFERENCES "public"."hosted_ai_spend_reservations"("organization_id","period_start","id") ON DELETE cascade ON UPDATE no action;
