-- The Unipile connector is gone: a channel is reached through the owner's own
-- browser, so `channels.connector` narrows to `local_browser` and the hosted-auth
-- intent table has no writer. The outcome poller that only ever refused on a
-- real connector goes with it, and its queued rows (one per org every five
-- minutes) with it.
--
-- The guard fails closed: a channel still bound to `unipile` has a connector
-- the product can no longer reach, so the migration refuses rather than strand
-- it. Each org is entered in turn because `channels` is under forced RLS. None
-- exists on the owner's install.
DO $$
DECLARE
  org uuid;
  held integer;
BEGIN
  FOR org IN SELECT id FROM organizations LOOP
    PERFORM set_config('app.current_org', org::text, true);
    SELECT count(*) INTO held FROM channels WHERE connector = 'unipile';
    IF held > 0 THEN
      RAISE EXCEPTION 'organization % still has a unipile channel', org;
    END IF;
  END LOOP;
  PERFORM set_config('app.current_org', '', true);
END
$$;--> statement-breakpoint
DELETE FROM "jobs" WHERE "type" = 'poll_outcomes';--> statement-breakpoint
DROP TABLE "unipile_connection_intents" CASCADE;
