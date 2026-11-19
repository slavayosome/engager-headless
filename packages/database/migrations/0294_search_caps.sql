ALTER TABLE "channels" ADD COLUMN "daily_search_page_cap" bigint DEFAULT 150 NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "hourly_search_cap" bigint DEFAULT 80 NOT NULL;