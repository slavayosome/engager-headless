-- The account keeps no mode per action (US-SIM-H06): a step's mode is what
-- happens, and the account default's own `grants` and `max_mode` stop being
-- read (`strategy/resolve.ts`). Expand-then-contract: they stay in the stored
-- documents, unread, and no shape changes here.
--
-- NOTHING WIDENS BY ITSELF. Before this, a step's mode was lowered by the
-- account's: Off for an action the account default did not grant, its
-- `max_mode` where that capped it. `fold_account_modes` writes that lower
-- value onto the step, so every campaign resolves to the effective mode per
-- action it resolved to before:
--   * each binding of a campaign version that is or may come into force
--     (`active`, `draft`, `pending_review`) takes the stricter of its own mode
--     and its account's for that action — Off, then Ask me, then Automatic. A
--     read (On / Off) never had an account mode and is left alone. A version
--     2 document's `modes` take the same fold, so its upgrade on read
--     (`strategy/upgrade.ts`, 2 → 3) folds nothing wider back in;
--   * the owner's replies on their own posts (`organizations.own_post_replies`)
--     take the stricter of their mode and the account's for a public reply;
--   * an account default is read as the upgrader reads it: a version 3
--     default that granted all seven sends also grants Reply in the room.
-- History (`archived`, `cancelled`) stays as it was written: an undo to it is
-- a patch, classified against the version in force, so a wider one waits for
-- the owner's yes (INV-26).
--
-- THE FOLD ACTS ONCE. Folded, every version of the account default grants
-- every send and caps none — what `accountDefaultSeed` writes — so its stale
-- values cannot fold again: an archive taken after this change restores its
-- steps exactly as the owner left them, a raised one included.
--
-- `fold_account_modes` is the whole fold, so a restored archive from before
-- this change runs the same one (`portable-restore.ts`). Run twice, it
-- changes nothing the second time.
CREATE FUNCTION account_mode_cap(account jsonb, mode_key text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE
    WHEN grant_id IS NULL OR jsonb_typeof(account) <> 'object' THEN NULL
    WHEN NOT (coalesce(account->'grants', '[]'::jsonb) ? grant_id
      OR (grant_id = 'grant_room_reply' AND coalesce((account->>'schema_version')::int, 0) < 4
        AND coalesce(account->'grants', '[]'::jsonb) ?& ARRAY['grant_publish_comment', 'grant_public_reply',
          'grant_like', 'grant_invite', 'grant_accept', 'grant_dm', 'grant_followup'])) THEN 'off'
    WHEN account->'max_mode'->>mode_key IN ('off', 'review', 'auto') THEN account->'max_mode'->>mode_key
    ELSE NULL
  END
  FROM (SELECT CASE mode_key
    WHEN 'publish_comment' THEN 'grant_publish_comment' WHEN 'public_reply' THEN 'grant_public_reply'
    WHEN 'room_reply' THEN 'grant_room_reply' WHEN 'like_target' THEN 'grant_like'
    WHEN 'invite' THEN 'grant_invite' WHEN 'accept_invite' THEN 'grant_accept'
    WHEN 'dm' THEN 'grant_dm' WHEN 'followup' THEN 'grant_followup' END AS grant_id) AS g
$fn$;
--> statement-breakpoint
-- The stricter of two send modes, or `mode` itself when `cap` holds none or
-- `mode` is not a send mode.
CREATE FUNCTION stricter_send_mode(mode text, cap text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE
    WHEN cap IS NULL OR mode IS NULL OR mode NOT IN ('off', 'review', 'auto') THEN mode
    WHEN array_position(ARRAY['off', 'review', 'auto'], cap) < array_position(ARRAY['off', 'review', 'auto'], mode) THEN cap
    ELSE mode
  END
$fn$;
--> statement-breakpoint
-- A campaign document with its account's mode for each action folded into
-- the bindings that send it. The capability each binding names is mapped to
-- the key it is granted and capped under (`modeKeyOf`).
CREATE FUNCTION fold_account_modes_doc(doc jsonb, account jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE WHEN jsonb_typeof(doc->'modes') = 'object' THEN jsonb_set(folded, '{modes}', (
      SELECT coalesce(jsonb_object_agg(m.key, CASE WHEN jsonb_typeof(m.value) = 'string'
        THEN to_jsonb(stricter_send_mode(m.value #>> '{}', account_mode_cap(account, m.key))) ELSE m.value END), '{}'::jsonb)
      FROM jsonb_each(doc->'modes') AS m))
    ELSE folded END
  FROM (SELECT CASE WHEN jsonb_typeof(doc->'action_bindings') = 'array' THEN jsonb_set(doc, '{action_bindings}', (
      SELECT coalesce(jsonb_agg(CASE WHEN jsonb_typeof(b->'mode') = 'string'
        THEN jsonb_set(b, '{mode}', to_jsonb(stricter_send_mode(b->>'mode', account_mode_cap(account, CASE b->>'capability_ref'
          WHEN 'publish_comment' THEN 'publish_comment' WHEN 'reply_public' THEN 'public_reply'
          WHEN 'reply_to_comment' THEN 'room_reply' WHEN 'like_target' THEN 'like_target'
          WHEN 'send_invitation' THEN 'invite' WHEN 'accept_invitation' THEN 'accept_invite'
          WHEN 'send_dm' THEN 'dm' WHEN 'followup' THEN 'followup' END))))
        ELSE b END ORDER BY e.ord), '[]'::jsonb)
      FROM jsonb_array_elements(doc->'action_bindings') WITH ORDINALITY AS e(b, ord)))
    ELSE doc END AS folded) AS f
$fn$;
--> statement-breakpoint
CREATE FUNCTION fold_account_modes(p_org uuid DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  versions integer;
  replies integer;
  defaults integer;
BEGIN
  UPDATE campaign_strategies s
    SET document = fold_account_modes_doc(s.document, a.document)
    FROM campaigns c
    JOIN campaign_strategies a ON a.organization_id = c.organization_id AND a.channel_id = c.channel_id
      AND a.status = 'active'
    WHERE s.organization_id = c.organization_id AND s.campaign_id = c.id
      AND s.status IN ('active', 'draft', 'pending_review')
      AND (p_org IS NULL OR s.organization_id = p_org)
      AND s.document IS DISTINCT FROM fold_account_modes_doc(s.document, a.document);
  GET DIAGNOSTICS versions = ROW_COUNT;
  UPDATE organizations o
    SET own_post_replies = jsonb_set(o.own_post_replies, '{mode}',
      to_jsonb(stricter_send_mode(o.own_post_replies->>'mode', account_mode_cap(a.document, 'public_reply'))))
    FROM channels ch
    JOIN campaign_strategies a ON a.organization_id = ch.organization_id AND a.channel_id = ch.id AND a.status = 'active'
    WHERE ch.organization_id = o.id AND ch.network = 'linkedin'
      AND jsonb_typeof(o.own_post_replies) = 'object'
      AND (p_org IS NULL OR o.id = p_org)
      AND o.own_post_replies->>'mode'
        IS DISTINCT FROM stricter_send_mode(o.own_post_replies->>'mode', account_mode_cap(a.document, 'public_reply'));
  GET DIAGNOSTICS replies = ROW_COUNT;
  UPDATE campaign_strategies a
    SET document = (a.document - 'max_mode') || jsonb_build_object('grants', jsonb_build_array('grant_publish_comment',
      'grant_public_reply', 'grant_room_reply', 'grant_like', 'grant_invite', 'grant_accept', 'grant_dm', 'grant_followup'))
    WHERE a.campaign_id IS NULL AND jsonb_typeof(a.document) = 'object'
      AND (p_org IS NULL OR a.organization_id = p_org)
      AND (a.document ? 'max_mode' OR NOT coalesce(a.document->'grants', '[]'::jsonb) ?& ARRAY['grant_publish_comment',
        'grant_public_reply', 'grant_room_reply', 'grant_like', 'grant_invite', 'grant_accept', 'grant_dm', 'grant_followup']);
  GET DIAGNOSTICS defaults = ROW_COUNT;
  RAISE NOTICE 'account modes folded into steps: % strategy version(s), % own-post reply setting(s), % account default version(s) cleared',
    versions, replies, defaults;
END $fn$;
--> statement-breakpoint
SELECT fold_account_modes();
