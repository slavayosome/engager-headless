-- THE REPORT RELAY'S RECORD. One new table, `report_relays`, written only by
-- the cloud's `/api/reports`: a relayed problem report's id (the install's
-- idempotency key), the install that sent it, when it arrived, and the
-- provider's message id once it went — never the report's content. Global and
-- outside RLS, like the licence refresh and lease tables: the sender may hold
-- no credential at all.
-- Expand-only: no existing table, column, constraint or row moves, and old
-- code never names it.
CREATE TABLE "report_relays" (
	"id" uuid PRIMARY KEY NOT NULL,
	"install_id" text NOT NULL,
	"received_at" bigint NOT NULL,
	"message_id" text
);
