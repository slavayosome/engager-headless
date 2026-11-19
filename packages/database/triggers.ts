import { sql } from "drizzle-orm";
import { db } from "./client";

/**
 * A message sends as an `actions` row, so no job projects it: the
 * message is the record of its words and its state, and the action is what
 * sends. A message leaving `approved` for a draft or a withdrawal cancels its
 * queued action and the yes given to it, in the same transaction as the move
 * that took it back (`actions/messageSend.ts`); a later yes queues a fresh one.
 * A message that is posting, posted or held for review leaves its action alone:
 * the gate and the owner's resolution settle those.
 *
 * Runs with INVOKER rights: every messages write happens inside `withOrg` as
 * engager_app. org id is stamped from NEW explicitly (never the GUC).
 */
const WITHDRAW_FN = `
CREATE OR REPLACE FUNCTION engager_withdraw_message_send() RETURNS trigger AS $fn$
DECLARE
  now_ms  bigint := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
BEGIN
  IF NEW.status IN ('proposed','rejected','failed','suppressed_dryrun') THEN
    UPDATE actions
       SET status = 'cancelled', status_reason = 'message_' || NEW.status, settled_at = now_ms, updated_at = now_ms
     WHERE organization_id = NEW.organization_id AND message_id = NEW.id AND kind = NEW.kind
       AND status IN ('awaiting_review','approved','reserved');
    UPDATE action_approvals approval
       SET invalidated_at = now_ms, invalidated_reason = 'message_' || NEW.status
      FROM actions action
     WHERE approval.action_execution_id = action.id AND action.organization_id = NEW.organization_id
       AND action.message_id = NEW.id AND action.kind = NEW.kind AND action.status = 'cancelled'
       AND approval.used_at IS NULL AND approval.invalidated_at IS NULL;
  END IF;
  RETURN NULL;
END;
$fn$ LANGUAGE plpgsql
`;

const WITHDRAW_TRIGGERS = [
  `
CREATE TRIGGER messages_withdraw_send_upd
AFTER UPDATE OF status ON messages
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION engager_withdraw_message_send()
`,
];

/** Record every message state transition at the database boundary. The CHANNEL's
 * timezone is snapshotted into local_day; malformed or absent zones fail safe
 * to UTC instead of aborting the message write.
 *
 * The zone is resolved by following the campaign to its channel
 * (`campaigns.channel_id`), not by reading `campaigns.active_hours` — the window
 * is the ACCOUNT'S (INV-4) and `active_hours` moves to `channels`. Reading the
 * campaign column through that move would stamp a timezone nobody maintains
 * during the expand window and degrade to the 'UTC' fallback once the contract
 * release drops it. `message_status_events` is granted SELECT/INSERT only and
 * has no UPDATE policy, so a wrongly-stamped `local_day` is PERMANENTLY
 * unrecomputable and nothing would ever raise: that silence is the failure mode
 * this join exists to avoid.
 *
 * The join is INNER on purpose. A campaign with no channel, a channel that RLS
 * hides, or an empty zone all leave `event_tz` null and take the same 'UTC'
 * fallback the malformed-zone handler does — a message write is never aborted
 * by timezone data. That is no new exposure: the campaign lookup this replaces
 * was already an RLS-visible read on `campaigns`.
 *
 * `reason` is the one fact the move alone cannot carry: a writer that must be
 * told apart from another of the same shape names itself in the
 * transaction-local `app.message_status_reason` around its own update (the
 * owner's Unschedule, `operations/messages.ts`). Unset — every other writer —
 * it is null, and a value outside the column's check aborts the write rather
 * than recording a reason nobody reads. */
const MESSAGE_STATUS_EVENT_FN = `
CREATE OR REPLACE FUNCTION engager_record_message_status_event() RETURNS trigger AS $fn$
DECLARE
  event_at bigint;
  event_tz text;
  event_day text;
BEGIN
  event_at := CASE
    WHEN TG_OP = 'INSERT' THEN NEW.created_at
    ELSE (extract(epoch FROM clock_timestamp()) * 1000)::bigint
  END;

  SELECT COALESCE(NULLIF(channel.active_hours->>'tz', ''), 'UTC')
    INTO event_tz
    FROM campaigns campaign
    JOIN channels channel
      ON channel.id = campaign.channel_id
     AND channel.organization_id = campaign.organization_id
   WHERE campaign.id = NEW.campaign_id
     AND campaign.organization_id = NEW.organization_id
   LIMIT 1;
  event_tz := COALESCE(event_tz, 'UTC');

  BEGIN
    event_day := to_char(
      to_timestamp(event_at / 1000.0) AT TIME ZONE event_tz,
      'YYYY-MM-DD'
    );
  EXCEPTION WHEN invalid_parameter_value THEN
    event_day := to_char(
      to_timestamp(event_at / 1000.0) AT TIME ZONE 'UTC',
      'YYYY-MM-DD'
    );
  END;

  INSERT INTO message_status_events (
    organization_id, message_id, campaign_id, from_status, to_status,
    local_day, occurred_at, reason
  ) VALUES (
    NEW.organization_id,
    NEW.id,
    NEW.campaign_id,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END,
    NEW.status,
    event_day,
    event_at,
    NULLIF(current_setting('app.message_status_reason', true), '')
  );
  RETURN NULL;
END;
$fn$ LANGUAGE plpgsql
`;

