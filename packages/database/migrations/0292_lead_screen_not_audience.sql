ALTER TABLE "automation_runs" DROP CONSTRAINT "automation_runs_lead_counts_check";--> statement-breakpoint
ALTER TABLE "lead_signals" DROP CONSTRAINT "lead_signals_values_check";--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "lead_drop_not_audience_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_lead_counts_check" CHECK ("automation_runs"."lead_read_count" >= 0 and "automation_runs"."lead_found_count" >= 0 and "automation_runs"."lead_screened_in_count" >= 0
        and "automation_runs"."lead_researched_count" >= 0 and "automation_runs"."lead_research_deferred_count" >= 0
        and "automation_runs"."lead_served_asking_count" >= 0 and "automation_runs"."lead_served_problem_count" >= 0 and "automation_runs"."lead_served_topic_count" >= 0
        and "automation_runs"."lead_merged_count" >= 0 and "automation_runs"."lead_drop_no_words_count" >= 0 and "automation_runs"."lead_drop_not_audience_count" >= 0
        and "automation_runs"."lead_drop_selling_count" >= 0 and "automation_runs"."lead_drop_solved_count" >= 0 and "automation_runs"."lead_drop_recruiter_count" >= 0 and "automation_runs"."lead_drop_student_count" >= 0
        and "automation_runs"."lead_buyer_count" >= 0 and "automation_runs"."lead_not_fit_count" >= 0 and "automation_runs"."lead_peer_count" >= 0
        and "automation_runs"."lead_partner_count" >= 0 and "automation_runs"."search_pages_count" >= 0 and "automation_runs"."thread_reads_count" >= 0
        and "automation_runs"."profile_reads_count" >= 0);--> statement-breakpoint
ALTER TABLE "lead_signals" ADD CONSTRAINT "lead_signals_values_check" CHECK ("lead_signals"."person_key" ~ '^[pm][.]'
        and "lead_signals"."kind" in ('post', 'comment') and ("lead_signals"."kind" = 'comment') = ("lead_signals"."comment_urn" is not null)
        and ("lead_signals"."language_type" is null or "lead_signals"."language_type" in ('pain', 'desired_outcome', 'failed_alternative', 'comparison', 'direct_ask'))
        and "lead_signals"."verdict" in ('pending', 'passed', 'dropped', 'expired', 'unscreenable')
        and ("lead_signals"."role" is null or "lead_signals"."role" in ('buyer', 'peer', 'competitor', 'partner', 'noise'))
        and ("lead_signals"."drop_reason" is null or "lead_signals"."drop_reason" in ('no_own_words', 'not_audience', 'selling_similar', 'already_solved', 'recruiter', 'student'))
        and ("lead_signals"."verdict" = 'dropped') = ("lead_signals"."drop_reason" is not null));