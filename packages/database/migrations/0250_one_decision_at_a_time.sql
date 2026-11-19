-- ONE DECISION AT A TIME, ON THE DRAFTS ALREADY WAITING. Comment drafting is
-- person-aware now (`packages/core/people/draftHolds.ts`): a worker drafts one
-- post a person, and none while anything about them waits for the owner's
-- yes. Drafts written before that wait as they were written — on the live
-- install, three comment drafts on one person's posts beside a like of their
-- reply and an invite to them, each its own decision. This settles them once.
--
-- For each person with more than one comment draft a worker wrote and nobody
-- has decided: where another decision about them waits — a like, an invite, a
-- DM or follow-up, a reply draft, their invitation (`DECISION_KINDS`,
-- packages/core/people/waits.ts) — none of the drafts stays; otherwise the
-- oldest draft whose post is still inside its campaign's max post age stays
-- (the oldest of all, where none is). Every other one is closed the way a
-- system closure closes a draft (`deleteCampaign`): `rejected`, with its
-- reason in `error` for the owner to read — "One at a time — replaced by …",
-- the words `people/alsoPosted.ts` finds them by — its redraft request, if
-- one was open, retired the way a rejected comment retires it, so a redraft
-- landing later cannot reopen it. Its post keeps `drafted`, as after the
-- owner's own skip. No feedback is written: the owner decided nothing.
--
-- Only `proposed` comments a worker run wrote are read. A comment scheduled,
-- posted, failed or settled, a draft the owner asked for or wrote, and every
-- reply are never touched. Data only, no shape: re-runnable, since afterwards
-- nobody has two such drafts and the predicate matches nothing.
WITH "pending" AS (
  SELECT "messages"."id",
         "messages"."created_at",
         coalesce(nullif("discovered_posts"."author_profile_id", ''), "messages"."target_profile_id") AS "profile_id",
         ("discovered_posts"."posted_at" IS NULL
           OR "campaigns"."max_post_age_days" <= 0
           OR "discovered_posts"."posted_at" >=
             (extract(epoch from now()) * 1000)::bigint - "campaigns"."max_post_age_days"::bigint * 86400000) AS "fresh"
    FROM "messages"
    JOIN "discovered_posts" ON "discovered_posts"."id" = "messages"."discovered_post_id"
    JOIN "campaigns" ON "campaigns"."id" = "messages"."campaign_id"
   WHERE "messages"."kind" = 'comment'
     AND "messages"."status" = 'proposed'
     AND "messages"."publish_origin" = 'automation'
     AND "messages"."automation_run_id" IS NOT NULL
),
"several" AS (
  SELECT "profile_id"
    FROM "pending"
   WHERE "profile_id" IS NOT NULL
   GROUP BY "profile_id"
  HAVING count(*) > 1
),
"decision" AS (
  -- The oldest other decision waiting on each of them, as the reason names it.
  SELECT DISTINCT ON ("profile_id") "profile_id", "noun"
    FROM (
      SELECT coalesce(nullif("action_executions"."author_profile_id", ''),
                      "action_executions"."target"->>'authorProfileId') AS "profile_id",
             CASE "action_executions"."kind"
               WHEN 'like_target' THEN 'a like'
               WHEN 'invite' THEN 'an invite'
               WHEN 'accept_invite' THEN 'their invitation'
               ELSE 'a message'
             END AS "noun",
             "action_executions"."created_at" AS "at"
        FROM "action_executions"
       WHERE "action_executions"."status" = 'awaiting_review'
         AND "action_executions"."kind" <> 'withdraw_invite'
      UNION ALL
      SELECT coalesce(nullif("incoming_comments"."commenter_profile_id", ''), "messages"."target_profile_id"),
             CASE "messages"."kind" WHEN 'room_reply' THEN 'a reply to their comment' ELSE 'a reply' END,
             "messages"."created_at"
        FROM "messages"
        LEFT JOIN "incoming_comments" ON "incoming_comments"."id" = "messages"."incoming_comment_id"
       WHERE "messages"."kind" IN ('reply', 'room_reply')
         AND "messages"."status" = 'proposed'
      UNION ALL
      SELECT "incoming_invitations"."sender_profile_id",
             'their invitation',
             coalesce("incoming_invitations"."received_at", "incoming_invitations"."first_observed_at")
        FROM "incoming_invitations"
       WHERE "incoming_invitations"."status" = 'pending'
    ) "waiting"
   WHERE "profile_id" IN (SELECT "profile_id" FROM "several")
   ORDER BY "profile_id", "at"
),
"kept" AS (
  SELECT DISTINCT ON ("pending"."profile_id") "pending"."id"
    FROM "pending"
    JOIN "several" ON "several"."profile_id" = "pending"."profile_id"
   WHERE "pending"."profile_id" NOT IN (SELECT "profile_id" FROM "decision")
   ORDER BY "pending"."profile_id", "pending"."fresh" DESC, "pending"."created_at", "pending"."id"
)
UPDATE "messages"
   SET "status" = 'rejected',
       "error" = 'One at a time — replaced by '
         || coalesce("decision"."noun" || ' waiting for your yes', 'the draft on another of their posts'),
       "scheduled_at" = NULL,
       "redraft_request_id" = NULL,
       "redraft_request_version" = "messages"."redraft_request_version" + 1,
       "redraft_requested_at" = NULL,
       "redraft_requested_by" = NULL,
       "redraft_request_note" = NULL
  FROM "pending"
  JOIN "several" ON "several"."profile_id" = "pending"."profile_id"
  LEFT JOIN "decision" ON "decision"."profile_id" = "pending"."profile_id"
 WHERE "messages"."id" = "pending"."id"
   AND "messages"."status" = 'proposed'
   AND "pending"."id" NOT IN (SELECT "id" FROM "kept");
