-- Room rewrites retain the old draft during generation. Cancelling or failing
-- the request is not a new draft; a completed rewrite is not an owner edit.
-- Existing comments and replies retain their history semantics.
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
    AND NOT (OLD.redraft_request_id IS NOT NULL AND NEW.redraft_request_id IS NULL
      AND NEW.status <> 'rejected' AND (NEW.kind <> 'room_reply' OR room_completed)) THEN
    RETURN NULL;
  END IF;

  SELECT coalesce(max(revision), 0) + 1 INTO next_revision
    FROM message_draft_revisions
    WHERE organization_id = NEW.organization_id AND message_id = NEW.id;

  IF NULLIF(current_setting('app.message_draft_source', true), '') = 'variant_swap' THEN
    revision_source := 'variant_swap';
  ELSIF room_completed THEN
    revision_source := 'redraft';
  ELSIF NEW.final_text IS DISTINCT FROM OLD.final_text THEN
    revision_source := 'human_edit';
  ELSIF OLD.redraft_request_id IS NOT NULL AND NEW.redraft_request_id IS NULL
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
$fn$ LANGUAGE plpgsql;
