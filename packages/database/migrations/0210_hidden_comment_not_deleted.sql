-- A HIDDEN COMMENT IS NEVER A DELETED ONE. On a busy post LinkedIn ranks our
-- comment out of the post's default view — the document it serves and the
-- markup alike — so a read of the page did not find it, and two such reads
-- six hours apart retired its watch and tombstoned every reply under it,
-- though the comment and its replies were live (read 2026-10-13 through
-- LinkedIn's comment data for that comment's own thread, which the reply read
-- now asks first). A read that does not find our comment is now a note on the
-- watch and nothing else (`recordThreadRead`,
-- packages/core/jobs/handlers/replyWatches.ts): a watch retires at its own
-- expiry, or when its post answers 404/410.
--
-- The watches that rule retired come back, once: an agentic campaign's watch
-- on a comment of ours, retired in the last three days with its own expiry
-- still ahead, less those the quiet-check sweep retired (ten quiet checks on
-- a watch three days old, `handleMonitorEngagement`), which that sweep would
-- retire again. Its mark tells the rule's retirements apart: the rule retired
-- a watch only with `missing_since` set, and a post that answered 404/410
-- retired one with none unless a miss came first — so only a watch retired
-- with its mark set comes back. With it come
-- the thread replies tombstoned in the same transaction — `removed_at` the
-- instant the watch retired — and the journey sources tombstoned with them.
-- A held reply stays held, and its status moves back only where the removal
-- provably set it, as 0209's did: `ignored` is `new` again on a reply no
-- pipeline job ever ran for or whose draft the removal withdrew
-- (`reply_removed`); a reply the pipeline parked stays parked, and any other
-- status stands. The drafts the removal withdrew stay withdrawn.
--
-- Nothing counts our comment's misses any more, so the marks
-- `comment_watches.missing_since` holds are cleared: a build rolled back to
-- one that still counts them starts from none.
--
-- `incoming_comments.commenter_member_urn` keeps the replier's own identity
-- on LinkedIn (`urn:li:fsd_profile:…`) where the read or the notification
-- card that recorded the reply carried it.
--
-- Expand-only: one nullable column no old code names; the repair moves only
-- `state`, `next_check_at`, `updated_at` and `missing_since` on watches,
-- `removed_at` and `status` on replies and `deleted_at` on their sources, and
-- matches nothing on a second pass or a fresh database.
ALTER TABLE "incoming_comments" ADD COLUMN "commenter_member_urn" text;--> statement-breakpoint
WITH "retired" AS (
  SELECT "comment_watches"."id",
         "comment_watches"."organization_id",
         "comment_watches"."message_id",
         "comment_watches"."updated_at"
    FROM "comment_watches"
    JOIN "campaigns"
      ON "campaigns"."id" = "comment_watches"."campaign_id"
     AND "campaigns"."organization_id" = "comment_watches"."organization_id"
    JOIN "messages"
      ON "messages"."id" = "comment_watches"."message_id"
     AND "messages"."organization_id" = "comment_watches"."organization_id"
   WHERE "comment_watches"."state" = 'expired'
     AND "comment_watches"."missing_since" IS NOT NULL
     AND "comment_watches"."expires_at" > (extract(epoch from now())*1000)::bigint
     AND "comment_watches"."updated_at" >= (extract(epoch from now())*1000)::bigint - 3 * 86400000
     AND NOT ("comment_watches"."quiet_checks" >= 10
              AND "comment_watches"."created_at" <= (extract(epoch from now())*1000)::bigint - 3 * 86400000)
     AND "campaigns"."agentic_workflow" = true
     AND "messages"."kind" = 'comment'
), "removed" AS (
  SELECT "incoming_comments"."id",
         "incoming_comments"."organization_id",
         "incoming_comments"."removed_at"
    FROM "incoming_comments"
    JOIN "retired"
      ON "retired"."organization_id" = "incoming_comments"."organization_id"
     AND "retired"."message_id" = "incoming_comments"."parent_message_id"
     AND "retired"."updated_at" = "incoming_comments"."removed_at"
   WHERE "incoming_comments"."source" = 'our_comment_thread'
), "sources" AS (
  UPDATE "journey_sources"
     SET "deleted_at" = NULL
    FROM "removed"
   WHERE "journey_sources"."organization_id" = "removed"."organization_id"
     AND "journey_sources"."incoming_comment_id" = "removed"."id"
     AND "journey_sources"."deleted_at" = "removed"."removed_at"
), "replies" AS (
  UPDATE "incoming_comments"
     SET "removed_at" = NULL,
         "status" = CASE
           WHEN "incoming_comments"."status" = 'ignored'
            AND (NOT EXISTS (
                   SELECT 1 FROM "jobs"
                    WHERE "jobs"."organization_id" = "incoming_comments"."organization_id"
                      AND "jobs"."idempotency_key" = 'process_incoming:' || "incoming_comments"."id")
                 OR EXISTS (
                   SELECT 1 FROM "messages"
                    WHERE "messages"."organization_id" = "incoming_comments"."organization_id"
                      AND "messages"."incoming_comment_id" = "incoming_comments"."id"
                      AND "messages"."kind" = 'reply'
                      AND "messages"."status" = 'rejected'
                      AND "messages"."error" = 'reply_removed'))
           THEN 'new'
           ELSE "incoming_comments"."status"
         END
    FROM "removed"
   WHERE "incoming_comments"."organization_id" = "removed"."organization_id"
     AND "incoming_comments"."id" = "removed"."id"
)
UPDATE "comment_watches"
   SET "state" = 'active',
       "next_check_at" = (extract(epoch from now())*1000)::bigint,
       "updated_at" = (extract(epoch from now())*1000)::bigint
  FROM "retired"
 WHERE "comment_watches"."id" = "retired"."id";--> statement-breakpoint
UPDATE "comment_watches" SET "missing_since" = NULL WHERE "missing_since" IS NOT NULL;
