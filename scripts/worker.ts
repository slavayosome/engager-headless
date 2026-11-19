// Local long-running worker for the Postgres SaaS runtime (dev / VPS). The
// serverless deployment uses /api/jobs/drain instead. With no driver supplied,
// each job resolves its own per-org driver inside runOnce.
import { productVersion } from "@engager/common/version";
import { workerStartupLine } from "./startupLog";

process.loadEnvFile?.(".env");
console.log(
  workerStartupLine({
    version: productVersion(),
    nodeVersion: process.version,
    pid: process.pid,
    nodeEnv: process.env.NODE_ENV,
  }),
);
const { assertNonSuperuserRole } = await import("@engager/database/guard");
await assertNonSuperuserRole(); // refuse to run as a superuser (bypasses RLS)
// The agent's half of problem reports (`scripts/agent.ts` says why): this worker
// claims `file_bug_report` too, and would otherwise hand every one back.
const { registerReportSources } = await import("@engager/core/reports/sources");
const { reportAccountEmail, reportRelayTarget } = await import("@engager/core/entitlements/reportSources");
registerReportSources({ accountEmail: reportAccountEmail, relayTarget: reportRelayTarget });
const { runLoop } = await import("@engager/core/jobs/worker");
await runLoop({});
// runLoop returns only on graceful shutdown (SIGTERM/SIGINT after finishing the
// current job). Exit explicitly — the pg pool's open sockets would otherwise keep
// the process alive until systemd escalates to SIGKILL.
process.exit(0);
export {}; // mark as a module so top-level await typechecks (TS1375)
