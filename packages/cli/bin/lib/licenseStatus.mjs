// What `engager doctor` says about this machine's cached license. Beside
// localEnv.mjs and prereqs.mjs -- the established shape for logic the bin
// needs but cannot test through doctor() itself, which calls process.exit
// and shells out to `claude mcp list` and a live MCP round-trip.
//
// DISPLAY ONLY (INV-17): this decodes the cached token's payload segment
// without verifying its Ed25519 signature. `engager.mjs` is dependency-free
// plain JS -- it is not in build.mjs's ENTRIES, so nothing bundles it and it
// cannot import verifyLicenseToken from packages/core/entitlements/license.ts.
// Duplicating the baked public key and the verify logic here would be a
// second implementation of a wire format that module owns alone. Reading
// `exp` and `entitled` for display is exactly what INV-17 licenses;
// enforcement verifies at the entitlement seam and never consults doctor.
//
// The honest residual: a tampered or forged file reads "valid" here while
// enforcement lapses. For a read-only health hint that is the better trade
// than a second verifier drifting from the first.
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function base64UrlDecode(input) {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + padding, "base64").toString("utf8");
}

/**
 * The `→` line doctor() prints for the license, derived without touching the
 * database or the network. Never throws -- a doctor that crashes on a corrupt
 * file is worse than one that says "unreadable" -- and tolerates a missing
 * file, bad JSON, or a shape mismatch exactly as readCachedLicense
 * (packages/core/entitlements/license.ts) does, since it reads the same CachedLicense
 * shape.
 *
 * `now` and `filePath` are parameters for the same reason localEnv.mjs's
 * `ensureLocalEnv` takes its `envFile` as an argument rather than resolving
 * one: it is what makes this drivable from a test with no home directory and
 * no wall clock. doctor() calls it with neither override.
 */
export function licenseStatusLine(
  now,
  // Matches HOME_DIR in engager.mjs and licenseFilePath() in
  // packages/core/entitlements/license.ts -- three places this location is spelled.
  filePath = path.join(os.homedir(), ".engager", "license.json"),
) {
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return "→ no cached license on this machine";
  }
  let cache;
  try {
    cache = JSON.parse(raw);
  } catch {
    return "→ no cached license on this machine";
  }
  if (typeof cache?.token !== "string") {
    return "→ no cached license on this machine";
  }

  let claims;
  try {
    claims = JSON.parse(base64UrlDecode(cache.token.split(".")[0]));
  } catch {
    return "→ cached license present but its token is unreadable";
  }

  if (typeof claims?.exp !== "number" || !Number.isFinite(claims.exp)) {
    return "→ cached license present but its token is unreadable";
  }

  const expiresOn = new Date(claims.exp * 1000).toISOString().slice(0, 10);
  if (claims.exp * 1000 < now.getTime()) {
    return `→ cached license expired ${expiresOn}`;
  }
  return `→ cached license: entitled=${claims.entitled}, expires ${expiresOn}`;
}
