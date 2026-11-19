ALTER TABLE "email_delivery_receipts" ADD COLUMN "encrypted_provider_payload" text;--> statement-breakpoint
-- This table is new in the same release, but a rehearsal/dev database may
-- already contain unresolved rows created by 0066. Their exact provider request
-- was never persisted, so retrying them would be unsafe: close them as uncertain
-- before the lifecycle constraint becomes authoritative.
UPDATE "email_delivery_receipts"
SET "state" = 'uncertain',
    "attempts" = greatest("attempts", 1),
    "first_attempt_at" = coalesce("first_attempt_at", "created_at"),
    "last_attempt_at" = coalesce("last_attempt_at", "updated_at"),
    "provider_message_id" = null,
    "sent_at" = null,
    "last_error" = 'legacy unresolved receipt had no frozen provider payload'
WHERE "state" IN ('reserved', 'sending', 'uncertain');--> statement-breakpoint
ALTER TABLE "email_delivery_receipts" ADD CONSTRAINT "email_delivery_receipts_delivery_key_chk" CHECK (length("email_delivery_receipts"."delivery_key") between 1 and 240);--> statement-breakpoint
ALTER TABLE "email_delivery_receipts" ADD CONSTRAINT "email_delivery_receipts_payload_hash_chk" CHECK ("email_delivery_receipts"."payload_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "email_delivery_receipts" ADD CONSTRAINT "email_delivery_receipts_lifecycle_chk" CHECK ((
        "email_delivery_receipts"."state" = 'reserved'
        and "email_delivery_receipts"."attempts" = 0
        and "email_delivery_receipts"."encrypted_provider_payload" is not null
        and "email_delivery_receipts"."first_attempt_at" is null
        and "email_delivery_receipts"."last_attempt_at" is null
        and "email_delivery_receipts"."sent_at" is null
        and "email_delivery_receipts"."provider_message_id" is null
      ) or (
        "email_delivery_receipts"."state" = 'sending'
        and "email_delivery_receipts"."attempts" > 0
        and "email_delivery_receipts"."encrypted_provider_payload" is not null
        and "email_delivery_receipts"."first_attempt_at" is not null
        and "email_delivery_receipts"."last_attempt_at" is not null
        and "email_delivery_receipts"."sent_at" is null
        and "email_delivery_receipts"."provider_message_id" is null
      ) or (
        "email_delivery_receipts"."state" = 'sent'
        and "email_delivery_receipts"."attempts" > 0
        and "email_delivery_receipts"."encrypted_provider_payload" is null
        and "email_delivery_receipts"."first_attempt_at" is not null
        and "email_delivery_receipts"."last_attempt_at" is not null
        and "email_delivery_receipts"."sent_at" is not null
      ) or (
        "email_delivery_receipts"."state" = 'uncertain'
        and "email_delivery_receipts"."attempts" > 0
        and "email_delivery_receipts"."encrypted_provider_payload" is null
        and "email_delivery_receipts"."first_attempt_at" is not null
        and "email_delivery_receipts"."last_attempt_at" is not null
        and "email_delivery_receipts"."sent_at" is null
        and "email_delivery_receipts"."provider_message_id" is null
      ));--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_email_delivery_receipt_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.job_id IS DISTINCT FROM OLD.job_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.delivery_key IS DISTINCT FROM OLD.delivery_key
     OR NEW.provider_idempotency_key IS DISTINCT FROM OLD.provider_idempotency_key
     OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'email delivery receipt identity is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.state IN ('sent', 'uncertain') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'final email delivery receipt is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NOT (
    (OLD.state = 'reserved' AND NEW.state IN ('reserved', 'sending', 'uncertain'))
    OR (OLD.state = 'sending' AND NEW.state IN ('sending', 'sent', 'uncertain'))
    OR (OLD.state = NEW.state AND OLD.state IN ('sent', 'uncertain'))
  ) THEN
    RAISE EXCEPTION 'invalid email delivery receipt state transition: % -> %', OLD.state, NEW.state
      USING ERRCODE = '23514';
  END IF;

  IF NEW.attempts < OLD.attempts
     OR (OLD.first_attempt_at IS NOT NULL AND NEW.first_attempt_at IS DISTINCT FROM OLD.first_attempt_at)
     OR (OLD.last_attempt_at IS NOT NULL AND NEW.last_attempt_at < OLD.last_attempt_at)
     OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'email delivery receipt counters and clocks are monotonic'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.state IN ('reserved', 'sending')
     AND NEW.encrypted_provider_payload IS DISTINCT FROM OLD.encrypted_provider_payload THEN
    RAISE EXCEPTION 'frozen email provider payload is immutable while unresolved'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS email_delivery_receipt_transition_guard ON "email_delivery_receipts";--> statement-breakpoint
CREATE TRIGGER email_delivery_receipt_transition_guard
BEFORE UPDATE ON "email_delivery_receipts"
FOR EACH ROW EXECUTE FUNCTION enforce_email_delivery_receipt_transition();
