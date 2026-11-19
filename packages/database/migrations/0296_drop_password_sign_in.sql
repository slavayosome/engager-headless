-- Cloud sign-in is an email code or Google, so nothing reads or writes a
-- password, a TOTP secret or recovery codes any more, and the constraint that
-- tied them together goes with them. A user who had only a password keeps the
-- row, the id, the subscription and the licence, and signs in by an email code
-- to the same address; no account row is deleted.
--
-- DESTRUCTIVE. A bare drizzle `.select()` names every declared column, so a
-- build from before this change takes 42703 on `users` reads once it is
-- applied; the cloud deploy workflow migrates immediately before it deploys the
-- matching build. The dropped values are not preserved. Local installs hold no
-- passwords.
ALTER TABLE "users" DROP CONSTRAINT "users_credentials_only_mfa_check";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "password_hash";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "mfa_enabled";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "totp_secret";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "recovery_codes";