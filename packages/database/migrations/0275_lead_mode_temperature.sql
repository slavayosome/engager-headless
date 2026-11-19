-- A lead's temperature is read from their own words to the owner, never from a
-- like or from who they are: `last_words_at` is when the newest of those words
-- arrived and `word_touch_count` how many there have been (a reply under a
-- campaign comment, a DM, an invitation note). `tier`, `touch_count` and
-- `last_signal_at` keep counting likes, for the hot-lead email.
--
-- A person who answered before this shipped must not read as Cold by mistake,
-- so both are filled once from their campaign-thread replies that are still
-- there and already read for intent: a reply not yet read is counted by the
-- classification that reads it, so counting it here would count it twice.
-- Expand-only: one nullable column and one with a constant default, no
-- old code names either; the fill moves only these two columns and matches
-- nothing on a second pass or a fresh database.
ALTER TABLE "leads" ADD COLUMN "last_words_at" bigint;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "word_touch_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "leads"
   SET "last_words_at" = "words"."last_at",
       "word_touch_count" = "words"."n"
  FROM (
    SELECT "organization_id",
           lower("commenter_profile_id") AS "profile_id",
           max("received_at") AS "last_at",
           count(*)::integer AS "n"
      FROM "incoming_comments"
     WHERE "source" = 'our_comment_thread'
       AND "removed_at" IS NULL
       AND "intent" IS NOT NULL
       AND "commenter_profile_id" IS NOT NULL
     GROUP BY "organization_id", lower("commenter_profile_id")
  ) AS "words"
 WHERE "words"."organization_id" = "leads"."organization_id"
   AND "words"."profile_id" = lower("leads"."profile_id")
   AND "leads"."last_words_at" IS NULL;
