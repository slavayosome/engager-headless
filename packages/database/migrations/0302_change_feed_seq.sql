-- One counter the dashboard's change feed polls instead of scanning every
-- watched table. A sequence is not transactional, so a bump never takes a row
-- lock on the writer's transaction. It says that some write happened, nothing
-- about which org's or what; the feed only tells the page to read again.
CREATE SEQUENCE "change_feed_seq";--> statement-breakpoint
CREATE OR REPLACE FUNCTION "change_feed_bump"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM nextval('change_feed_seq');
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "change_feed_read"()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$ SELECT last_value FROM "change_feed_seq" $$;--> statement-breakpoint
CREATE TRIGGER "change_feed_campaigns"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "campaigns"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_campaign_definitions"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "campaign_definitions"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_channels"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "channels"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_workers"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "workers"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_automation_runs"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "automation_runs"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_jobs"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "jobs"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_messages"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "messages"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_message_status_events"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "message_status_events"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_message_draft_revisions"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "message_draft_revisions"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_incoming_comments"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "incoming_comments"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_incoming_invitations"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "incoming_invitations"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_dm_threads"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "dm_threads"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_journeys"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "journeys"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_journey_events"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "journey_events"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_action_executions"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "action_executions"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_action_approvals"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "action_approvals"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_pause_controls"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "pause_controls"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_system_state"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "system_state"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_discovered_posts"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "discovered_posts"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_leads"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "leads"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_lead_signals"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "lead_signals"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_lead_ratings"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "lead_ratings"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_room_snapshots"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "room_snapshots"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_room_members"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "room_members"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_room_reply_drafts"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "room_reply_drafts"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_room_reply_assists"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "room_reply_assists"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_composer_drafts"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "composer_drafts"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_draft_plans"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "draft_plans"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_draft_attempts"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "draft_attempts"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_brain_state"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "brain_state"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_brain_vault_mirror"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "brain_vault_mirror"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_knowledge"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "knowledge"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_brain_questions"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "brain_questions"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_products"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "products"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_product_facts"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "product_facts"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_live_checks"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "live_checks"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_bug_reports"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "bug_reports"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_rate_limit_ledger"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "rate_limit_ledger"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_person_reads"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "person_reads"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_chat_pending_changes"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "chat_pending_changes"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_candidate_draft_requests"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "candidate_draft_requests"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_step_runs"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "step_runs"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_inbox_reads"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "inbox_reads"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_engagement_events"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "engagement_events"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_outcome_events"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "outcome_events"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_profile"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "profile"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_pacing_state"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "pacing_state"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_discovery_sources"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "discovery_sources"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_discovery_state"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "discovery_state"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_supervision_state"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "supervision_state"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_voices"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "voices"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_voice_samples"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "voice_samples"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_listening_phrases"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "listening_phrases"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_search_lookalikes"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "search_lookalikes"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_memory_records"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "memory_records"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();--> statement-breakpoint
CREATE TRIGGER "change_feed_organizations"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "organizations"
FOR EACH STATEMENT
EXECUTE FUNCTION "change_feed_bump"();
