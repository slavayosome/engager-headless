ALTER TABLE "channels" ADD COLUMN "session_ok_at" bigint;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "session_checked_at" bigint;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "session_reason" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "risk_acknowledged_at" bigint;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "risk_acknowledged_by_user_id" uuid;--> statement-breakpoint
-- The readers switch to the channel row in THIS landing: `readLinkedInLiveness`
-- and `linkedInConnectionState` stop reading `system_state` and the voice row.
-- Without the backfill below, an install with a working LinkedIn session reads
-- back as an anonymous, never-probed account until its next probe — "no session"
-- against a session that works — and the risk acknowledgement loses its original
-- moment. The dual-writes keep the two homes together from here on; this moves
-- what is already there.
--
-- Unlike 0124's, this backfill is EVIDENCE-BASED: every value below is the very
-- column being moved, read from the row that holds it today, so it can be
-- re-derived at any time from the retired columns until the contract release
-- drops them.
--
-- `channels` is FORCE ROW LEVEL SECURITY with an `app.current_org` policy, so a
-- role without BYPASSRLS updates ZERO rows IN SILENCE — indistinguishable from
-- "there was nothing to move". Same guard, same reason, as 0120 and 0124.
DO $channel_identity_backfill_guard$
BEGIN
  IF current_setting('is_superuser') <> 'on'
     AND NOT EXISTS (
       SELECT 1
       FROM pg_roles r
       WHERE (r.rolsuper OR r.rolbypassrls)
         AND pg_has_role(current_user, r.oid, 'USAGE')
     )
  THEN
    RAISE EXCEPTION
      'this migration must run as the migration owner: role % cannot bypass row level security and would silently move zero identities onto their channel',
      current_user;
  END IF;
END
$channel_identity_backfill_guard$;--> statement-breakpoint
-- Identity, off the voice row. `IS NULL` on the target, so a probe that already
-- stamped the channel (0122 shipped `display_name`, and the liveness dual-write
-- has been filling it since) always wins over the older voice-row copy.
UPDATE "channels"
   SET "display_name" = "profile"."display_name"
  FROM "profile"
 WHERE "profile"."organization_id" = "channels"."organization_id"
   AND "channels"."network" = 'linkedin'
   AND "channels"."display_name" IS NULL
   AND "profile"."display_name" IS NOT NULL;--> statement-breakpoint
-- Session liveness, off the `system_state` singleton. All three columns move
-- together: `checked_at`/`reason` describe the most recent probe and `ok_at` the
-- last successful one, and a partial move would make a failed probe outrank a
-- success that no longer has a timestamp.
UPDATE "channels"
   SET "session_ok_at" = "system_state"."linkedin_session_ok_at",
       "session_checked_at" = "system_state"."linkedin_session_checked_at",
       "session_reason" = "system_state"."linkedin_session_reason"
  FROM "system_state"
 WHERE "system_state"."organization_id" = "channels"."organization_id"
   AND "channels"."network" = 'linkedin'
   AND "channels"."session_checked_at" IS NULL
   AND "channels"."session_ok_at" IS NULL;--> statement-breakpoint
-- The risk acknowledgement, off the `organizations` row. First one wins, so the
-- original moment is what moves — never a later re-arming.
UPDATE "channels"
   SET "risk_acknowledged_at" = "organizations"."linkedin_risk_acknowledged_at",
       "risk_acknowledged_by_user_id" = "organizations"."linkedin_risk_acknowledged_by_user_id"
  FROM "organizations"
 WHERE "organizations"."id" = "channels"."organization_id"
   AND "channels"."network" = 'linkedin'
   AND "channels"."risk_acknowledged_at" IS NULL
   AND "organizations"."linkedin_risk_acknowledged_at" IS NOT NULL;
