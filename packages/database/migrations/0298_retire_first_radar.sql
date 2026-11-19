-- First Radar onboarding is retired (US-RET-04): nothing reads or writes its
-- preview, response or budget tables any more, and the dashboard, the MCP tools
-- and the jobs that used them are gone.
DROP TABLE "onboarding_preview_budgets" CASCADE;--> statement-breakpoint
DROP TABLE "onboarding_radar_previews" CASCADE;--> statement-breakpoint
DROP TABLE "onboarding_radar_responses" CASCADE;