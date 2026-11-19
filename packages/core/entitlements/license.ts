// The license token wire format, defined ONCE: claims schema, Ed25519 sign,
// Ed25519 verify. Phase 16's issuance imports signLicenseToken and
// LicenseClaims from here rather than re-implementing the wire shape.
//
// Only `entitled` is enforcement input (INV-17) — `plan`, `status`,
// `trialEndsAt`, and `periodEndsAt` are display material only; no code in
// this module branches on them.
//
// The `publicKey` override in verifyLicenseToken is accepted only when
// licenseRequired() (the build-time-baked gate constant) returns false. On a
// gated machine ENGAGER_DEPLOYMENT_ENV lives in user-writable
// ~/.engager/.env, so the gate predicate must never read it — see INV-18 and
// packages/core/entitlements/licenseMode.ts.
import * as crypto from "node:crypto";
import type { KeyObject } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { licenseRequired } from "./licenseMode";
import { withLicenseRefreshLock } from "./licenseRefreshLock";

export interface LicenseClaims {
  v: 1;
  org: string;
  entitled: boolean;
  plan: string;
  status: string;
  trialEndsAt: number | null;
  periodEndsAt: number | null;
  iat: number;
  exp: number;
}

export type LicenseVerification =
  | { valid: true; entitled: boolean; claims: LicenseClaims }
  | {
      valid: false;
      reason:
        | "malformed"
        | "bad_signature"
        | "unsupported_version"
        | "expired"
        | "clock_rollback";
    };

// Ed25519 public key (base64 SPKI DER), committed as a literal constant so
// every build carries it. The matching private half is held out-of-band by
// the founder for Phase 16 issuance and is never committed — not here, not
// in a fixture, not in a test.
//
// Rotated 2026-08-28 for the first cloud deploy: the phase-15 constant's
// private half turned out to exist nowhere, so it could never have signed a
// token any build accepts. No public build ever shipped the old constant, so
// nothing in the field is invalidated by the swap.
export const ENGAGER_LICENSE_PUBLIC_KEY =
  "MCowBQYDK2VwAyEAF3FJIFsh9yd703xxeD6V6WbUjBIIM2p5G433E0l9wY8=";

// Supplied only by the isolated rehearsal build. Shipped production builds
// retain the constant above; process.env is never a verifying-key authority.
declare const __ENGAGER_REHEARSAL_LICENSE_PUBLIC_KEY__: string;

let bakedPublicKey: KeyObject | undefined;

/** The verifying key every build carries. Exported for the v2 capability
 * reader (`./entitlementCache.ts`), which takes its key as a parameter rather
 * than reaching for a module-scoped one — a fixture needs to substitute it, and
 * the same override rule applies there as here. */
export function licensePublicKey(): KeyObject {
  return getBakedPublicKey();
}

function getBakedPublicKey(): KeyObject {
  if (!bakedPublicKey) {
    bakedPublicKey = crypto.createPublicKey({
      key: Buffer.from(typeof __ENGAGER_REHEARSAL_LICENSE_PUBLIC_KEY__ === "undefined"
        ? ENGAGER_LICENSE_PUBLIC_KEY : __ENGAGER_REHEARSAL_LICENSE_PUBLIC_KEY__, "base64"),
      format: "der",
      type: "spki",
    });
  }
  return bakedPublicKey;
}

function base64UrlEncode(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding =
    padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + padding, "base64");
}

// Narrows shape only — `v` is checked for type here (so an unknown-version
// payload still parses) and checked for value === 1 separately by the caller,
// per the verify order: decode → verify signature → parse/narrow → reject
// v !== 1 → reject timestamps.
function isLicenseClaimsShape(value: unknown): value is LicenseClaims {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.v === "number" &&
    typeof c.org === "string" &&
    typeof c.entitled === "boolean" &&
    typeof c.plan === "string" &&
    typeof c.status === "string" &&
    (c.trialEndsAt === null || typeof c.trialEndsAt === "number") &&
    (c.periodEndsAt === null || typeof c.periodEndsAt === "number") &&
    typeof c.iat === "number" &&
    typeof c.exp === "number"
  );
}

export function signLicenseToken(
  claims: LicenseClaims,
  privateKey: KeyObject,
): string {
  const payloadSegment = base64UrlEncode(
    Buffer.from(JSON.stringify(claims), "utf8"),
  );
  const signature = crypto.sign(
    null,
    Buffer.from(payloadSegment, "utf8"),
    privateKey,
  );
  return `${payloadSegment}.${base64UrlEncode(signature)}`;
}

