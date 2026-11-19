CREATE TABLE "message_draft_revisions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"message_id" bigint NOT NULL,
	"revision" integer NOT NULL,
	"source" text NOT NULL,
	"draft_text" text NOT NULL,
	"request_id" uuid,
	"request_version" integer,
	"requested_at" bigint,
	"requested_by" text,
	"request_note" text,
	"model" text,
	"loop_version" text,
	"prompt_version_id" bigint,
	"trace" jsonb,
	"created_at" bigint NOT NULL,
	CONSTRAINT "message_draft_revisions_revision_check" CHECK ("message_draft_revisions"."revision" >= 1),
	CONSTRAINT "message_draft_revisions_source_check" CHECK ("message_draft_revisions"."source" in ('initial', 'redraft', 'human_edit')),
	CONSTRAINT "message_draft_revisions_request_metadata_check" CHECK (("message_draft_revisions"."request_id" is null and "message_draft_revisions"."request_version" is null and "message_draft_revisions"."requested_at" is null and "message_draft_revisions"."requested_by" is null) or ("message_draft_revisions"."request_id" is not null and "message_draft_revisions"."request_version" is not null and "message_draft_revisions"."request_version" >= 0 and "message_draft_revisions"."requested_at" is not null and "message_draft_revisions"."requested_by" is not null))
);
--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "reply_auto_post_consented_at" bigint;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "reply_auto_post_consent_version" integer;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "reply_auto_post_consented_by" text;--> statement-breakpoint
ALTER TABLE "incoming_comments" ADD COLUMN "discovered_post_id" bigint;--> statement-breakpoint
ALTER TABLE "incoming_comments" ADD COLUMN "parent_message_id" bigint;--> statement-breakpoint
ALTER TABLE "incoming_comments" ADD COLUMN "draft_request_id" uuid;--> statement-breakpoint
ALTER TABLE "incoming_comments" ADD COLUMN "draft_request_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "incoming_comments" ADD COLUMN "draft_requested_at" bigint;--> statement-breakpoint
ALTER TABLE "incoming_comments" ADD COLUMN "draft_requested_by" text;--> statement-breakpoint
ALTER TABLE "incoming_comments" ADD COLUMN "draft_request_note" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "redraft_request_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "redraft_request_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "redraft_requested_at" bigint;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "redraft_requested_by" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "redraft_request_note" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "own_post_reply_auto_post_consented_at" bigint;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "own_post_reply_auto_post_consent_version" integer;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "own_post_reply_auto_post_consented_by" text;--> statement-breakpoint
ALTER TABLE "message_draft_revisions" ADD CONSTRAINT "message_draft_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_draft_revisions_org_message_revision_unq" ON "message_draft_revisions" USING btree ("organization_id","message_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "message_draft_revisions_org_request_unq" ON "message_draft_revisions" USING btree ("organization_id","request_id") WHERE "message_draft_revisions"."request_id" is not null;--> statement-breakpoint
CREATE INDEX "message_draft_revisions_message_chronology_idx" ON "message_draft_revisions" USING btree ("organization_id","message_id","created_at","revision");--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_reply_auto_post_consent_check" CHECK (("campaigns"."reply_auto_post_consented_at" is null and "campaigns"."reply_auto_post_consent_version" is null and "campaigns"."reply_auto_post_consented_by" is null) or ("campaigns"."reply_auto_post_consented_at" is not null and "campaigns"."reply_auto_post_consent_version" > 0 and "campaigns"."reply_auto_post_consented_by" is not null));--> statement-breakpoint
ALTER TABLE "incoming_comments" ADD CONSTRAINT "incoming_comments_draft_request_metadata_check" CHECK (("incoming_comments"."draft_request_id" is null and "incoming_comments"."draft_requested_at" is null and "incoming_comments"."draft_requested_by" is null) or ("incoming_comments"."draft_request_id" is not null and "incoming_comments"."draft_requested_at" is not null and "incoming_comments"."draft_requested_by" is not null));--> statement-breakpoint
ALTER TABLE "incoming_comments" ADD CONSTRAINT "incoming_comments_draft_request_version_check" CHECK ("incoming_comments"."draft_request_version" >= 0);--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_redraft_request_metadata_check" CHECK (("messages"."redraft_request_id" is null and "messages"."redraft_requested_at" is null and "messages"."redraft_requested_by" is null) or ("messages"."redraft_request_id" is not null and "messages"."redraft_requested_at" is not null and "messages"."redraft_requested_by" is not null));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_redraft_request_version_check" CHECK ("messages"."redraft_request_version" >= 0);--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_own_post_reply_auto_post_consent_check" CHECK (("organizations"."own_post_reply_auto_post_consented_at" is null and "organizations"."own_post_reply_auto_post_consent_version" is null and "organizations"."own_post_reply_auto_post_consented_by" is null) or ("organizations"."own_post_reply_auto_post_consented_at" is not null and "organizations"."own_post_reply_auto_post_consent_version" > 0 and "organizations"."own_post_reply_auto_post_consented_by" is not null));--> statement-breakpoint
-- Normalize historical crossed targets before enforcing the kind boundary.
UPDATE messages
SET incoming_comment_id = NULL
WHERE kind = 'comment' AND incoming_comment_id IS NOT NULL;--> statement-breakpoint
UPDATE messages
SET discovered_post_id = NULL
WHERE kind = 'reply' AND discovered_post_id IS NOT NULL;--> statement-breakpoint
-- Preserve every message while choosing one stable direct link per root/reply.
WITH ranked AS (
	SELECT id,
		row_number() OVER (
			PARTITION BY organization_id, discovered_post_id
			ORDER BY (status = 'posted') DESC, id DESC
		) AS position
	FROM messages
	WHERE discovered_post_id IS NOT NULL
)
UPDATE messages AS message
SET discovered_post_id = NULL
FROM ranked
WHERE message.id = ranked.id AND ranked.position > 1;--> statement-breakpoint
WITH ranked AS (
	SELECT id,
		row_number() OVER (
			PARTITION BY organization_id, incoming_comment_id
			ORDER BY (status = 'posted') DESC, id DESC
		) AS position
	FROM messages
	WHERE incoming_comment_id IS NOT NULL
)
UPDATE messages AS message
SET incoming_comment_id = NULL
FROM ranked
WHERE message.id = ranked.id AND ranked.position > 1;--> statement-breakpoint
-- Link historical thread replies only through a same-tenant, campaign-consistent
-- root comment. Cross-tenant, dangling, and unmatched rows remain unlinked.
WITH thread_roots AS (
	SELECT incoming.id AS incoming_id,
		root.id AS parent_message_id,
		root.campaign_id,
		root.discovered_post_id
	FROM incoming_comments AS incoming
	CROSS JOIN LATERAL (
		SELECT message.id, message.campaign_id, message.discovered_post_id
		FROM messages AS message
		JOIN discovered_posts AS post
			ON post.id = message.discovered_post_id
			AND post.organization_id = message.organization_id
			AND post.campaign_id = message.campaign_id
		WHERE message.organization_id = incoming.organization_id
			AND message.kind = 'comment'
			AND message.external_urn = incoming.thread_parent_urn
			AND message.discovered_post_id IS NOT NULL
			AND message.campaign_id IS NOT NULL
			AND (incoming.campaign_id IS NULL OR incoming.campaign_id = message.campaign_id)
		ORDER BY (message.status = 'posted') DESC, message.id DESC
		LIMIT 1
	) AS root
	WHERE incoming.source = 'our_comment_thread'
)
UPDATE incoming_comments AS incoming
SET parent_message_id = thread_roots.parent_message_id,
	campaign_id = thread_roots.campaign_id,
	discovered_post_id = thread_roots.discovered_post_id
FROM thread_roots
WHERE incoming.id = thread_roots.incoming_id;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_target_kind_check" CHECK (("messages"."kind" = 'comment' and "messages"."incoming_comment_id" is null) or ("messages"."kind" = 'reply' and "messages"."discovered_post_id" is null));--> statement-breakpoint
-- NOT VALID deliberately preserves unmatched historical thread rows while
-- enforcing complete source links for every new or changed row.
ALTER TABLE "incoming_comments" ADD CONSTRAINT "incoming_comments_source_links_check" CHECK (("incoming_comments"."source" = 'own_post' and "incoming_comments"."discovered_post_id" is null and "incoming_comments"."parent_message_id" is null) or ("incoming_comments"."source" = 'our_comment_thread' and "incoming_comments"."discovered_post_id" is not null and "incoming_comments"."parent_message_id" is not null)) NOT VALID;--> statement-breakpoint
INSERT INTO message_draft_revisions (
	organization_id, message_id, revision, source, draft_text,
	model, loop_version, prompt_version_id, trace, created_at
)
SELECT organization_id, id, 1, 'initial', coalesce(final_text, proposed_text),
	model, loop_version, prompt_version_id, trace, created_at
FROM messages;--> statement-breakpoint
ALTER TABLE "message_draft_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_draft_revisions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_read ON "message_draft_revisions" FOR SELECT USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_append ON "message_draft_revisions" FOR INSERT WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
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
$message_draft_revision_acl$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION engager_record_message_draft_revision() RETURNS trigger AS $fn$
DECLARE
	next_revision integer;
	revision_source text;
	revision_request_id uuid;
	revision_request_version integer;
	revision_requested_at bigint;
	revision_requested_by text;
	revision_request_note text;
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

	IF coalesce(OLD.final_text, OLD.proposed_text) IS NOT DISTINCT FROM
		coalesce(NEW.final_text, NEW.proposed_text)
		AND NOT (OLD.redraft_request_id IS NOT NULL
			AND NEW.redraft_request_id IS NULL
			AND NEW.status <> 'rejected') THEN
		RETURN NULL;
	END IF;

	SELECT coalesce(max(revision), 0) + 1
		INTO next_revision
		FROM message_draft_revisions
		WHERE organization_id = NEW.organization_id
			AND message_id = NEW.id;

	IF NEW.final_text IS DISTINCT FROM OLD.final_text THEN
		revision_source := 'human_edit';
	ELSIF OLD.redraft_request_id IS NOT NULL
			AND NEW.redraft_request_id IS NULL
			AND NEW.status <> 'rejected' THEN
		revision_source := 'redraft';
		revision_request_id := OLD.redraft_request_id;
		revision_request_version := OLD.redraft_request_version;
		revision_requested_at := OLD.redraft_requested_at;
		revision_requested_by := OLD.redraft_requested_by;
		revision_request_note := OLD.redraft_request_note;
	ELSE
		revision_source := 'human_edit';
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
$fn$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS messages_draft_revision_ins ON messages;--> statement-breakpoint
CREATE TRIGGER messages_draft_revision_ins
AFTER INSERT ON messages
FOR EACH ROW
EXECUTE FUNCTION engager_record_message_draft_revision();--> statement-breakpoint
DROP TRIGGER IF EXISTS messages_draft_revision_upd ON messages;--> statement-breakpoint
CREATE TRIGGER messages_draft_revision_upd
AFTER UPDATE OF proposed_text, final_text, redraft_request_id ON messages
FOR EACH ROW
WHEN (OLD.proposed_text IS DISTINCT FROM NEW.proposed_text
	OR OLD.final_text IS DISTINCT FROM NEW.final_text
	OR (OLD.redraft_request_id IS NOT NULL
		AND NEW.redraft_request_id IS NULL
		AND NEW.status <> 'rejected'))
EXECUTE FUNCTION engager_record_message_draft_revision();
