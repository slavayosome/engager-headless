ALTER TABLE "messages" DROP CONSTRAINT "messages_target_kind_check";--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_target_kind_check" CHECK (("messages"."kind" = 'comment' and "messages"."incoming_comment_id" is null and "messages"."room_reply_target" is null)
        or ("messages"."kind" = 'reply' and "messages"."discovered_post_id" is null and "messages"."room_reply_target" is null)
        or ("messages"."kind" = 'room_reply' and "messages"."incoming_comment_id" is null and "messages"."room_reply_target" is not null
          and jsonb_typeof("messages"."room_reply_target") = 'object'));