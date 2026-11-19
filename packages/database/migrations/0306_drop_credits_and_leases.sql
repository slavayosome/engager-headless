-- Credits are retired: every plan grants zero, so nothing reads or writes a
-- wallet, a ledger row or a reservation, and the monthly drip job that fed
-- them is gone. Wallet balances are dropped with them; no plan granted any.
-- `engagement_leases` goes with the cloud lease routes that were its only
-- reader and writer. Subscriptions, licence seats and trial claims are not
-- touched.
--
-- `jobs` is outside RLS, so the orphaned drip rows are removed directly.
DELETE FROM "jobs" WHERE "type" = 'credit_drip';--> statement-breakpoint
DROP TABLE "credit_reservations" CASCADE;--> statement-breakpoint
DROP TABLE "credit_transactions" CASCADE;--> statement-breakpoint
DROP TABLE "credit_wallets" CASCADE;--> statement-breakpoint
DROP TABLE "engagement_leases" CASCADE;
