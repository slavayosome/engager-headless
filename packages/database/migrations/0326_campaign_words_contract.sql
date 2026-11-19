DO $$ BEGIN
  IF current_setting('is_superuser') <> 'on' AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolbypassrls) THEN
    RAISE EXCEPTION 'Contract migration requires a role with BYPASSRLS';
  END IF;
END $$;
--> statement-breakpoint
UPDATE organizations SET onboarding_step = 'campaign' WHERE onboarding_step = 'target';
--> statement-breakpoint
UPDATE tasks SET context = jsonb_set(context, '{input}',
  (((context->'input') - 'targetId') - 'targetName') ||
  CASE WHEN ((context->'input') ? 'targetId') AND NOT ((context->'input') ? 'campaignId') THEN jsonb_build_object('campaignId', ((context->'input')->'targetId')) ELSE '{}'::jsonb END ||
  CASE WHEN ((context->'input') ? 'targetName') AND NOT ((context->'input') ? 'campaignName') THEN jsonb_build_object('campaignName', ((context->'input')->'targetName')) ELSE '{}'::jsonb END)
WHERE jsonb_typeof(context->'input') = 'object' AND (((context->'input') ? 'targetId') OR ((context->'input') ? 'targetName'));
