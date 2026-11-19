-- The laptop-to-cloud transfer is gone, so the two write fences it installed at
-- every migrate go with it: the transfer fence (a trigger on every tenant table
-- that refused an application write once a source had been handed off) and the
-- execution-protocol fence on messages and rate_limit_ledger (which refused a
-- send prepared by an older executor). Row-level security is untouched; this
-- only removes the per-row trigger cost.
--
-- The triggers are found by name rather than listed: the set was derived from
-- RLS_TABLES at each migrate, so a table that has since been dropped is simply
-- not there to match.
DO $$
DECLARE
  fence record;
BEGIN
  FOR fence IN
    SELECT tgname, tgrelid::regclass AS relation
      FROM pg_catalog.pg_trigger
     WHERE tgname IN ('engager_transfer_write_fence', 'engager_execution_protocol_fence')
       AND NOT tgisinternal
  LOOP
    EXECUTE format('DROP TRIGGER %I ON %s', fence.tgname, fence.relation);
  END LOOP;
END
$$;--> statement-breakpoint
DROP FUNCTION IF EXISTS public.engager_guard_transferred_source();--> statement-breakpoint
DROP FUNCTION IF EXISTS public.engager_source_is_transferred(uuid, uuid);--> statement-breakpoint
DROP FUNCTION IF EXISTS public.engager_any_source_is_transferred(uuid);--> statement-breakpoint
DROP FUNCTION IF EXISTS public.engager_guard_execution_protocol();
