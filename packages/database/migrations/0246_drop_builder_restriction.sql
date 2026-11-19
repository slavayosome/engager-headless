-- RESEARCH NO LONGER CARRIES A BUILDER RESTRICTION. 0228 stamped
-- `legacyResearchRestriction: "product_builder"` on every profile it moved, and
-- the read adapter stamped it on every campaign created without a structured
-- audience; Research then told its model the author must build or ship a
-- product. Nothing reads the key now, and the strict audience schema would
-- refuse a profile or history row that still carried it on save or restore,
-- so it leaves both.
--
-- The relevance rule, the Audience revision and every verdict stamped with it
-- stay as they are: the restriction never entered `ai_filter.instruction`, and
-- removing it only widens who fits, so an existing confirmation still holds.
-- Re-runnable: the predicate matches nothing on a second pass.
UPDATE "campaigns"
   SET "audience_profile" = "audience_profile" - 'legacyResearchRestriction'
 WHERE "audience_profile" ? 'legacyResearchRestriction';
--> statement-breakpoint
UPDATE "campaign_audience_revisions"
   SET "profile" = "profile" - 'legacyResearchRestriction'
 WHERE "profile" ? 'legacyResearchRestriction';
