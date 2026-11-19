-- WITHDRAW A PENDING INVITE. The owner's press on an invitation of ours still
-- pending is one more row on the action ledger — kind `withdraw_invite`,
-- purpose `withdrawal` — and its write is held Off until its own live check,
-- `withdraw_invitation`, is recorded on the account.
-- Expand-only: each CHECK widens by one value, which every existing row
-- passes; old code never writes any of them.
ALTER TABLE "action_executions" DROP CONSTRAINT "action_executions_kind_check";--> statement-breakpoint
ALTER TABLE "action_executions" DROP CONSTRAINT "action_executions_purpose_check";--> statement-breakpoint
ALTER TABLE "live_checks" DROP CONSTRAINT "live_checks_values_check";--> statement-breakpoint
ALTER TABLE "action_executions" ADD CONSTRAINT "action_executions_kind_check" CHECK ("action_executions"."kind" in ('like_target', 'invite', 'accept_invite', 'dm', 'followup', 'withdraw_invite'));--> statement-breakpoint
ALTER TABLE "action_executions" ADD CONSTRAINT "action_executions_purpose_check" CHECK ("action_executions"."purpose" in ('opener', 'reply', 'cta', 'followup', 'reaction', 'acceptance', 'withdrawal'));--> statement-breakpoint
ALTER TABLE "live_checks" ADD CONSTRAINT "live_checks_values_check" CHECK ("live_checks"."capability" in ('send_invitation', 'accept_invitation', 'send_dm', 'withdraw_invitation') and "live_checks"."state" in ('reading', 'read', 'writing', 'recorded', 'closed'));