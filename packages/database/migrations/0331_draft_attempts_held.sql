ALTER TABLE "draft_attempts" DROP CONSTRAINT "draft_attempts_values_check";--> statement-breakpoint
ALTER TABLE "draft_attempts" ADD CONSTRAINT "draft_attempts_values_check" CHECK ("draft_attempts"."attempt" between 1 and 2
    and "draft_attempts"."outcome" in ('admitted', 'rewrite', 'withheld', 'held', 'discarded')
    and ("draft_attempts"."outcome" in ('admitted', 'held') or "draft_attempts"."reason" is not null));