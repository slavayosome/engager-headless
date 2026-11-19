ALTER TABLE "lead_signals" DROP CONSTRAINT "lead_signals_values_check";--> statement-breakpoint
ALTER TABLE "lead_signals" ADD COLUMN "tries" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "read_tries" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "judge_tries" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "pipeline_hold" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "pipeline_hold_note" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "lead_screen_rule" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "lead_signals" ADD CONSTRAINT "lead_signals_values_check" CHECK ("lead_signals"."person_key" ~ '^[pm][.]'
        and "lead_signals"."kind" in ('post', 'comment') and ("lead_signals"."kind" = 'comment') = ("lead_signals"."comment_urn" is not null)
        and ("lead_signals"."language_type" is null or "lead_signals"."language_type" in ('pain', 'desired_outcome', 'failed_alternative', 'comparison', 'direct_ask'))
        and "lead_signals"."verdict" in ('pending', 'passed', 'dropped', 'expired', 'unscreenable')
        and ("lead_signals"."role" is null or "lead_signals"."role" in ('buyer', 'peer', 'competitor', 'partner', 'noise'))
        and ("lead_signals"."drop_reason" is null or "lead_signals"."drop_reason" in ('no_own_words', 'selling_similar', 'already_solved', 'recruiter', 'student'))
        and ("lead_signals"."verdict" = 'dropped') = ("lead_signals"."drop_reason" is not null));--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_pipeline_hold_check" CHECK ("leads"."pipeline_hold" is null or "leads"."pipeline_hold" in ('unread', 'unjudged'));