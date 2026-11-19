// Pure helper for the local worker boot line. Kept side-effect-free (no env
// load, no DB, no API) so it is unit-testable; scripts/worker.ts logs the result.
export function workerStartupLine(env: {
  version: string;
  nodeVersion: string;
  pid: number;
  nodeEnv?: string;
}): string {
  return `[worker] booting (version=${env.version} node=${env.nodeVersion} pid=${env.pid} env=${env.nodeEnv ?? "development"})`;
}

// The supervisor's readiness signal (INV-20): NDJSON on stdout, never a human
// banner to scrape. JSON.stringify is the whole implementation, so the result
// is NDJSON by construction -- no embedded newline is possible.
export function readyLine(env: {
  component: string;
  pid: number;
  version: string;
}): string {
  return JSON.stringify({
    event: "ready",
    component: env.component,
    pid: env.pid,
    version: env.version,
  });
}
