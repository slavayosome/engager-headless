// The local half of the authority lease: file location, both access
// directions, the holder id mint, and a TTL-memoized hot-path bit. Modelled
// on the cache half of packages/billing/license.ts (licenseFilePath,
// readCachedLicense, writeCachedLicense, cachedLicenseEntitlement,
// resetLicenseEntitlementCache) and on packages/billing/licenseState.ts;
// those two files are the idiom this module follows rather than re-derives.
//
// Only cachedAuthorityHeld is enforcement input (INV-4/INV-18) — the lease
// inherits the license gate's own build-time-baked predicate rather than
// growing a second one. readAuthorityState is the display projection: no
// network, no async, and it re-derives nothing enforcement does not already
// hold.
import * as crypto from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Same directory licenseFilePath and installIdPath already own, and the same
// HOME_DIR as packages/cli/bin/engager.mjs. There is no env override for the
// location; a `path?` parameter is what tests use instead, the same shape
// licenseFilePath's comment already states.
export function authorityFilePath(): string {
  return path.join(os.homedir(), ".engager", "authority.json");
}

// heldUntil and blockedUntil are epoch MILLISECONDS (Date.now() units), not
// the seconds LicenseClaims.iat/exp carry -- they are client arithmetic over
// a duration the cloud returns (T-28.4), never a signed claim. Worth calling
// out beside the interface: this file sits next to license.ts, whose
// timestamps are seconds, and a reader who assumes seconds here gets a lease
// that expires in 1970.
export interface CachedAuthority {
  holderId: string;
  heldUntil: number;
  blockedUntil: number | null;
}

function isCachedAuthorityShape(value: unknown): value is CachedAuthority {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.holderId === "string" &&
    typeof c.heldUntil === "number" &&
    (c.blockedUntil === null || typeof c.blockedUntil === "number")
  );
}

// Never throws: a missing file, unparseable JSON, or a shape mismatch are all
// treated as an absent cache rather than an error.
export function readCachedAuthority(
  filePath: string = authorityFilePath()
): CachedAuthority | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isCachedAuthorityShape(parsed)) return null;
  return parsed;
}

let authorityHeldMemo: CachedAuthority | null | undefined;
let authorityHeldMemoAt = 0;

/** Test-only, and the write path's own invalidation: drop the memo so the
 * next call re-reads the cache file. */
export function resetAuthorityCache(): void {
  authorityHeldMemo = undefined;
  authorityHeldMemoAt = 0;
}

// T-28.4's claim response calls this writer; it never invents file shape.
// `writeFileSync`'s `mode` only applies when the file is CREATED, so a
// re-write over a pre-existing looser-permissioned file would otherwise leave
// the row world-readable -- the explicit chmodSync after the write closes
// that gap. 0600 is load-bearing here for its own reason: the holderId is the
// name the cloud knows this install by, and anything that can read it can ask
// the cloud to release the lease out from under the holder.
//
// Drops the hot-path memo: a successful claim must be visible to the very
// next cachedAuthorityHeld call, and a refusal cannot be papered over by a
// stale "held" for up to a minute (license.ts's writeCachedLicense does not
// do this -- a license exp is days away, a lease term is minutes).
export function writeCachedAuthority(
  cache: CachedAuthority,
  filePath: string = authorityFilePath()
): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(cache), { mode: 0o600 });
  chmodSync(filePath, 0o600);
  resetAuthorityCache();
}

// Sixteen random bytes as 32 lowercase hex -- the same shape as readInstallId
// in packages/observability/installId.ts, deliberately not the same value.
// Reusing ~/.engager/install-id would let the cloud join anonymous telemetry
// events -- which arrive at apps/cloud/app/api/telemetry/route.ts keyed on
// exactly that id -- to an authenticated organization, which is what a lease
// claim carries. That collapses precisely the anonymity T-27.1's module doc
// promises when it says the id must identify an install and nothing else.
// (The package graph already leans the same way -- @engager/observability
// depends on @engager/billing, so the reuse import would also close a cycle
// -- but the anonymity reason above is the one that matters.)
//
// Minted and persisted before it is ever used: minting without persisting
// looks simpler and is not -- a claim whose response is lost leaves the
// cloud holding id A while the next attempt mints id B, and B is refused for
// a full term by the install's own ghost. readInstallId's mint-then-write is
// the same argument.
export function readOrMintHolderId(filePath?: string): string {
  const existing = readCachedAuthority(filePath);
  if (existing) return existing.holderId;

  const holderId = crypto.randomBytes(16).toString("hex");
  writeCachedAuthority({ holderId, heldUntil: 0, blockedUntil: null }, filePath);
  return holderId;
}

const AUTHORITY_HELD_TTL_MS = 60_000;

// The hot-path read: canEngage() (packages/core/ratelimit/ledger.ts) runs per
// send, so this memoizes the parsed ROW for AUTHORITY_HELD_TTL_MS rather than
// reading the filesystem on every call. Contract, not optimization, the
// words cachedLicenseEntitlement already uses.
//
// Order: gate-off inertia first -- return true and read nothing -- THEN the
// memo, then the clock comparison. A checkout has no cloud identity to claim
// a lease from, so a fence that cannot be satisfied there would silence
// every worker in the repo's own suites and on every developer machine
// (INV-18).
//
// One deliberate deviation from cachedLicenseEntitlement's shape: the memo
// caches the row, not the answer, and the clock comparison runs on every
// call. Memoizing the boolean would keep answering "held" for up to a minute
// past heldUntil -- and the term boundary is the one instant this whole
// phase exists to make sharp.
export function cachedAuthorityHeld(opts: { now?: Date; path?: string } = {}): boolean {
  // Deprecated diagnostic cache. It can never authorize runtime execution.
  if (!opts.path) return false;
  const now = opts.now ?? new Date();
  if (
    authorityHeldMemo === undefined ||
    now.getTime() - authorityHeldMemoAt >= AUTHORITY_HELD_TTL_MS
  ) {
    authorityHeldMemo = readCachedAuthority(opts.path);
    authorityHeldMemoAt = now.getTime();
  }
  if (!authorityHeldMemo) return false;
  return authorityHeldMemo.heldUntil > now.getTime();
}

// readLicenseGateState's shape and for its reason: enforcement reads the
// bit, the dashboard reads the state. No network and no async -- this is
// what a dashboard request path calls, and a fetch inside a page render is a
// defect (licenseState.ts's own header). It lives in this module rather
// than a sibling authorityState.ts because, unlike readLicenseState, it
// re-derives nothing: heldUntil and blockedUntil are the same two fields the
// bit reads, so there is no second source of truth to hold apart.
export type AuthorityState = "off" | "held" | "elsewhere" | "missing";

export function readAuthorityState(
  opts: { now?: Date; path?: string } = {}
): AuthorityState {
  if (!opts.path) return "missing";
  const now = opts.now ?? new Date();
  const cache = readCachedAuthority(opts.path);
  if (!cache) return "missing";

  // Checked before blockedUntil, so the state screen can never say
  // "elsewhere" while cachedAuthorityHeld returns true -- a display
  // contradicting the gate is worse than a stale display.
  if (cache.heldUntil > now.getTime()) return "held";
  if (cache.blockedUntil !== null && cache.blockedUntil > now.getTime()) return "elsewhere";
  return "missing";
}
