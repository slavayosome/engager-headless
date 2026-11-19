-- A campaign keeps no mode of its own either: its `max_mode` stops being read
-- (`strategy/resolve.ts`) and no patch may write one (`strategy/patch.ts`).
-- Its `grants` are untouched: they are still read. Expand-then-contract: the
-- contract still accepts the field, and no shape changes here.
--
-- NOTHING WIDENS BY ITSELF. Before this, a step's mode was lowered to its
-- campaign's `max_mode` where that capped it. Each version of a campaign that
-- is or may come into force (`active`, `draft`, `pending_review`) takes the
-- stricter of each binding's mode and its campaign's cap for that action —
-- Off, then Ask me, then Automatic — through 0338's `fold_account_modes_doc`,
-- handed the campaign's own cap and every grant, so the cap is all it folds.
-- A version 2 document's `modes` take the same fold. A read (On / Off) never
-- had a cap and is left alone. History (`archived`, `cancelled`) stays as it
-- was written: an undo takes no cap back (`patch.ts`), and what its steps say
-- is classified against the version in force, so a wider one waits for the
-- owner's yes (INV-26).
--
-- THE FOLD ACTS ONCE. The cap leaves each document it folded into, so a
-- second run finds nothing to fold, and a step raised since stays raised.
-- `fold_campaign_max_mode` is the whole fold, so a restored archive from
-- before this change runs the same one (`portable-restore.ts`).
CREATE FUNCTION fold_campaign_max_mode(p_org uuid DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  versions integer;
BEGIN
  UPDATE campaign_strategies s
    SET document = fold_account_modes_doc(s.document, jsonb_build_object('max_mode', s.document->'max_mode',
      'grants', jsonb_build_array('grant_publish_comment', 'grant_public_reply', 'grant_room_reply', 'grant_like',
        'grant_invite', 'grant_accept', 'grant_dm', 'grant_followup'))) - 'max_mode'
    WHERE s.campaign_id IS NOT NULL AND jsonb_typeof(s.document) = 'object' AND s.document ? 'max_mode'
      AND s.status IN ('active', 'draft', 'pending_review')
      AND (p_org IS NULL OR s.organization_id = p_org);
  GET DIAGNOSTICS versions = ROW_COUNT;
  RAISE NOTICE 'campaign max_mode folded into steps: % strategy version(s)', versions;
END $fn$;
--> statement-breakpoint
SELECT fold_campaign_max_mode();