const MESSAGE_STATUS_EVENT_TRIGGERS = [
  `
CREATE TRIGGER messages_status_event_ins
AFTER INSERT ON messages
FOR EACH ROW
EXECUTE FUNCTION engager_record_message_status_event()
`,
  `
CREATE TRIGGER messages_status_event_upd
AFTER UPDATE OF status ON messages
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION engager_record_message_status_event()
`,
];

/**
 * applyGrants() intentionally grants ordinary tables broadly before sensitive
 * exceptions are narrowed. Derive the runtime grantees from messages so this
 * remains role-name agnostic and repair the append-only table after every run.
 */
const MESSAGE_STATUS_EVENT_ACL = `
DO $message_status_event_acl$
DECLARE
  grantee_name text;
BEGIN
  FOR grantee_name IN
    SELECT DISTINCT grantee
      FROM information_schema.table_privileges
     WHERE table_schema = current_schema()
       AND table_name = 'messages'
       AND privilege_type = 'INSERT'
       AND grantee NOT IN (current_user, 'PUBLIC')
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM %I',
      current_schema(), 'message_status_events', grantee_name
    );
    EXECUTE format(
      'GRANT SELECT, INSERT ON TABLE %I.%I TO %I',
      current_schema(), 'message_status_events', grantee_name
    );
    EXECUTE format(
      'GRANT USAGE ON SEQUENCE %I.%I TO %I',
      current_schema(), 'message_status_events_id_seq', grantee_name
    );
  END LOOP;
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM PUBLIC',
    current_schema(), 'message_status_events'
  );
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON SEQUENCE %I.%I FROM PUBLIC',
    current_schema(), 'message_status_events_id_seq'
  );
END
$message_status_event_acl$
`;

/** Snapshot the effective draft body after insertion and every actual body edit.
 * Consuming an active redraft also records provenance when the replacement text
 * is identical. Request creation and status-only updates do not append history.
 *
 * A body change is a human edit unless its writer names itself, the way the
 * owner's Unschedule does for the status trigger: the owner putting another
 * draft of a judged set in the box (`useDraftVariant`) sets the
 * transaction-local `app.message_draft_source` to `variant_swap` around its own
 * update, so the words it brings read as Engager's, chosen, not as typed. */
const MESSAGE_DRAFT_REVISION_FN = `
CREATE OR REPLACE FUNCTION engager_record_message_draft_revision() RETURNS trigger AS $fn$
DECLARE
  next_revision integer;
  revision_source text;
  revision_request_id uuid;
  revision_request_version integer;
  revision_requested_at bigint;
  revision_requested_by text;
  revision_request_note text;
  room_completed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO message_draft_revisions (
      organization_id, message_id, revision, source, draft_text,
      model, loop_version, prompt_version_id, trace, created_at
    ) VALUES (
      NEW.organization_id, NEW.id, 1, 'initial',
      coalesce(NEW.final_text, NEW.proposed_text), NEW.model,
      NEW.loop_version, NEW.prompt_version_id, NEW.trace, NEW.created_at
    );
    RETURN NULL;
  END IF;

  room_completed := NEW.kind = 'room_reply' AND OLD.redraft_request_id IS NOT NULL
    AND NEW.redraft_request_id IS NULL AND NEW.status = 'proposed'
    AND NEW.redraft_request_version = OLD.redraft_request_version AND NEW.error IS NULL;

  IF coalesce(OLD.final_text, OLD.proposed_text) IS NOT DISTINCT FROM
     coalesce(NEW.final_text, NEW.proposed_text)
     AND NOT (OLD.redraft_request_id IS NOT NULL
              AND NEW.redraft_request_id IS NULL
              AND NEW.status <> 'rejected'
              AND (NEW.kind <> 'room_reply' OR room_completed)) THEN
    RETURN NULL;
  END IF;

  SELECT coalesce(max(revision), 0) + 1
    INTO next_revision
    FROM message_draft_revisions
   WHERE organization_id = NEW.organization_id
     AND message_id = NEW.id;

  IF NULLIF(current_setting('app.message_draft_source', true), '') = 'variant_swap' THEN
    revision_source := 'variant_swap';
  ELSIF room_completed THEN
    revision_source := 'redraft';
  ELSIF NEW.final_text IS DISTINCT FROM OLD.final_text THEN
    revision_source := 'human_edit';
  ELSIF OLD.redraft_request_id IS NOT NULL
        AND NEW.redraft_request_id IS NULL
        AND NEW.status <> 'rejected' THEN
    revision_source := 'redraft';
  ELSE
    revision_source := 'human_edit';
  END IF;
  IF revision_source = 'redraft' THEN
    revision_request_id := OLD.redraft_request_id;
    revision_request_version := OLD.redraft_request_version;
    revision_requested_at := OLD.redraft_requested_at;
    revision_requested_by := OLD.redraft_requested_by;
    revision_request_note := OLD.redraft_request_note;
  END IF;

  INSERT INTO message_draft_revisions (
    organization_id, message_id, revision, source, draft_text,
    request_id, request_version, requested_at, requested_by, request_note,
    model, loop_version, prompt_version_id, trace, created_at
  ) VALUES (
    NEW.organization_id, NEW.id, next_revision, revision_source,
    coalesce(NEW.final_text, NEW.proposed_text),
    revision_request_id, revision_request_version, revision_requested_at,
    revision_requested_by, revision_request_note, NEW.model,
    NEW.loop_version, NEW.prompt_version_id, NEW.trace,
    (extract(epoch FROM clock_timestamp()) * 1000)::bigint
  );
  RETURN NULL;
END;
$fn$ LANGUAGE plpgsql
`;

