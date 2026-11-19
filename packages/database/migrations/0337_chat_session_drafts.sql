-- A draft conversation names the box it writes in, the angle its versions land on, and who it is for.
ALTER TABLE "chat_sessions" ADD COLUMN "box_key" text;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "box_position" integer;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "person_name" text;