-- C1 campaign-semantics data migration (JSONB edits only, no schema change).
--
-- 1. promo_ratio = 0 meant "use the objective default (~30%)" under the old
--    `override > 0` guard — the form even defaulted the field to 0. Under the new
--    semantics an explicit 0 means "never promote", so every legacy 0 must become
--    UNSET (null semantics) to preserve the behavior those rows actually had.
UPDATE campaigns
SET tone = tone - 'promo_ratio'
WHERE (tone ->> 'promo_ratio')::float = 0;--> statement-breakpoint

-- 2. tone.voice is retired: the learned profile voice is the single style
--    authority (it fought the per-campaign tone word inside one prompt).
UPDATE campaigns
SET tone = tone - 'voice'
WHERE tone ? 'voice';--> statement-breakpoint

-- 3. approval_mode 'hybrid' was never distinct from 'manual' in code (only
--    === 'auto' is checked anywhere) — collapse the illusion.
UPDATE campaigns
SET approval_mode = 'manual'
WHERE approval_mode = 'hybrid';
