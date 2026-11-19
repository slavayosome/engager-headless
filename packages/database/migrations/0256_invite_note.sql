-- THE INVITE NOTE AS THE FIRST MESSAGE. A DM that carries the note an
-- accepted invitation was sent with is one more row on the action ledger,
-- purpose `invite_note`: one per conversation, never the invitation's own
-- `opener`. The journey event `invite_note_carried` and the job
-- `invite_note_check` are enums in the application only.
-- Expand-only: the CHECK widens by one value, which every existing row
-- passes; old code never writes it.
ALTER TABLE "action_executions" DROP CONSTRAINT "action_executions_purpose_check";--> statement-breakpoint
ALTER TABLE "action_executions" ADD CONSTRAINT "action_executions_purpose_check" CHECK ("action_executions"."purpose" in ('opener', 'reply', 'cta', 'followup', 'reaction', 'acceptance', 'withdrawal', 'invite_note'));
