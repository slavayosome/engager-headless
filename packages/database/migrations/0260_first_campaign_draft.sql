-- THE FIRST-CAMPAIGN WIZARD'S WORKING COPY (US-ONG-01). The line, the agent's
-- draft and the depth live here while the owner answers, so a quit and
-- relaunch comes back to the screen last reached. Expand-only: one nullable
-- column, every existing row null. The cloud runs this too and leaves it null.
ALTER TABLE "organizations" ADD COLUMN "first_campaign_draft" jsonb;
