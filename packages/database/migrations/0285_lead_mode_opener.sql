ALTER TABLE "composer_drafts" DROP CONSTRAINT "composer_drafts_values_check";--> statement-breakpoint
ALTER TABLE "draft_plans" ADD COLUMN "box_key" text;--> statement-breakpoint
ALTER TABLE "composer_drafts" ADD CONSTRAINT "composer_drafts_values_check" CHECK ("composer_drafts"."position" >= 1 and "composer_drafts"."revision" >= 1
    and char_length("composer_drafts"."angle") between 1 and 24 and ("composer_drafts"."angle_why" is null or char_length("composer_drafts"."angle_why") <= 160)
    and "composer_drafts"."box_key" ~ '^(comment|reply|room|invite|dm|lead):.+');