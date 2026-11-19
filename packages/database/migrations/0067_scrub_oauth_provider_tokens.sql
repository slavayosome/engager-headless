-- Engager uses Google/Entra OAuth only for authentication and never consumes
-- provider tokens after the callback. Remove legacy reusable material now that
-- provider account callbacks persist only the stable identity tuple.
-- Install the compatibility fence BEFORE the scrub: an old dashboard callback
-- which overlaps this migration either commits first and is scrubbed below, or
-- waits for this trigger and has every reusable field normalized to NULL.
CREATE OR REPLACE FUNCTION "normalize_oauth_provider_tokens"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW."refresh_token" := NULL;
  NEW."access_token" := NULL;
  NEW."expires_at" := NULL;
  NEW."token_type" := NULL;
  NEW."scope" := NULL;
  NEW."id_token" := NULL;
  NEW."session_state" := NULL;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "normalize_oauth_provider_tokens_insert"
BEFORE INSERT ON "accounts"
FOR EACH ROW
EXECUTE FUNCTION "normalize_oauth_provider_tokens"();--> statement-breakpoint
CREATE TRIGGER "normalize_oauth_provider_tokens_update"
BEFORE UPDATE OF
  "refresh_token", "access_token", "expires_at", "token_type", "scope",
  "id_token", "session_state"
ON "accounts"
FOR EACH ROW
EXECUTE FUNCTION "normalize_oauth_provider_tokens"();--> statement-breakpoint
UPDATE "accounts"
SET
  "refresh_token" = NULL,
  "access_token" = NULL,
  "expires_at" = NULL,
  "token_type" = NULL,
  "scope" = NULL,
  "id_token" = NULL,
  "session_state" = NULL
WHERE
  "refresh_token" IS NOT NULL
  OR "access_token" IS NOT NULL
  OR "expires_at" IS NOT NULL
  OR "token_type" IS NOT NULL
  OR "scope" IS NOT NULL
  OR "id_token" IS NOT NULL
  OR "session_state" IS NOT NULL;

-- Local TOTP was previously enrollable for passwordless identities even though
-- the OAuth callback had no factor-challenge step. Clear that ineffective
-- legacy state for every passwordless row (including orphaned legacy users
-- whose account row was already removed) before the next migration installs a
-- total CHECK constraint. Their provider remains the sole authentication
-- authority in this beta.
UPDATE "users"
SET
  "mfa_enabled" = false,
  "totp_secret" = NULL,
  "recovery_codes" = NULL
WHERE
  "password_hash" IS NULL
  AND (
    "mfa_enabled" = true
    OR "totp_secret" IS NOT NULL
    OR "recovery_codes" IS NOT NULL
  );