const ONE_DAY_SECONDS = 24 * 60 * 60;
/** How far ahead of THIS clock a token's `iat` may sit and still verify.
 * The cloud mints `iat` from its own clock; a customer Mac a second behind
 * it (measured 2026-09-03: the cloud led by ~1 s) read every freshly
 * minted token as a clock rollback, dropped it -- and the refresh that
 * fetched it had already revoked its parent server-side, so the install
 * was left with a consumed refresh token and `invalid_grant` forever. Five
 * minutes is the JWT-world's customary leeway; a rollback of an hour or a
 * day, which is what the check exists for, is still refused. */
const IAT_SKEW_TOLERANCE_SECONDS = 5 * 60;

export function verifyLicenseToken(
  token: string,
  opts: { now: Date; publicKey?: KeyObject; maxServerTimeSeen?: number },
): LicenseVerification {
  const parts = token.split(".");
  if (parts.length !== 2) return { valid: false, reason: "malformed" };
  const [payloadSegment, sigSegment] = parts;
  if (!payloadSegment || !sigSegment)
    return { valid: false, reason: "malformed" };

  let signature: Buffer;
  let payloadJson: string;
  try {
    signature = base64UrlDecode(sigSegment);
    payloadJson = base64UrlDecode(payloadSegment).toString("utf8");
  } catch {
    return { valid: false, reason: "malformed" };
  }

  // The override is honored only when the baked build-time gate is off
  // (INV-18); when the gate is armed the baked public key is used no matter
  // what the caller passed.
  const publicKey =
    opts.publicKey && !licenseRequired() ? opts.publicKey : getBakedPublicKey();

  let signatureValid: boolean;
  try {
    signatureValid = crypto.verify(
      null,
      Buffer.from(payloadSegment, "utf8"),
      publicKey,
      signature,
    );
  } catch {
    return { valid: false, reason: "bad_signature" };
  }
  if (!signatureValid) return { valid: false, reason: "bad_signature" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return { valid: false, reason: "malformed" };
  }
  if (!isLicenseClaimsShape(parsed))
    return { valid: false, reason: "malformed" };

  const claims = parsed;
  if (claims.v !== 1) return { valid: false, reason: "unsupported_version" };

  const nowSeconds = Math.floor(opts.now.getTime() / 1000);
  if (nowSeconds > claims.exp) return { valid: false, reason: "expired" };
  if (nowSeconds < claims.iat - IAT_SKEW_TOLERANCE_SECONDS) {
    return { valid: false, reason: "clock_rollback" };
  }
  if (
    opts.maxServerTimeSeen !== undefined &&
    nowSeconds < opts.maxServerTimeSeen - ONE_DAY_SECONDS
  ) {
    return { valid: false, reason: "clock_rollback" };
  }

  return { valid: true, entitled: claims.entitled, claims };
}

// The on-disk license cache: file location, both access directions, and a
// TTL-memoized hot-path entitlement read. Same path in every mode — unlike
// ENV_FILE, checkout mode does not fork this location — and it matches
// HOME_DIR in packages/cli/bin/engager.mjs. There is no env override for the
// location; a `path?` parameter is what tests use instead, the same shape
// packages/core/config.ts uses for the Brain vault dir minus the env key.
export function licenseFilePath(): string {
  return path.join(process.env.ENGAGER_HOME || path.join(os.homedir(), ".engager"), "license.json");
}

export interface CachedLicense {
  token: string;
  refreshToken: string;
  maxServerTimeSeen: number;
  /** Display only; authority always comes from the signed token. */
  accountEmail?: string;
  /** The account's name and picture, and how it signs in, as the cloud's
   *  access read last named them (`rememberAccountProfile`). Display only,
   *  like the email: absent on a cache an older cloud wrote. */
  accountName?: string;
  accountImage?: string;
  accountSignIn?: AccountSignIn;
  /** Cloud Terms acceptance, for the local informational risk record; never authority. */
  termsAcceptedAt?: number | null;
}

export type AccountSignIn = "google" | "email";

/** The display fields a cache carries across a rewrite of its credentials:
 *  the refresh rotates the token, never the person it names. */
export function accountDisplay(
  cache: CachedLicense,
): Pick<CachedLicense, "accountEmail" | "accountName" | "accountImage" | "accountSignIn"> {
  return {
    ...(cache.accountEmail === undefined ? {} : { accountEmail: cache.accountEmail }),
    ...(cache.accountName === undefined ? {} : { accountName: cache.accountName }),
    ...(cache.accountImage === undefined ? {} : { accountImage: cache.accountImage }),
    ...(cache.accountSignIn === undefined ? {} : { accountSignIn: cache.accountSignIn }),
  };
}

/** What the cloud said about the person: a field it sent as null clears the
 *  cached one, and a field it did not send at all keeps it. */
export type AccountProfile = {
  email?: string;
  name?: string | null;
  image?: string | null;
  signIn?: AccountSignIn;
};

