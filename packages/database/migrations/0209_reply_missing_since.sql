-- ONE READ THAT DID NOT SEE A REPLY NEVER REMOVES IT. A complete read of our
-- comment's thread that did not show a reply tombstoned it on the spot, and
-- the redesigned post page renders replies flat, beside the comment they
-- answer, so a reader that cannot tell which rows answer ours reads exactly
-- that shape — a reply still live on LinkedIn was removed, its drafts
-- withdrawn. `incoming_comments.missing_since` keeps the first such read: a
-- read that shows the reply clears it, and only a second one at least six
-- hours on removes it (`recordThreadRead`,
-- packages/core/jobs/handlers/replyWatches.ts).
--
-- The replies the old rule removed in the last three days come back, once:
-- a thread reply whose `removed_at` a read of its thread set, not our comment
-- or its post going — that retires the watch on the same instant, which is
-- how it is told apart. Each is live again, a held one stays held, and the
-- journey sources tombstoned in the same transaction are restored with it.
-- Its status moves back only where the removal provably set it: `ignored` is
-- `new` again on a reply no pipeline job ever ran for (a held one) or whose
-- draft the removal withdrew (`reply_removed`); a reply the pipeline itself
-- parked as `ignored` (`markIgnored`) stays parked, and any other status
-- stands. The drafts the removal withdrew stay withdrawn. Expand-only: one
-- nullable column no old code names; the repair moves only `removed_at`,
-- `status` and `deleted_at`, and matches nothing on a second pass or a fresh
-- database.
ALTER TABLE "incoming_comments" ADD COLUMN "missing_since" bigint;--> statement-breakpoint
UPDATE "journey_sources"
   SET "deleted_at" = NULL
  FROM "incoming_comments"
 WHERE "journey_sources"."organization_id" = "incoming_comments"."organization_id"
   AND "journey_sources"."incoming_comment_id" = "incoming_comments"."id"
   AND "journey_sources"."deleted_at" = "incoming_comments"."removed_at"
   AND "incoming_comments"."source" = 'our_comment_thread'
   AND "incoming_comments"."removed_at" IS NOT NULL
   AND "incoming_comments"."removed_at" >= (extract(epoch from now())*1000)::bigint - 3 * 86400000
   AND NOT EXISTS (
         SELECT 1 FROM "comment_watches"
          WHERE "comment_watches"."organization_id" = "incoming_comments"."organization_id"
            AND "comment_watches"."message_id" = "incoming_comments"."parent_message_id"
            AND "comment_watches"."state" = 'expired'
            AND "comment_watches"."updated_at" = "incoming_comments"."removed_at");--> statement-breakpoint
UPDATE "incoming_comments"
   SET "removed_at" = NULL,
       "status" = CASE
         WHEN "status" = 'ignored'
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
         ELSE "status"
       END
 WHERE "source" = 'our_comment_thread'
   AND "removed_at" IS NOT NULL
   AND "removed_at" >= (extract(epoch from now())*1000)::bigint - 3 * 86400000
   AND NOT EXISTS (
         SELECT 1 FROM "comment_watches"
          WHERE "comment_watches"."organization_id" = "incoming_comments"."organization_id"
            AND "comment_watches"."message_id" = "incoming_comments"."parent_message_id"
            AND "comment_watches"."state" = 'expired'
            AND "comment_watches"."updated_at" = "incoming_comments"."removed_at");
