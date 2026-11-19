DO $$ BEGIN
  IF current_setting('is_superuser') <> 'on' AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolbypassrls) THEN
    RAISE EXCEPTION 'Contract migration requires a role with BYPASSRLS';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE workers DROP CONSTRAINT workers_kind_check;
--> statement-breakpoint
ALTER TABLE workers DROP CONSTRAINT workers_enabled_does_something_check;
--> statement-breakpoint
UPDATE workers SET kind = 'ambassador' WHERE kind = 'commenter';
--> statement-breakpoint
ALTER TABLE workers ALTER COLUMN kind SET DEFAULT 'ambassador';
--> statement-breakpoint
ALTER TABLE workers ADD CONSTRAINT workers_kind_check CHECK (kind IN ('scout', 'ambassador'));
--> statement-breakpoint
ALTER TABLE workers ADD CONSTRAINT workers_enabled_does_something_check CHECK (NOT enabled OR (kind = 'scout' AND sweep_enabled) OR (kind = 'ambassador' AND (draft_enabled OR publish_enabled OR conversation_enabled)));
--> statement-breakpoint
ALTER TABLE incoming_comments RENAME COLUMN commenter_profile_id TO author_profile_id;
--> statement-breakpoint
ALTER TABLE incoming_comments RENAME COLUMN commenter_member_urn TO author_member_urn;
--> statement-breakpoint
ALTER TABLE incoming_comments RENAME COLUMN commenter_name TO author_name;
