-- A CONVERSATION THE OWNER HAS WITH SOMEONE ENGAGER KNOWS IS HELD FOR THEM.
-- The inbox list binds it to the person's journey and marks the conversation
-- itself held (`owner_held_at`): nothing opens it, no model reads it and no DM
-- goes into it, while the person's journey — and the public thread under our
-- comments — goes on as before. People shows it by what the list carried: how
-- many messages LinkedIn counts unread in it and when its newest was sent,
-- which every list read keeps on every conversation it shows that has a row,
-- and the person's newest message there (`held_message_text`, `_at`), kept on
-- a held conversation alone.
-- Expand-only: five nullable columns, null on every existing row until the
-- next list read; no existing column, constraint or row changes, and old code
-- never names them.
ALTER TABLE "dm_threads" ADD COLUMN "unread_count" integer;--> statement-breakpoint
ALTER TABLE "dm_threads" ADD COLUMN "last_message_at" bigint;--> statement-breakpoint
ALTER TABLE "dm_threads" ADD COLUMN "owner_held_at" bigint;--> statement-breakpoint
ALTER TABLE "dm_threads" ADD COLUMN "held_message_text" text;--> statement-breakpoint
ALTER TABLE "dm_threads" ADD COLUMN "held_message_at" bigint;
