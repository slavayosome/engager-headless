-- A LIKE RIDES WITH THE SEND IT BELONGS TO. Two nullable columns on
-- `messages`: whether the like a send's step binds goes out with it, on the
-- same yes (`like_with_send`), and what became of that like once the send
-- went out (`like_outcome`). Expand-only: nothing existing moves, and NULL in
-- either is what every row already had.
ALTER TABLE "messages" ADD COLUMN "like_with_send" boolean;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "like_outcome" jsonb;
