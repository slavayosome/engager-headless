-- A DELETED CAMPAIGN: the owner's `deleteCampaign` stamps `deleted_at`, and
-- every list reads only the rows where it is null. Additive and nullable: no
-- existing row, column or constraint moves, and a build before this one never
-- reads the column.
ALTER TABLE "campaigns" ADD COLUMN "deleted_at" bigint;
