CREATE TABLE "database_finalisation" (
	"id" text PRIMARY KEY NOT NULL,
	"journal_head" bigint NOT NULL,
	"journal_hash" text NOT NULL,
	"finalisation_digest" text NOT NULL,
	"finalised_at" bigint NOT NULL
);
