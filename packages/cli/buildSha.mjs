// The commit a build is cut from, for the __ENGAGER_BUILD_SHA__ define that
// packages/common/build-sha.ts reads. Build-machine time only: the artifact
// carries the literal, never this read. An explicit ENGAGER_BUILD_SHA wins (CI
// exports the release commit); otherwise the checkout's HEAD; otherwise
// "unknown", which telemetry reports as such.
import { spawnSync } from "node:child_process";

export function buildSha(cwd) {
  const explicit = process.env.ENGAGER_BUILD_SHA?.trim();
  if (explicit && /^[0-9a-f]{7,40}$/i.test(explicit)) return explicit.toLowerCase();
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", timeout: 5_000 });
  const out = head.status === 0 ? head.stdout.trim() : "";
  return /^[0-9a-f]{40}$/.test(out) ? out : "unknown";
}
