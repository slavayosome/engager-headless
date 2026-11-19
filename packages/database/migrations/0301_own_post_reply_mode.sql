-- Custom SQL migration file, put your code below! --
UPDATE "organizations"
SET "own_post_replies" = jsonb_build_object(
  'mode', CASE
    WHEN "own_post_replies" IS NULL OR "own_post_replies"->>'enabled' = 'false' THEN 'off'
    WHEN "own_post_replies"->>'approval_mode' = 'auto' THEN 'auto'
    ELSE 'review'
  END,
  'sensitivity_gate', COALESCE("own_post_replies"->'sensitivity_gate', 'true'::jsonb),
  'prompt', COALESCE("own_post_replies"->'prompt', '"Reply warmly, answer the question, never pitch."'::jsonb)
);
