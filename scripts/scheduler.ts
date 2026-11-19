// Local node-cron scheduler for the Postgres SaaS runtime (dev / VPS). The
// serverless deployment uses /api/cron/tick (Vercel Cron) instead.
process.loadEnvFile?.(".env");
const { assertNonSuperuserRole } = await import("@engager/database/guard");
await assertNonSuperuserRole();
const { startScheduler } = await import("@engager/core/jobs/scheduler");
await startScheduler();
export {}; // mark as a module so top-level await typechecks (TS1375)
