DROP INDEX "credit_transactions_grant_key_unq";--> statement-breakpoint
CREATE UNIQUE INDEX "credit_transactions_grant_key_unq" ON "credit_transactions" USING btree ("organization_id","grant_key");