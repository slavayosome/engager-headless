ALTER TABLE "profile" ALTER COLUMN "voice_channels" SET DEFAULT '{"linkedin":true,"brain":true}'::jsonb;--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "obsidian_vault_path";