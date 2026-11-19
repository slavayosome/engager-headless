-- REPLY SHIPS REVIEW-ONLY, ON CAMPAIGNS ALREADY ACTIVATED TOO. Phase 46 has the
-- catalog hold a stored Automatic for Reply at Ask me (`REVIEW_ONLY_MODE_KEYS`,
-- packages/core/definition/catalog.ts), so activation never again projects
-- `approval_mode: 'auto'` onto a campaign that runs on its definition. One
-- activated before the cap still carries the projection it had, and nothing
-- re-activates it by itself: this is that re-projection, once.
--
-- It is exactly what the projection does when Reply moves off Automatic
-- (`projectCampaign`, packages/core/definition/project.ts): the reply lane to
-- `manual`, its Auto-post consent cleared, and the campaign's approved,
-- unsent thread replies back to waiting for a yes
-- (`returnApprovedThreadReplies`) — whose post jobs the messages projection
-- trigger cancels as it does for any approved row moving down. On a campaign
-- that runs on its definition `auto_reply` is written by the projection alone
-- (INV-25), and the cap leaves it no `auto` to say, so every match here is a
-- pre-cap projection; a lane that is off decides nothing and is left as stored.
-- Campaigns off the flag keep their lane's own semantics and are not touched.
-- Re-runnable: the predicate matches nothing on a second pass.
WITH "capped" AS (
  UPDATE "campaigns"
     SET "auto_reply" = jsonb_set("auto_reply", '{approval_mode}', '"manual"'::jsonb),
         "reply_auto_post_consented_at" = NULL,
         "reply_auto_post_consent_version" = NULL,
         "reply_auto_post_consented_by" = NULL,
         "updated_at" = (extract(epoch from now())*1000)::bigint
   WHERE "agentic_workflow" = true
     AND ("auto_reply"->>'enabled')::boolean IS TRUE
     AND "auto_reply"->>'approval_mode' = 'auto'
  RETURNING "id"
)
UPDATE "messages"
   SET "status" = 'proposed',
       "scheduled_at" = NULL
  FROM "capped", "incoming_comments"
 WHERE "messages"."campaign_id" = "capped"."id"
   AND "messages"."kind" = 'reply'
   AND "messages"."status" = 'approved'
   AND "incoming_comments"."id" = "messages"."incoming_comment_id"
   AND "incoming_comments"."source" = 'our_comment_thread';