/**
 * Fold the account's display fields into the cache, under the refresh mutex
 * and only for the credential they were read with: a sign-out or another
 * account signing in during the read wins. Writes nothing when nothing
 * changed, so the minute's access read does not rewrite the file each time.
 */
export async function rememberAccountProfile(
  credential: string,
  profile: AccountProfile,
  filePath: string = licenseFilePath(),
): Promise<void> {
  await withLicenseRefreshLock(filePath, async () => {
    const cache = readCachedLicense(filePath);
    if (!cache || cache.refreshToken !== credential) return;
    const next: CachedLicense = { ...cache };
    if (profile.email !== undefined) next.accountEmail = profile.email;
    if (profile.signIn !== undefined) next.accountSignIn = profile.signIn;
    for (const [field, value] of [["accountName", profile.name], ["accountImage", profile.image]] as const) {
      if (value === undefined) continue;
      if (value === null) delete next[field];
      else next[field] = value;
    }
    const same = (["accountEmail", "accountName", "accountImage", "accountSignIn"] as const)
      .every((field) => next[field] === cache[field]);
    if (!same) writeCachedLicense(next, filePath);
  });
}

export function termsAcceptanceTime(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function isCachedLicenseShape(value: unknown): value is CachedLicense {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.token === "string" &&
    typeof c.refreshToken === "string" &&
    typeof c.maxServerTimeSeen === "number"
  );
}

// Never throws: a missing file, unparseable JSON, or a shape mismatch are all
// treated as an absent cache rather than an error.
export function readCachedLicense(
  filePath: string = licenseFilePath(),
): CachedLicense | null {
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
  if (!isCachedLicenseShape(parsed)) return null;
  return parsed;
}

// Phase 17 obtains tokens and calls this writer; it never invents file shape.
// `writeFileSync`'s `mode` only applies when the file is CREATED, so a
// re-write over a pre-existing looser-permissioned file would otherwise leave
// the token world-readable — the explicit chmodSync after the write closes
// that gap.
export function writeCachedLicense(
  cache: CachedLicense,
  filePath: string = licenseFilePath(),
): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(cache), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, filePath);
  } finally {
    rmSync(temporary, { force: true });
  }
}

let cachedEntitlement: boolean | undefined;
let cachedEntitlementAt = 0;
const ENTITLEMENT_TTL_MS = 60_000;

/** Test-only: drop the memo so the next call re-reads the cache file. */
export function resetLicenseEntitlementCache(): void {
  cachedEntitlement = undefined;
  cachedEntitlementAt = 0;
}

// The hot-path entitlement read: canEngage() runs per send, so this memoizes
// the ONE bit (INV-17) for ENTITLEMENT_TTL_MS rather than reading the
// filesystem on every call. Contract, not optimization.
export function cachedLicenseEntitlement(
  opts: { now?: Date; path?: string; publicKey?: KeyObject } = {},
): boolean {
  const now = opts.now ?? new Date();
  if (
    cachedEntitlement !== undefined &&
    now.getTime() - cachedEntitlementAt < ENTITLEMENT_TTL_MS
  ) {
    return cachedEntitlement;
  }
  const cache = readCachedLicense(opts.path);
  if (!cache) {
    cachedEntitlement = false;
    cachedEntitlementAt = now.getTime();
    return cachedEntitlement;
  }
  const result = verifyLicenseToken(cache.token, {
    now,
    publicKey: opts.publicKey,
    maxServerTimeSeen: cache.maxServerTimeSeen,
  });
  cachedEntitlement = result.valid && result.entitled;
  cachedEntitlementAt = now.getTime();
  return cachedEntitlement;
}

/**
 * The owner's own "sign in again": remove the cached license so the state
 * reads `missing` and the device flow runs afresh. The one deletion INV-16
 * allows, and only as an explicit owner act -- the sign-in wall's button,
 * never a refresh-failure path (`engager logout` is the CLI's spelling of
 * the same act). Absent file, no error.
 */
export function removeCachedLicense(path: string = licenseFilePath()): void {
  rmSync(path, { force: true });
}

/** All owner-initiated cache mutations share the refresh mutex. The synchronous
 * helpers above are low-level operations for already-locked callers and tests. */
export async function writeCachedLicenseSerialized(
  cache: CachedLicense,
  filePath: string = licenseFilePath(),
): Promise<void> {
  await withLicenseRefreshLock(filePath, async () =>
    writeCachedLicense(cache, filePath),
  );
}

export async function removeCachedLicenseSerialized(
  filePath: string = licenseFilePath(),
): Promise<void> {
  await withLicenseRefreshLock(filePath, async () =>
    removeCachedLicense(filePath),
  );
}
