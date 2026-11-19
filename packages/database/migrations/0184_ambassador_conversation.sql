ALTER TABLE "workers" DROP CONSTRAINT "workers_enabled_does_something_check";--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "conversation_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workers" ADD CONSTRAINT "workers_enabled_does_something_check" CHECK (not "workers"."enabled"
        or ("workers"."kind" = 'scout' and "workers"."sweep_enabled")
        or ("workers"."kind" = 'commenter' and ("workers"."draft_enabled" or "workers"."publish_enabled" or "workers"."conversation_enabled")));