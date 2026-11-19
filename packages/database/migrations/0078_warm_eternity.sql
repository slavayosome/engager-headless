ALTER TABLE "email_delivery_receipts" DROP CONSTRAINT "email_delivery_receipts_lifecycle_chk";--> statement-breakpoint
DROP TRIGGER IF EXISTS email_delivery_receipt_transition_guard ON "email_delivery_receipts";--> statement-breakpoint
ALTER TABLE "email_delivery_receipts" ADD COLUMN "recipient_user_id" uuid;--> statement-breakpoint
-- A persisted unresolved request without an immutable authorization subject can
-- never be proven safe to replay. Even a reserved row may have reached the
-- provider before its transaction rolled back, so both unresolved shapes fail
-- closed as uncertain without fabricating an attempt or retaining plaintext.
UPDATE "email_delivery_receipts"
SET "state" = 'uncertain',
    "encrypted_provider_payload" = null,
    "provider_message_id" = null,
    "sent_at" = null,
    "last_error" = 'recipient_authorization_binding_missing'
WHERE "recipient_user_id" IS NULL
  AND "state" IN ('reserved', 'sending');--> statement-breakpoint
ALTER TABLE "email_delivery_receipts" ADD CONSTRAINT "email_delivery_receipts_lifecycle_chk" CHECK ((
        "email_delivery_receipts"."state" = 'reserved'
        and "email_delivery_receipts"."attempts" = 0
        and "email_delivery_receipts"."recipient_user_id" is not null
        and "email_delivery_receipts"."encrypted_provider_payload" is not null
        and "email_delivery_receipts"."first_attempt_at" is null
        and "email_delivery_receipts"."last_attempt_at" is null
        and "email_delivery_receipts"."sent_at" is null
        and "email_delivery_receipts"."provider_message_id" is null
      ) or (
        "email_delivery_receipts"."state" = 'sending'
        and "email_delivery_receipts"."attempts" > 0
        and "email_delivery_receipts"."recipient_user_id" is not null
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
        and "email_delivery_receipts"."encrypted_provider_payload" is null
        and "email_delivery_receipts"."sent_at" is null
        and "email_delivery_receipts"."provider_message_id" is null
        and (
          (
            "email_delivery_receipts"."attempts" = 0
            and "email_delivery_receipts"."first_attempt_at" is null
            and "email_delivery_receipts"."last_attempt_at" is null
          ) or (
            "email_delivery_receipts"."attempts" > 0
            and "email_delivery_receipts"."first_attempt_at" is not null
            and "email_delivery_receipts"."last_attempt_at" is not null
          )
        )
      ));--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_email_delivery_receipt_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.job_id IS DISTINCT FROM OLD.job_id
     OR NEW.recipient_user_id IS DISTINCT FROM OLD.recipient_user_id
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
CREATE TRIGGER email_delivery_receipt_transition_guard
BEFORE UPDATE ON "email_delivery_receipts"
FOR EACH ROW EXECUTE FUNCTION enforce_email_delivery_receipt_transition();
