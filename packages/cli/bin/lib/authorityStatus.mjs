// What `engager doctor` says about this machine's cached authority lease.
// Beside licenseStatus.mjs -- the established shape for logic the bin needs
// but cannot test through doctor() itself, which calls process.exit and
// shells out to `claude mcp list` and a live MCP round-trip.
//
// DISPLAY ONLY: this reads the flat `authority.json` cache
// (packages/billing/authority.ts's `CachedAuthority`) by hand rather than
// importing `readAuthorityState`. `engager.mjs` is dependency-free plain
// JS -- it is not in build.mjs's ENTRIES, so nothing bundles it and it
// cannot import from packages/billing. Duplicating the shape here is a
// second reader of a row that module owns alone, but the alternative is no
// reader at all in the packaged bin.
//
// Never a ✗ or a ✓: an install with no authority on a checkout is healthy,
// and doctor cannot know whether THIS build is gated -- the same reason
// already written beside the license line.
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function isCachedAuthorityShape(value) {
  if (typeof value !== "object" || value === null) return false;
  return (
    typeof value.holderId === "string" &&
    typeof value.heldUntil === "number" &&
    (value.blockedUntil === null || typeof value.blockedUntil === "number")
  );
}

// The widest epoch millisecond `new Date(...)` accepts without going Invalid
// -- ±8,640,000,000,000,000 (ECMA-262 20.4.1.1). `Number.isFinite` alone
// misses this: 1e300 and 8.64e15+1 both pass it and both still hand
// `.toISOString()` an Invalid Date, which throws `RangeError: Invalid time
// value` rather than returning a string.
const MAX_VALID_DATE_MS = 8_640_000_000_000_000;

function isFiniteEpochMs(value) {
  return Number.isFinite(value) && Math.abs(value) <= MAX_VALID_DATE_MS;
}

/**
 * The `→` line doctor() prints for the authority lease, derived without
 * touching the database or the network. Never throws -- a doctor that
 * crashes on a corrupt file is worse than one that says "unreadable" -- and
 * tolerates a missing file, bad JSON, or a shape mismatch the same way
 * `readCachedAuthority` (packages/billing/authority.ts) does, since it reads
 * the same `CachedAuthority` shape.
 *
 * `now` and `filePath` are parameters for the same reason
 * `licenseStatusLine`'s are: it is what makes this drivable from a test with
 * no home directory and no wall clock. doctor() calls it with neither
 * override.
 */
export function authorityStatusLine(
  now,
  // Matches HOME_DIR in engager.mjs and authorityFilePath() in
  // packages/billing/authority.ts -- three places this location is spelled.
  filePath = path.join(os.homedir(), ".engager", "authority.json"),
) {
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return "→ no authority recorded on this machine";
  }
  let cache;
  try {
    cache = JSON.parse(raw);
  } catch {
    return "→ no authority recorded on this machine";
  }
  if (!isCachedAuthorityShape(cache)) {
    return "→ authority cache present but unreadable";
  }
  // Both fields feed `new Date(...)` (heldUntil directly below, blockedUntil
  // by the same reasoning even though this line never formats it) or gate a
  // branch that does -- a shape-valid but out-of-range number is exactly the
  // corrupt row this line exists to catch rather than crash doctor() on.
  if (!isFiniteEpochMs(cache.heldUntil)) {
    return "→ authority cache present but unreadable";
  }
  if (cache.blockedUntil !== null && !isFiniteEpochMs(cache.blockedUntil)) {
    return "→ authority cache present but unreadable";
  }

  const nowMs = now.getTime();
  if (cache.heldUntil > nowMs) {
    return `→ this install holds the account's authority until ${new Date(cache.heldUntil).toISOString()}`;
  }
  if (cache.blockedUntil !== null && cache.blockedUntil > nowMs) {
    return "→ another install holds this account's authority";
  }
  // `heldUntil: 0` is not a lease that ran out -- it is the row
  // `readOrMintHolderId` (packages/billing/authority.ts) writes before the
  // FIRST claim ever succeeds, the same row `readAuthorityState` there
  // already answers "missing" for rather than "elsewhere". Falling through
  // to the lapsed line below would tell an install that has never claimed
  // anything that its lease "lapsed at 1970-01-01T00:00:00.000Z" -- true of
  // the epoch, not of this install.
  if (cache.heldUntil === 0) {
    return "→ no lease claimed yet on this machine";
  }
  // A row IS present here -- it is not "no authority recorded on this
  // machine", which is what a checkout that never claimed at all reads.
  // `heldUntil` in the past with `blockedUntil` null (or also in the past)
  // is a lease that ran out rather than one that was never minted.
  return `→ this install's authority lease lapsed at ${new Date(cache.heldUntil).toISOString()} — no install currently holds it`;
}
