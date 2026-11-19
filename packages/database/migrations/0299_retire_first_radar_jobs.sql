-- The jobs the First Radar and runner code ran have no handler any more
-- (US-RET-04, US-RET-08), so their rows go with them. `jobs` is outside RLS, so
-- the delete reaches every organization, and it matches nothing on a second pass.
DELETE FROM jobs WHERE type IN ('onboarding_radar_preview', 'onboarding_setup_proof', 'calibrate_voice', 'reconcile_first_radar_residue', 'cleanup_runner_work');
