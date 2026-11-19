-- ONE MISSED READ NEVER RETIRES A WATCH. A whole read of a thread that did not
-- find our comment in it retired the watch on the spot, and a reader that
-- simply failed to find our row on a redesigned page is a whole read of
-- exactly that shape. `comment_watches.missing_since` keeps the first miss:
-- a read that shows our comment, or a notification card that speaks of it,
-- clears it, and only a second miss at least six hours on retires the watch
-- (`recordThreadRead`, packages/core/jobs/handlers/replyWatches.ts).
--
-- The watches the old rule already retired come back, once: an agentic
-- campaign's watch on a comment of ours, retired in the last fourteen days
-- with its own expiry still ahead. Nothing on the row says which read retired
-- it — our comment missing, or a post that answered 404/410 — so every such
-- watch is read again now, and one whose comment is really gone retires again
-- by the new rule. One the quiet-check sweep retired (`handleMonitorEngagement`:
-- ten quiet checks on a watch three days old) is told apart by those numbers
-- and left retired, since that sweep would retire it again anyway.
-- Expand-only: one nullable column no old code names; the repair moves only
-- `state`, `next_check_at` and `updated_at`, and matches nothing on a second
-- pass.
ALTER TABLE "comment_watches" ADD COLUMN "missing_since" bigint;--> statement-breakpoint
UPDATE "comment_watches"
   SET "state" = 'active',
       "next_check_at" = (extract(epoch from now())*1000)::bigint,
       "updated_at" = (extract(epoch from now())*1000)::bigint
  FROM "campaigns", "messages"
 WHERE "comment_watches"."state" = 'expired'
   AND "comment_watches"."expires_at" > (extract(epoch from now())*1000)::bigint
   AND "comment_watches"."updated_at" >= (extract(epoch from now())*1000)::bigint - 14 * 86400000
   AND NOT ("comment_watches"."quiet_checks" >= 10
            AND "comment_watches"."created_at" <= (extract(epoch from now())*1000)::bigint - 3 * 86400000)
   AND "campaigns"."id" = "comment_watches"."campaign_id"
   AND "campaigns"."organization_id" = "comment_watches"."organization_id"
   AND "campaigns"."agentic_workflow" = true
   AND "messages"."id" = "comment_watches"."message_id"
   AND "messages"."organization_id" = "comment_watches"."organization_id"
   AND "messages"."kind" = 'comment';
