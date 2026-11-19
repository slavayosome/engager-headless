-- Contract migration: one profile cache, and profile ids in lower case.
--
-- 1. A profile read lives on `author_profiles` only. The reads that
--    `leads.profile_read` and `candidate_research.author` hold are copied onto
--    the person's row where they are newer, then those columns are dropped.
-- 2. Every column that names a LinkedIn profile is lower-cased, so a lookup is
--    plain equality on an index. Rows whose ids differ only by case merge:
--    - `author_profiles`: the newest read's row, with any known place, headline
--      and counts an older spelling carried;
--    - `engaged_profiles`: one row that keeps the exclusion if any spelling
--      had it, with the counts summed and the notes joined;
--    - `conversations`: nothing is deleted. The newest open conversation stays
--      open and an older one is closed as reopened, history and all;
--    - `leads`: the best row (contacted, then furthest stage, then touched by
--      the owner, then newest) stays and takes the others' state: the furthest
--      status, tier and intent, the earliest first send, the newest rating,
--      draft and research, and the newest set-aside no later contact undid.
--      The one newest rating moves to it; every lead id kept in signals,
--      conversations and their sources, reply targets, composer boxes and
--      plans, and queued jobs is pointed at it; boxes' drafts are appended to
--      the kept box, so no owner draft is dropped.
--    Every other column is only lower-cased, and only where it is not already.
-- `lead_signals.profile_spelling` held the spelling LinkedIn gave so a lead
-- could keep it; with one lower-case form everywhere it is dropped.
-- The two foreign keys onto `author_profiles` are dropped for the rewrite and
-- put back as they were, so the database checks every reference again.
SET LOCAL row_security = off;--> statement-breakpoint
ALTER TABLE "leads" DROP CONSTRAINT "leads_profile_read_check";--> statement-breakpoint
ALTER TABLE "author_profiles" ADD COLUMN "profile_read" jsonb;--> statement-breakpoint
ALTER TABLE "author_profiles" ADD COLUMN "profile_read_at" bigint;--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_org_person_fk";--> statement-breakpoint
ALTER TABLE "outcome_events" DROP CONSTRAINT "outcome_events_org_person_fk";--> statement-breakpoint
CREATE TEMP TABLE "_author_profile_merge" ON COMMIT DROP AS
WITH ranked AS (
  SELECT *, lower("profile_id") AS "key",
    row_number() OVER (
      PARTITION BY "organization_id", lower("profile_id")
      ORDER BY greatest("fetched_at", coalesce("country_read_at", 0), coalesce("relationship_checked_at", 0)) DESC, "profile_id"
    ) AS "rank"
  FROM "author_profiles"
)
SELECT "organization_id", "key",
  (array_agg("headline" ORDER BY "rank") FILTER (WHERE "headline" IS NOT NULL))[1] AS "headline",
  (array_agg("location" ORDER BY "rank") FILTER (WHERE "location" IS NOT NULL))[1] AS "location",
  (array_agg("country" ORDER BY "rank") FILTER (WHERE "country" IS NOT NULL))[1] AS "country",
  (array_agg("geo_urn" ORDER BY "rank") FILTER (WHERE "geo_urn" IS NOT NULL))[1] AS "geo_urn",
  max("country_read_at") AS "country_read_at",
  (array_agg("followers" ORDER BY "rank") FILTER (WHERE "followers" IS NOT NULL))[1] AS "followers",
  (array_agg("connections" ORDER BY "rank") FILTER (WHERE "connections" IS NOT NULL))[1] AS "connections",
  (array_agg("is_influencer" ORDER BY "rank") FILTER (WHERE "is_influencer" IS NOT NULL))[1] AS "is_influencer",
  (array_agg("is_premium" ORDER BY "rank") FILTER (WHERE "is_premium" IS NOT NULL))[1] AS "is_premium",
  max("fetched_at") AS "fetched_at",
  (array_agg("fetch_error" ORDER BY "rank"))[1] AS "fetch_error",
  (array_agg("relationship" ORDER BY "relationship_checked_at" DESC NULLS LAST, "rank"))[1] AS "relationship",
  max("relationship_checked_at") AS "relationship_checked_at",
  (array_agg("identity_evidence" ORDER BY "rank") FILTER (WHERE "identity_evidence" IS NOT NULL))[1] AS "identity_evidence"
