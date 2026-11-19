// This process, and only this process, may rewrite the vault from the replica
// (`brain/mirror.ts#vaultMaterializeAllowedHere`). FIRST statement in the file —
// above the .env load and every dynamic import — so nothing it starts can read
// the variable unset. The dashboard, the chat-MCP child, `npm run worker` and
// `engager call` all leave it unset, and answer that predicate false.
process.env.ENGAGER_PROCESS_ROLE = "agent";

// The local "agent" process: the 5-minute node-cron scheduler tick AND the job
// worker in ONE process — one log stream, one memoized browser-use driver, so
// exactly one process holds the browser profile for all background work.
// `npm run worker` / `npm run scheduler` still run the halves separately.
import { existsSync } from "node:fs";
import { productVersion } from "@engager/common/version";
import { readyLine, workerStartupLine } from "./startupLog";

// loadEnvFile throws ENOENT when no .env exists — this checkout, worktrees,
// and CI have no repo-root .env.
if (existsSync(".env")) process.loadEnvFile?.(".env");
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
// Usage data (INV-19): which agent serves this install, and the once-per-start
// facts. Reports less rather than failing the boot. The plan and the relay
// origin read the licence gate, which core must not
// import, so this process passes them in.
const { startAgentTelemetry } = await import("@engager/core/telemetry/start");
const { managedAccess } = await import("@engager/billing/entitlementClient");
const { cloudBaseUrl } = await import("@engager/billing/cloudUrl");
await startAgentTelemetry({
  paid: () => managedAccess().allowed,
  relayOrigin: cloudBaseUrl,
});
// Problem reports (US-BUG-04) are sent from this process: where they go, as
// whom, and which address is the account's own are read from the same gate,
// which core cannot import, so they are registered here. Any other process that
// claims a report leaves it for this one.
const { registerReportSources } = await import("@engager/core/reports/sources");
const { reportAccountEmail, reportRelayTarget } = await import("@engager/billing/reportSources");
registerReportSources({ accountEmail: reportAccountEmail, relayTarget: reportRelayTarget });
const { materializeVaultMirrorAtBoot } = await import(
  "@engager/core/brain/mirror"
);
const replicaVersion = await materializeVaultMirrorAtBoot();
if (replicaVersion !== null) {
  console.log(`[agent] vault replica at v${replicaVersion}`);
}
const { startScheduler } = await import("@engager/core/jobs/scheduler");
const { runLoop } = await import("@engager/core/jobs/worker");
const { startBrowserBridge, stopBrowserBridge, eagerBrowserStart, markAgentReady } =
  await import("@engager/core/linkedin/browser-use/bridgeServer");
// The standing browser holder: one sidecar, one Chromium, held for this
// process's life and served to every other process over the loopback bridge.
// A laptop warms in the background so its launch flash happens at app start.
const bridge = await startBrowserBridge();
if (bridge) void eagerBrowserStart();
// Reproject in-force strategies when their document schema changes.
const { reprojectStrategiesInForce } = await import(
  "@engager/core/operations/reprojectStrategies"
);
try {
  const projected = await reprojectStrategiesInForce();
  for (const { campaignId, reason } of projected.stayed) {
    console.warn(`[agent] campaign ${campaignId} keeps the switches it had: ${reason}`);
  }
} catch (error) {
  console.warn("[agent] could not project strategies in force:", error);
}
await startScheduler();
// Keep this Mac awake, when the owner chose it: one `caffeinate` child held
// while the scheduler would wake a worker, tied to this process's life.
const { startKeepAwake } = await import("@engager/core/supervision/keepAwakeHolder");
const keepAwake = startKeepAwake();
const worker = runLoop({});
markAgentReady();
console.log(readyLine({ component: "agent", pid: process.pid, version: productVersion() }));
await worker;
// Held through the drain, harmlessly: `-w` ends the child with this process.
keepAwake.stop();
// Chrome goes with this process, cleanly: the bridge's stop sends the
// protocol `shutdown` (browser.stop) before the transport is reaped.
await stopBrowserBridge();
// Whatever usage data is still queued goes now; process.exit would drop it.
const { shutdownAnalytics } = await import("@engager/observability/analytics");
await shutdownAnalytics();
// Nothing of this process may outlive it. worker.ts's own runLoop already
// releases the browser profile on this same exit; the account's engagement
// authority is the second thing this process holds that outlives it by
// default, and releasing it here is the whole difference between "quit the
// app on the laptop and the desktop takes over in seconds" and "wait out the
// thirty-minute term".
// runLoop returns only on graceful shutdown (SIGTERM/SIGINT after finishing the
// current job). Exit explicitly — node-cron's timer and the pg pool's open
// sockets would otherwise keep the process alive.
process.exit(0);
export {}; // mark as a module so top-level await typechecks (TS1375)
