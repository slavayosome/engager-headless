ALTER TABLE "composer_drafts" DROP CONSTRAINT "composer_drafts_state_check";--> statement-breakpoint
ALTER TABLE "composer_drafts" ADD CONSTRAINT "composer_drafts_state_check" CHECK (("composer_drafts"."state" = 'ready' and "composer_drafts"."text" is not null)
    or ("composer_drafts"."state" in ('writing', 'idea') and "composer_drafts"."text" is null) or "composer_drafts"."state" = 'failed');