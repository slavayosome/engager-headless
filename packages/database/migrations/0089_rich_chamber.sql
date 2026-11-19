CREATE TABLE "message_status_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT nullif(current_setting('app.current_org', true), '')::uuid NOT NULL,
	"message_id" bigint NOT NULL,
	"campaign_id" bigint,
	"from_status" text,
	"to_status" text NOT NULL,
	"local_day" text NOT NULL,
	"occurred_at" bigint NOT NULL,
	CONSTRAINT "message_status_events_local_day_check" CHECK ("message_status_events"."local_day" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
);
--> statement-breakpoint
ALTER TABLE "message_status_events" ADD CONSTRAINT "message_status_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_status_events" ADD CONSTRAINT "message_status_events_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_status_events_backfill_identity_unq" ON "message_status_events" USING btree ("message_id",coalesce("from_status", ''),"to_status","occurred_at");--> statement-breakpoint
CREATE INDEX "message_status_events_org_day_idx" ON "message_status_events" USING btree ("organization_id","local_day","occurred_at");--> statement-breakpoint
CREATE INDEX "message_status_events_org_campaign_day_idx" ON "message_status_events" USING btree ("organization_id","campaign_id","local_day","occurred_at");--> statement-breakpoint
CREATE INDEX "message_status_events_message_time_idx" ON "message_status_events" USING btree ("message_id","occurred_at");--> statement-breakpoint
ALTER TABLE "message_status_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_status_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_read ON "message_status_events" FOR SELECT USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_append ON "message_status_events" FOR INSERT WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid);--> statement-breakpoint
-- The default-privilege firewall intentionally leaves new tables inaccessible.
-- Mirror the established messages writer roles before this transaction installs
-- the trigger, then reduce the event table itself to append-only authority.
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
$message_status_event_acl$;--> statement-breakpoint
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

	SELECT COALESCE(NULLIF(campaign.active_hours->>'tz', ''), 'UTC')
		INTO event_tz
		FROM campaigns campaign
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
		local_day, occurred_at
	) VALUES (
		NEW.organization_id,
		NEW.id,
		NEW.campaign_id,
		CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END,
		NEW.status,
		event_day,
		event_at
	);
	RETURN NULL;
END;
$fn$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS messages_status_event_ins ON messages;--> statement-breakpoint
CREATE TRIGGER messages_status_event_ins
AFTER INSERT ON messages
FOR EACH ROW
EXECUTE FUNCTION engager_record_message_status_event();--> statement-breakpoint
DROP TRIGGER IF EXISTS messages_status_event_upd ON messages;--> statement-breakpoint
CREATE TRIGGER messages_status_event_upd
AFTER UPDATE OF status ON messages
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION engager_record_message_status_event();--> statement-breakpoint
-- Only timestamps backed by durable historical columns are reconstructed.
-- from_status remains null because the pre-event schema cannot prove it; in
-- particular, no failed event is invented from the message's current status.
WITH historical_events AS (
	SELECT
		m.organization_id,
		m.id AS message_id,
		m.campaign_id,
		NULL::text AS from_status,
		CASE
			WHEN m.status = 'suppressed_dryrun' THEN 'suppressed_dryrun'
			WHEN NOT EXISTS (
				SELECT 1 FROM feedback f
				WHERE f.organization_id = m.organization_id AND f.message_id = m.id
			) AND m.status IN ('proposed', 'approved') THEN m.status
			WHEN NOT EXISTS (
				SELECT 1 FROM feedback f
				WHERE f.organization_id = m.organization_id AND f.message_id = m.id
			) AND m.posted_at IS NOT NULL THEN 'approved'
			ELSE 'proposed'
		END AS to_status,
		m.created_at AS occurred_at
	FROM messages m

	UNION ALL

	SELECT
		m.organization_id,
		m.id,
		m.campaign_id,
		NULL::text,
		CASE WHEN f.verdict IN ('approve', 'edit') THEN 'approved' ELSE 'rejected' END,
		f.created_at
	FROM feedback f
	JOIN messages m ON m.id = f.message_id
	WHERE f.verdict IN ('approve', 'edit', 'reject')

	UNION ALL

	SELECT
		m.organization_id,
		m.id,
		m.campaign_id,
		NULL::text,
		'posted',
		m.posted_at
	FROM messages m
	WHERE m.posted_at IS NOT NULL
), localized_events AS (
	SELECT
		event.*,
		COALESCE(zone.name, 'UTC') AS event_tz
	FROM historical_events event
	LEFT JOIN campaigns campaign
		ON campaign.id = event.campaign_id
		AND campaign.organization_id = event.organization_id
	LEFT JOIN pg_timezone_names zone
		ON zone.name = NULLIF(campaign.active_hours->>'tz', '')
)
INSERT INTO message_status_events (
	organization_id, message_id, campaign_id, from_status, to_status,
	local_day, occurred_at
)
SELECT
	organization_id,
	message_id,
	campaign_id,
	from_status,
	to_status,
	to_char(to_timestamp(occurred_at / 1000.0) AT TIME ZONE event_tz, 'YYYY-MM-DD'),
	occurred_at
FROM localized_events
ON CONFLICT DO NOTHING;
