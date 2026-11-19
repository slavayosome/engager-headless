-- Retired Find posts tables have no runtime readers or writers, and their rows are deleted with them (Find posts campaigns were already hidden); RESTRICT protects remaining foreign keys.
DROP TABLE "candidate_draft_requests";--> statement-breakpoint
DROP TABLE "candidate_mutation_receipts";--> statement-breakpoint
DROP TABLE "discovered_post_sources";--> statement-breakpoint
DROP TABLE "discovery_plans";--> statement-breakpoint
DROP TABLE "discovery_source_changes";--> statement-breakpoint
DROP TABLE "discovery_sources";--> statement-breakpoint
DROP TABLE "discovery_state";--> statement-breakpoint
DROP TABLE "lead_backtests";--> statement-breakpoint
DROP TABLE "radar_daily_opportunities";
