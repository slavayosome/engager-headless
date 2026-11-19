ALTER TABLE "live_checks" DROP CONSTRAINT "live_checks_values_check";--> statement-breakpoint
ALTER TABLE "live_checks" DROP CONSTRAINT "live_checks_writing_check";--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "message_request_version" integer;--> statement-breakpoint
ALTER TABLE "live_checks" ADD COLUMN "message_id" bigint;--> statement-breakpoint
-- live_checks_org_message_fk follows the concurrent messages tenant index
-- in applyPostConcurrentConstraints, including on a fresh installation.
--> statement-breakpoint
CREATE UNIQUE INDEX "live_checks_org_message_unq" ON "live_checks" USING btree ("organization_id","message_id") WHERE "live_checks"."message_id" is not null;--> statement-breakpoint
ALTER TABLE "live_checks" ADD CONSTRAINT "live_checks_room_check" CHECK ("live_checks"."capability" <> 'room_reply' or
      ("live_checks"."state" in ('recorded', 'closed') and "live_checks"."subject"->>'kind' = 'room_reply'
        and "live_checks"."subject"->>'messageId' = "live_checks"."message_id"::text));--> statement-breakpoint
ALTER TABLE "live_checks" ADD CONSTRAINT "live_checks_values_check" CHECK ("live_checks"."capability" in ('send_invitation', 'accept_invitation', 'send_dm', 'withdraw_invitation', 'room_reply') and "live_checks"."state" in ('reading', 'read', 'writing', 'recorded', 'closed'));--> statement-breakpoint
ALTER TABLE "live_checks" ADD CONSTRAINT "live_checks_writing_check" CHECK ("live_checks"."state" not in ('writing', 'recorded') or ("live_checks"."read_confirmed_at" is not null and
        (("live_checks"."capability" <> 'room_reply' and "live_checks"."action_execution_id" is not null and "live_checks"."message_id" is null)
          or ("live_checks"."capability" = 'room_reply' and "live_checks"."message_id" is not null and "live_checks"."action_execution_id" is null))));
