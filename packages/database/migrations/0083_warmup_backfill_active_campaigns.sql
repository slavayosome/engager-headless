-- Pre-plan active campaigns carry warmup_weeks but a NULL warmup_started_at,
-- so warmupFactor() returned full capacity while the Auto-post activation
-- invariant (completedWarmupAt) could never be satisfied for them. Backdate
-- the start by the campaign's own warmup window: legacy rows are treated as
-- already warmed (factor stays 1 — zero live behavior change for the
-- founder's running campaigns) while making the invariant satisfiable.
-- Activation paths set warmup_started_at for every new/reactivated campaign
-- since the truth-and-safety release, so this is a one-shot expand-only
-- backfill; reruns match zero rows.
UPDATE "campaigns"
SET "warmup_started_at" =
  (extract(epoch from now()) * 1000)::bigint
    - ("warmup_weeks"::bigint * 7 * 24 * 60 * 60 * 1000)
WHERE "status" = 'active'
  AND "warmup_started_at" IS NULL;
