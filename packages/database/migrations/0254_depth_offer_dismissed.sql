-- WHETHER THE OWNER KEPT A QUICK CAMPAIGN QUICK. One nullable column on
-- `campaigns`: when the owner pressed Keep Quick on Overview's offer to run a
-- Quick campaign every day at Standard, once its first look finished, so the
-- offer does not come back. Epoch milliseconds, as every moment on the row.
-- Expand-only: no existing column, constraint or row moves, and every
-- campaign, existing ones included, reads null — never answered so.
ALTER TABLE "campaigns" ADD COLUMN "depth_offer_dismissed_at" bigint;