const MESSAGE_DRAFT_REVISION_TRIGGERS = [
  `
CREATE TRIGGER messages_draft_revision_ins
AFTER INSERT ON messages
FOR EACH ROW
EXECUTE FUNCTION engager_record_message_draft_revision()
`,
  `
CREATE TRIGGER messages_draft_revision_upd
AFTER UPDATE OF proposed_text, final_text, redraft_request_id ON messages
FOR EACH ROW
WHEN (OLD.proposed_text IS DISTINCT FROM NEW.proposed_text
      OR OLD.final_text IS DISTINCT FROM NEW.final_text
      OR (OLD.redraft_request_id IS NOT NULL
          AND NEW.redraft_request_id IS NULL
          AND NEW.status <> 'rejected'))
EXECUTE FUNCTION engager_record_message_draft_revision()
`,
];

const MESSAGE_DRAFT_REVISION_ACL = `
DO $message_draft_revision_acl$
DECLARE
  grantee_name text;
BEGIN
  FOR grantee_name IN
    SELECT DISTINCT grantee
      FROM information_schema.table_privileges
     WHERE table_schema = current_schema()
       AND table_name = 'messages'
       AND privilege_type = 'INSERT'
       AND grantee NOT IN (current_user, 'PUBLIC')
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM %I',
      current_schema(), 'message_draft_revisions', grantee_name
    );
    EXECUTE format(
      'GRANT SELECT, INSERT ON TABLE %I.%I TO %I',
      current_schema(), 'message_draft_revisions', grantee_name
    );
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON SEQUENCE %I.%I FROM %I',
      current_schema(), 'message_draft_revisions_id_seq', grantee_name
    );
    EXECUTE format(
      'GRANT USAGE ON SEQUENCE %I.%I TO %I',
      current_schema(), 'message_draft_revisions_id_seq', grantee_name
    );
  END LOOP;
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM PUBLIC',
    current_schema(), 'message_draft_revisions'
  );
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON SEQUENCE %I.%I FROM PUBLIC',
    current_schema(), 'message_draft_revisions_id_seq'
  );
END
$message_draft_revision_acl$
`;

export const triggerFinalisationInputs = [
  WITHDRAW_FN, WITHDRAW_TRIGGERS, MESSAGE_STATUS_EVENT_FN, MESSAGE_STATUS_EVENT_TRIGGERS,
  MESSAGE_STATUS_EVENT_ACL, MESSAGE_DRAFT_REVISION_FN, MESSAGE_DRAFT_REVISION_TRIGGERS,
  MESSAGE_DRAFT_REVISION_ACL,
];

/** Install the withdraw function + triggers (idempotent). */
export async function applyTriggers(client: typeof db = db): Promise<void> {
  await client.execute(sql.raw(WITHDRAW_FN));
  await client.execute(sql.raw(`DROP TRIGGER IF EXISTS messages_withdraw_send_upd ON messages`));
  for (const stmt of WITHDRAW_TRIGGERS) await client.execute(sql.raw(stmt));
  await client.execute(sql.raw(MESSAGE_STATUS_EVENT_FN));
  for (const name of [
    "messages_status_event_ins",
    "messages_status_event_upd",
  ]) {
    await client.execute(sql.raw(`DROP TRIGGER IF EXISTS ${name} ON messages`));
  }
  for (const stmt of MESSAGE_STATUS_EVENT_TRIGGERS) {
    await client.execute(sql.raw(stmt));
  }
  await client.execute(sql.raw(MESSAGE_STATUS_EVENT_ACL));
  await client.execute(sql.raw(MESSAGE_DRAFT_REVISION_FN));
  for (const name of [
    "messages_draft_revision_ins",
    "messages_draft_revision_upd",
  ]) {
    await client.execute(sql.raw(`DROP TRIGGER IF EXISTS ${name} ON messages`));
  }
  for (const stmt of MESSAGE_DRAFT_REVISION_TRIGGERS) {
    await client.execute(sql.raw(stmt));
  }
  await client.execute(sql.raw(MESSAGE_DRAFT_REVISION_ACL));
}