FROM ranked
GROUP BY "organization_id", "key"
HAVING count(*) > 1;--> statement-breakpoint
DELETE FROM "author_profiles" ap USING "_author_profile_merge" merged
WHERE ap."organization_id" = merged."organization_id" AND lower(ap."profile_id") = merged."key";--> statement-breakpoint
INSERT INTO "author_profiles" ("organization_id", "profile_id", "headline", "location", "country", "geo_urn", "country_read_at",
  "followers", "connections", "is_influencer", "is_premium", "fetched_at", "fetch_error", "relationship",
  "relationship_checked_at", "identity_evidence")
SELECT "organization_id", "key", "headline", "location", "country", "geo_urn", "country_read_at",
  "followers", "connections", "is_influencer", "is_premium", "fetched_at", "fetch_error", "relationship",
  "relationship_checked_at", "identity_evidence"
FROM "_author_profile_merge";--> statement-breakpoint
UPDATE "author_profiles" SET "profile_id" = lower("profile_id") WHERE "profile_id" <> lower("profile_id");--> statement-breakpoint
UPDATE "author_profiles"
SET "identity_evidence" = jsonb_set("identity_evidence", '{read,profile,id}',
  to_jsonb(lower("identity_evidence" #>> '{read,profile,id}')))
WHERE "identity_evidence" #>> '{read,profile,id}' IS NOT NULL;--> statement-breakpoint
UPDATE "dm_threads" thread
SET "participants" = (
  SELECT jsonb_agg(CASE WHEN jsonb_typeof(person->'profileId') = 'string'
    THEN jsonb_set(person, '{profileId}', to_jsonb(lower(person->>'profileId')))
    ELSE person END ORDER BY ordinal)
  FROM jsonb_array_elements(thread."participants") WITH ORDINALITY AS entry(person, ordinal)
)
WHERE jsonb_array_length(thread."participants") > 0;--> statement-breakpoint
UPDATE "conversations" SET "closed_reason" = 'reopened', "closed_at" = (extract(epoch FROM clock_timestamp()) * 1000)::bigint
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", row_number() OVER (PARTITION BY "organization_id", "channel_id", lower("author_profile_id") ORDER BY "id" DESC) AS "rank"
    FROM "conversations" WHERE "closed_reason" IS NULL
  ) candidate WHERE "rank" > 1
);--> statement-breakpoint
UPDATE "conversations" SET "author_profile_id" = lower("author_profile_id") WHERE "author_profile_id" <> lower("author_profile_id");--> statement-breakpoint
UPDATE "outcome_events" SET "author_profile_id" = lower("author_profile_id") WHERE "author_profile_id" <> lower("author_profile_id");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_org_person_fk" FOREIGN KEY ("organization_id","author_profile_id") REFERENCES "public"."author_profiles"("organization_id","profile_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_events" ADD CONSTRAINT "outcome_events_org_person_fk" FOREIGN KEY ("organization_id","author_profile_id") REFERENCES "public"."author_profiles"("organization_id","profile_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
INSERT INTO "author_profiles" ("organization_id", "profile_id", "fetched_at", "profile_read", "profile_read_at")
SELECT DISTINCT ON ("organization_id", "key") "organization_id", "key", 0, "read", "read_at"
FROM (
  SELECT "organization_id", lower("profile_id") AS "key", "profile_read" AS "read", "profile_read_at" AS "read_at", 0 AS "source", "id" AS "row_id"
  FROM "leads" WHERE "profile_read" IS NOT NULL AND "profile_read_at" IS NOT NULL
  UNION ALL
  SELECT "organization_id", lower("author" ->> 'profileId'), "author", coalesce("author_read_at", 0), 1, "id"
  FROM "candidate_research"
  WHERE "author" IS NOT NULL AND nullif("author" ->> 'profileId', '') IS NOT NULL
) reads
ORDER BY "organization_id", "key", "read_at" DESC, "source", "row_id"
ON CONFLICT ("organization_id", "profile_id") DO UPDATE
SET "profile_read" = excluded."profile_read", "profile_read_at" = excluded."profile_read_at"
WHERE "author_profiles"."profile_read_at" IS NULL OR "author_profiles"."profile_read_at" < excluded."profile_read_at";--> statement-breakpoint
ALTER TABLE "author_profiles" ADD CONSTRAINT "author_profiles_profile_read_check" CHECK (("author_profiles"."profile_read" is null) = ("author_profiles"."profile_read_at" is null));--> statement-breakpoint
CREATE TEMP TABLE "_engaged_profile_merge" ON COMMIT DROP AS
WITH ranked AS (
  SELECT *, lower("profile_id") AS "key",
    row_number() OVER (PARTITION BY "organization_id", lower("profile_id") ORDER BY coalesce("last_engaged_at", 0) DESC, "profile_id") AS "rank"
  FROM "engaged_profiles"
)
SELECT "organization_id", "key",
  (array_agg("name" ORDER BY "rank") FILTER (WHERE "name" IS NOT NULL))[1] AS "name",
  (array_agg("headline" ORDER BY "rank") FILTER (WHERE "headline" IS NOT NULL))[1] AS "headline",
  (array_agg("company" ORDER BY "rank") FILTER (WHERE "company" IS NOT NULL))[1] AS "company",
  (array_agg("url" ORDER BY "rank") FILTER (WHERE "url" IS NOT NULL))[1] AS "url",
  min("first_engaged_at") AS "first_engaged_at",
  max("last_engaged_at") AS "last_engaged_at",
  sum("total_comments")::bigint AS "total_comments",
  sum("total_replies")::bigint AS "total_replies",
  bool_or("do_not_engage") AS "do_not_engage",
  CASE WHEN bool_or("retain_until" IS NULL) THEN NULL ELSE max("retain_until") END AS "retain_until",
  string_agg("notes", E'\n' ORDER BY "rank") FILTER (WHERE "notes" IS NOT NULL) AS "notes"
FROM ranked
GROUP BY "organization_id", "key"
HAVING count(*) > 1;--> statement-breakpoint
DELETE FROM "engaged_profiles" ep USING "_engaged_profile_merge" merged
WHERE ep."organization_id" = merged."organization_id" AND lower(ep."profile_id") = merged."key";--> statement-breakpoint
INSERT INTO "engaged_profiles" ("organization_id", "profile_id", "name", "headline", "company", "url", "first_engaged_at",
  "last_engaged_at", "total_comments", "total_replies", "do_not_engage", "retain_until", "notes")
SELECT "organization_id", "key", "name", "headline", "company", "url", "first_engaged_at",
  "last_engaged_at", "total_comments", "total_replies", "do_not_engage", "retain_until", "notes"
FROM "_engaged_profile_merge";--> statement-breakpoint
UPDATE "engaged_profiles" SET "profile_id" = lower("profile_id") WHERE "profile_id" <> lower("profile_id");--> statement-breakpoint
CREATE TEMP TABLE "_lead_rank" ON COMMIT DROP AS
SELECT * FROM (
  SELECT lead.*, lower(lead."profile_id") AS "key",
    count(*) OVER (PARTITION BY lead."organization_id", lower(lead."profile_id")) AS "variants",
    row_number() OVER (
      PARTITION BY lead."organization_id", lower(lead."profile_id")
      ORDER BY (lead."contacted_at" IS NOT NULL) DESC,
        CASE lead."stage" WHEN 'signal' THEN 1 WHEN 'lead' THEN 2 WHEN 'contacted' THEN 3 WHEN 'no_answer' THEN 3 ELSE 4 END DESC,
        (lead."rating" IS NOT NULL OR lead."set_aside_at" IS NOT NULL OR lead."dm_draft" IS NOT NULL) DESC,
        lead."updated_at" DESC, lead."id"
    ) AS "rank",
    max(greatest(coalesce(lead."contacted_at", 0), coalesce(lead."relationship_at", 0)))
      OVER (PARTITION BY lead."organization_id", lower(lead."profile_id")) AS "latest_touch",
    CASE lead."tier" WHEN 'hot' THEN 3 WHEN 'warm' THEN 2 ELSE 1 END AS "tier_rank",
    CASE lead."status" WHEN 'converted' THEN 5 WHEN 'in_conversation' THEN 4 WHEN 'contacted' THEN 3 WHEN 'new' THEN 2 ELSE 1 END AS "status_rank",
    CASE lead."intent_level" WHEN 'explicit_ask' THEN 4 WHEN 'product_question' THEN 3 WHEN 'positive_signal' THEN 2 ELSE 1 END AS "intent_rank"
  FROM "leads" lead
) ranked
WHERE "variants" > 1;--> statement-breakpoint
CREATE TEMP TABLE "_lead_merged" ON COMMIT DROP AS
SELECT "organization_id", "key",
  (array_agg("id" ORDER BY "rank"))[1] AS "kept_id",
  (array_agg("name" ORDER BY "rank") FILTER (WHERE "name" IS NOT NULL))[1] AS "name",
  (array_agg("headline" ORDER BY "rank") FILTER (WHERE "headline" IS NOT NULL))[1] AS "headline",
  (array_agg("followers" ORDER BY "rank") FILTER (WHERE "followers" IS NOT NULL))[1] AS "followers",
  (array_agg("campaign_id" ORDER BY "rank") FILTER (WHERE "campaign_id" IS NOT NULL))[1] AS "campaign_id",
  (array['watch', 'warm', 'hot'])[max("tier_rank")] AS "tier",
  (array['dead', 'new', 'contacted', 'in_conversation', 'converted'])[max("status_rank")] AS "status",
  (array['none', 'positive_signal', 'product_question', 'explicit_ask'])[max("intent_rank")] AS "intent_level",
  (array_agg("evidence_quote" ORDER BY "intent_rank" DESC, "rank") FILTER (WHERE "evidence_quote" IS NOT NULL))[1] AS "evidence_quote",
  (array_agg("trigger_incoming_comment_id" ORDER BY "intent_rank" DESC, "rank") FILTER (WHERE "trigger_incoming_comment_id" IS NOT NULL))[1] AS "trigger_incoming_comment_id",
  (array_agg("tier_reasons" ORDER BY "tier_rank" DESC, "rank") FILTER (WHERE "tier_reasons" IS NOT NULL))[1] AS "tier_reasons",
  sum("touch_count")::integer AS "touch_count",
  sum("word_touch_count")::integer AS "word_touch_count",
  min("notified_at") AS "notified_at",
  max("nudged_at") AS "nudged_at",
  max("last_signal_at") AS "last_signal_at",
  max("status_changed_at") AS "status_changed_at",
  min("created_at") AS "created_at",
  max("updated_at") AS "updated_at",
  max("last_words_at") AS "last_words_at",
  max("relationship_at") AS "relationship_at",
  max("research_requested_at") AS "research_requested_at",
  (array_agg("origin" ORDER BY ("origin" = 'find_leads') DESC NULLS LAST, "rank"))[1] AS "origin",
  (array_agg("id" ORDER BY coalesce("dm_trace" ->> 'edited', 'false') = 'true' DESC, "dm_drafted_at" DESC NULLS LAST, "rank")
    FILTER (WHERE "dm_draft" IS NOT NULL))[1] AS "dm_donor",
  (array_agg("id" ORDER BY ("qualification" IS NOT NULL) DESC, "researched_at" DESC, "rank")
    FILTER (WHERE "researched_at" IS NOT NULL))[1] AS "research_donor",
  (array_agg("id" ORDER BY "contacted_at", "rank") FILTER (WHERE "contacted_at" IS NOT NULL))[1] AS "sent_donor",
  (array_agg("id" ORDER BY "rated_at" DESC, "rank") FILTER (WHERE "rating" IS NOT NULL))[1] AS "rated_donor",
  (array_agg("id" ORDER BY "set_aside_at" DESC, "rank")
    FILTER (WHERE "set_aside_at" IS NOT NULL AND "set_aside_at" >= "latest_touch"))[1] AS "aside_donor"
FROM "_lead_rank"
GROUP BY "organization_id", "key";--> statement-breakpoint
CREATE TEMP TABLE "_lead_merge" ON COMMIT DROP AS
SELECT ranked."id" AS "loser_id", merged."kept_id", ranked."organization_id", ranked."rank"
FROM "_lead_rank" ranked
JOIN "_lead_merged" merged ON merged."organization_id" = ranked."organization_id" AND merged."key" = ranked."key"
WHERE ranked."id" <> merged."kept_id";--> statement-breakpoint
UPDATE "leads" lead SET
  "name" = merged."name", "headline" = merged."headline", "followers" = merged."followers",
  "campaign_id" = merged."campaign_id", "tier" = merged."tier", "status" = merged."status",
  "intent_level" = merged."intent_level", "evidence_quote" = merged."evidence_quote",
  "trigger_incoming_comment_id" = merged."trigger_incoming_comment_id", "tier_reasons" = merged."tier_reasons",
  "touch_count" = merged."touch_count", "word_touch_count" = merged."word_touch_count",
  "notified_at" = merged."notified_at", "nudged_at" = merged."nudged_at", "last_signal_at" = merged."last_signal_at",
  "status_changed_at" = merged."status_changed_at", "created_at" = merged."created_at", "updated_at" = merged."updated_at",
  "last_words_at" = merged."last_words_at", "relationship_at" = merged."relationship_at",
  "research_requested_at" = merged."research_requested_at", "origin" = merged."origin",
  "dm_draft" = dm."dm_draft", "dm_drafted_at" = dm."dm_drafted_at", "dm_trace" = dm."dm_trace",
  "contacted_at" = sent."contacted_at", "first_send" = sent."first_send",
  "rating" = rated."rating", "rated_at" = rated."rated_at",
  "set_aside_at" = aside."set_aside_at", "set_aside_reason" = aside."set_aside_reason",
  "researched_at" = CASE WHEN merged."research_donor" IS NULL THEN lead."researched_at" ELSE research."researched_at" END,
  "role" = CASE WHEN merged."research_donor" IS NULL THEN lead."role" ELSE research."role" END,
  "fit" = CASE WHEN merged."research_donor" IS NULL THEN lead."fit" ELSE research."fit" END,
  "intent" = CASE WHEN merged."research_donor" IS NULL THEN lead."intent" ELSE research."intent" END,
  "intent_quote" = CASE WHEN merged."research_donor" IS NULL THEN lead."intent_quote" ELSE research."intent_quote" END,
  "intent_at" = CASE WHEN merged."research_donor" IS NULL THEN lead."intent_at" ELSE research."intent_at" END,
  "qualification" = CASE WHEN merged."research_donor" IS NULL THEN lead."qualification" ELSE research."qualification" END,
  "angles" = CASE WHEN merged."research_donor" IS NULL THEN lead."angles" ELSE research."angles" END,
  "company_not_read" = CASE WHEN merged."research_donor" IS NULL THEN lead."company_not_read" ELSE research."company_not_read" END,
  "read_tries" = CASE WHEN merged."research_donor" IS NULL THEN lead."read_tries" ELSE research."read_tries" END,
  "judge_tries" = CASE WHEN merged."research_donor" IS NULL THEN lead."judge_tries" ELSE research."judge_tries" END,
  "pipeline_hold" = CASE WHEN merged."research_donor" IS NULL THEN lead."pipeline_hold" ELSE research."pipeline_hold" END,
  "pipeline_hold_note" = CASE WHEN merged."research_donor" IS NULL THEN lead."pipeline_hold_note" ELSE research."pipeline_hold_note" END
FROM "_lead_merged" merged
LEFT JOIN "_lead_rank" dm ON dm."id" = merged."dm_donor"
LEFT JOIN "_lead_rank" research ON research."id" = merged."research_donor"
LEFT JOIN "_lead_rank" sent ON sent."id" = merged."sent_donor"
LEFT JOIN "_lead_rank" rated ON rated."id" = merged."rated_donor"
LEFT JOIN "_lead_rank" aside ON aside."id" = merged."aside_donor"
WHERE lead."organization_id" = merged."organization_id" AND lead."id" = merged."kept_id";--> statement-breakpoint
CREATE TEMP TABLE "_lead_rating_pick" ON COMMIT DROP AS
SELECT DISTINCT ON (ranked."organization_id", ranked."key") ranked."organization_id", rating."lead_id", merged."kept_id"
FROM "lead_ratings" rating
JOIN "_lead_rank" ranked ON ranked."organization_id" = rating."organization_id" AND ranked."id" = rating."lead_id"
JOIN "_lead_merged" merged ON merged."organization_id" = ranked."organization_id" AND merged."key" = ranked."key"
ORDER BY ranked."organization_id", ranked."key", rating."rated_at" DESC, ranked."rank";--> statement-breakpoint
DELETE FROM "lead_ratings" rating USING "_lead_rank" ranked
WHERE rating."organization_id" = ranked."organization_id" AND rating."lead_id" = ranked."id"
  AND NOT EXISTS (SELECT 1 FROM "_lead_rating_pick" pick WHERE pick."organization_id" = rating."organization_id" AND pick."lead_id" = rating."lead_id");--> statement-breakpoint
UPDATE "lead_ratings" rating SET "lead_id" = pick."kept_id"
FROM "_lead_rating_pick" pick
WHERE rating."organization_id" = pick."organization_id" AND rating."lead_id" = pick."lead_id" AND pick."lead_id" <> pick."kept_id";--> statement-breakpoint
UPDATE "lead_signals" signal SET "lead_id" = dup."kept_id"
FROM "_lead_merge" dup
WHERE signal."organization_id" = dup."organization_id" AND signal."lead_id" = dup."loser_id";--> statement-breakpoint
UPDATE "conversations" conversation SET "opened_from_lead_id" = dup."kept_id"
FROM "_lead_merge" dup
WHERE conversation."organization_id" = dup."organization_id" AND conversation."opened_from_lead_id" = dup."loser_id";--> statement-breakpoint
UPDATE "conversation_events" event SET "source_ref" = jsonb_set(event."source_ref", '{lead,leadId}', to_jsonb(dup."kept_id"))
FROM "_lead_merge" dup
WHERE event."organization_id" = dup."organization_id" AND event."source_ref" #>> '{lead,leadId}' = dup."loser_id"::text;--> statement-breakpoint
UPDATE "messages" message SET "room_reply_target" = jsonb_set(message."room_reply_target", '{leadId}', to_jsonb(dup."kept_id"))
FROM "_lead_merge" dup
WHERE message."organization_id" = dup."organization_id" AND message."room_reply_target" ->> 'source' = 'lead'
  AND message."room_reply_target" ->> 'leadId' = dup."loser_id"::text;--> statement-breakpoint
UPDATE "room_reply_drafts" draft SET "target" = jsonb_set(draft."target", '{leadId}', to_jsonb(dup."kept_id"))
FROM "_lead_merge" dup
WHERE draft."organization_id" = dup."organization_id" AND draft."target" ->> 'source' = 'lead'
  AND draft."target" ->> 'leadId' = dup."loser_id"::text;--> statement-breakpoint
UPDATE "room_reply_assists" assist SET "target" = jsonb_set(assist."target", '{leadId}', to_jsonb(dup."kept_id"))
FROM "_lead_merge" dup
WHERE assist."organization_id" = dup."organization_id" AND assist."target" ->> 'source' = 'lead'
  AND assist."target" ->> 'leadId' = dup."loser_id"::text;--> statement-breakpoint
UPDATE "jobs" job SET "payload" = jsonb_set(job."payload", '{leadId}', to_jsonb(dup."kept_id"))
FROM "_lead_merge" dup
WHERE job."organization_id" = dup."organization_id" AND job."payload" ->> 'leadId' = dup."loser_id"::text;--> statement-breakpoint
UPDATE "jobs" job SET "payload" = jsonb_set(job."payload", '{leadIds}', (
  SELECT jsonb_agg(DISTINCT coalesce(dup."kept_id", (entry.id)::integer))
  FROM jsonb_array_elements_text(job."payload" -> 'leadIds') AS entry(id)
  LEFT JOIN "_lead_merge" dup ON dup."organization_id" = job."organization_id" AND dup."loser_id"::text = entry.id
))
WHERE jsonb_typeof(job."payload" -> 'leadIds') = 'array' AND EXISTS (
  SELECT 1 FROM jsonb_array_elements_text(job."payload" -> 'leadIds') AS entry(id)
  JOIN "_lead_merge" dup ON dup."organization_id" = job."organization_id" AND dup."loser_id"::text = entry.id
);--> statement-breakpoint
CREATE TEMP TABLE "_lead_box_move" ON COMMIT DROP AS
SELECT draft."id", draft."organization_id", 'lead:' || dup."kept_id" || substr(draft."box_key", length('lead:' || dup."loser_id") + 1) AS "box_key",
  dup."rank", draft."position"
FROM "composer_drafts" draft
JOIN "_lead_merge" dup ON dup."organization_id" = draft."organization_id"
  AND (draft."box_key" = 'lead:' || dup."loser_id" OR draft."box_key" LIKE 'lead:' || dup."loser_id" || ':signal:%');--> statement-breakpoint
UPDATE "composer_drafts" draft SET "box_key" = move."box_key", "position" = move."next"
FROM (
  SELECT moving."id", moving."organization_id", moving."box_key",
    coalesce((SELECT max(held."position") FROM "composer_drafts" held
      WHERE held."organization_id" = moving."organization_id" AND held."box_key" = moving."box_key"), 0)
      + row_number() OVER (PARTITION BY moving."organization_id", moving."box_key" ORDER BY moving."rank", moving."position", moving."id") AS "next"
  FROM "_lead_box_move" moving
) move
WHERE draft."id" = move."id";--> statement-breakpoint
UPDATE "draft_plans" plan SET "box_key" = 'lead:' || dup."kept_id" || substr(plan."box_key", length('lead:' || dup."loser_id") + 1)
FROM "_lead_merge" dup
WHERE plan."organization_id" = dup."organization_id"
  AND (plan."box_key" = 'lead:' || dup."loser_id" OR plan."box_key" LIKE 'lead:' || dup."loser_id" || ':signal:%');--> statement-breakpoint
DELETE FROM "leads" lead USING "_lead_merge" dup
WHERE lead."organization_id" = dup."organization_id" AND lead."id" = dup."loser_id";--> statement-breakpoint
UPDATE "room_reply_drafts" SET "target" = jsonb_set(jsonb_set("target", '{profileId}', to_jsonb(lower("target" ->> 'profileId'))), '{personKey}',
  to_jsonb(CASE WHEN "target" ->> 'personKey' LIKE 'p.%' THEN 'p.' || lower(substr("target" ->> 'personKey', 3)) ELSE "target" ->> 'personKey' END))
WHERE "target" ->> 'profileId' IS NOT NULL AND "target" ->> 'personKey' IS NOT NULL;--> statement-breakpoint
UPDATE "room_reply_assists" SET "target" = jsonb_set(jsonb_set("target", '{profileId}', to_jsonb(lower("target" ->> 'profileId'))), '{personKey}',
  to_jsonb(CASE WHEN "target" ->> 'personKey' LIKE 'p.%' THEN 'p.' || lower(substr("target" ->> 'personKey', 3)) ELSE "target" ->> 'personKey' END))
WHERE "target" ->> 'profileId' IS NOT NULL AND "target" ->> 'personKey' IS NOT NULL;--> statement-breakpoint
UPDATE "messages" SET "room_reply_target" = jsonb_set(jsonb_set("room_reply_target", '{profileId}', to_jsonb(lower("room_reply_target" ->> 'profileId'))), '{personKey}',
  to_jsonb(CASE WHEN "room_reply_target" ->> 'personKey' LIKE 'p.%' THEN 'p.' || lower(substr("room_reply_target" ->> 'personKey', 3)) ELSE "room_reply_target" ->> 'personKey' END))
WHERE "room_reply_target" ->> 'profileId' IS NOT NULL AND "room_reply_target" ->> 'personKey' IS NOT NULL;--> statement-breakpoint
UPDATE "leads" SET "profile_id" = lower("profile_id") WHERE "profile_id" <> lower("profile_id");--> statement-breakpoint
UPDATE "lead_signals" SET "profile_id" = lower("profile_id") WHERE "profile_id" <> lower("profile_id");--> statement-breakpoint
UPDATE "discovered_posts" SET "author_profile_id" = lower("author_profile_id") WHERE "author_profile_id" <> lower("author_profile_id");--> statement-breakpoint
UPDATE "action_executions" SET "author_profile_id" = lower("author_profile_id") WHERE "author_profile_id" <> lower("author_profile_id");--> statement-breakpoint
UPDATE "search_lookalikes" SET "author_profile_id" = lower("author_profile_id") WHERE "author_profile_id" <> lower("author_profile_id");--> statement-breakpoint
UPDATE "incoming_invitations" SET "sender_profile_id" = lower("sender_profile_id") WHERE "sender_profile_id" <> lower("sender_profile_id");--> statement-breakpoint
UPDATE "incoming_comments" SET "author_profile_id" = lower("author_profile_id") WHERE "author_profile_id" <> lower("author_profile_id");--> statement-breakpoint
UPDATE "messages" SET "target_profile_id" = lower("target_profile_id") WHERE "target_profile_id" <> lower("target_profile_id");--> statement-breakpoint
UPDATE "rate_limit_ledger" SET "target_profile_id" = lower("target_profile_id") WHERE "target_profile_id" <> lower("target_profile_id");--> statement-breakpoint
UPDATE "engagement_events" SET "actor_profile_id" = lower("actor_profile_id") WHERE "actor_profile_id" <> lower("actor_profile_id");--> statement-breakpoint
UPDATE "room_members" SET "profile_id" = lower("profile_id") WHERE "profile_id" <> lower("profile_id");--> statement-breakpoint
ALTER TABLE "lead_signals" DROP COLUMN "profile_spelling";--> statement-breakpoint
ALTER TABLE "candidate_research" DROP COLUMN "author";--> statement-breakpoint
ALTER TABLE "candidate_research" DROP COLUMN "author_read_at";--> statement-breakpoint
ALTER TABLE "leads" DROP COLUMN "profile_read";--> statement-breakpoint
ALTER TABLE "leads" DROP COLUMN "profile_read_at";--> statement-breakpoint
SET LOCAL row_security = on;
