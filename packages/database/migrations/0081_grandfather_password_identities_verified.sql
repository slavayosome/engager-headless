-- ENGAGER_SIGNUP_EMAIL_VERIFICATION shipped default OFF: password signups no
-- longer prove mailbox ownership before first sign-in. Grandfather every
-- existing password-backed identity that was created while verification was
-- mandatory and never completed it, so the still-live enforcement gates
-- (authorize, JWT resolution, checkout owner eligibility — all requiring
-- email_verified) stop locking those accounts out. Idempotent and expand-only:
-- reruns match zero rows; turning the flag ON later deliberately leaves these
-- rows verified.
UPDATE "users"
SET "email_verified" = now()
WHERE "password_hash" IS NOT NULL
  AND "email_verified" IS NULL;
