-- The hosted tenant fleet is gone from apps/cloud (provisioner, Fly and Neon
-- clients, the nine /api/tenant routes, both crons, the problem-report tenant
-- credential), so nothing reads or writes the cloud's record of a tenant's
-- runtime. Local installs hold no rows; the cloud database's fleet has been
-- idle since 17 Sep. Nothing references the table by foreign key.
DROP TABLE "tenant_runtimes" CASCADE;
