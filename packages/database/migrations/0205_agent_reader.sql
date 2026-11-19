-- WHICH READER MADE A ROW. The agent reader — a model reading a LinkedIn
-- page, every identifier and word it cites verified against the page by the
-- server — stands behind the connector's markup parser for the reply thread
-- under our comment, the inbox and one conversation. Three columns say which
-- read answered: `incoming_comments.reader` and `inbox_reads.reader`, each
-- `parser` or `agent` with a constant default of `parser` and a CHECK every
-- existing row passes at that default, and `comment_watches.last_read_note`,
-- a nullable text the agent reader's check of a watch writes its note to.
-- Expand-only: no existing column, constraint or row moves.
ALTER TABLE "comment_watches" ADD COLUMN "last_read_note" text;--> statement-breakpoint
ALTER TABLE "inbox_reads" ADD COLUMN "reader" text DEFAULT 'parser' NOT NULL;--> statement-breakpoint
ALTER TABLE "incoming_comments" ADD COLUMN "reader" text DEFAULT 'parser' NOT NULL;--> statement-breakpoint
ALTER TABLE "inbox_reads" ADD CONSTRAINT "inbox_reads_reader_check" CHECK ("inbox_reads"."reader" in ('parser', 'agent'));--> statement-breakpoint
ALTER TABLE "incoming_comments" ADD CONSTRAINT "incoming_comments_reader_check" CHECK ("incoming_comments"."reader" in ('parser', 'agent'));
