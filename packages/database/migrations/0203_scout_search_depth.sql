-- THE SCOUT READS EACH SEARCH AS ITS PLAN DECIDES. Five defaulted columns on
-- `discovery_sources`: `pages_per_sweep` (how deep one sweep reads, 1-15),
-- `sort` (relevance | latest), `date_posted` (past_day | past_week |
-- past_month), `owner_set` (which of those the owner set by hand, so the plan
-- leaves them alone) and `last_sweep_pages` (what its latest sweep read).
-- Expand-only: no existing column, constraint or row moves, and every existing
-- search reads 5 pages by relevance over the past week until its plan or its
-- owner says otherwise.
ALTER TABLE "discovery_sources" ADD COLUMN "pages_per_sweep" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "discovery_sources" ADD COLUMN "sort" text DEFAULT 'relevance' NOT NULL;--> statement-breakpoint
ALTER TABLE "discovery_sources" ADD COLUMN "date_posted" text DEFAULT 'past_week' NOT NULL;--> statement-breakpoint
ALTER TABLE "discovery_sources" ADD COLUMN "owner_set" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "discovery_sources" ADD COLUMN "last_sweep_pages" integer DEFAULT 0 NOT NULL;
