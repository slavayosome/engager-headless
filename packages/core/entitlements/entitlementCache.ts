// The local half of a managed capability: the signed claim on disk, the clock
// evidence beside it, and the decision every managed-service caller makes from
// the two (ADR-05).
//
// Three rules this module exists to hold, and one it exists to NOT hold:
//
// 1. Every decision re-evaluates time. What is memoized is signature
//    VERIFICATION keyed on the exact token bytes, never a timeless boolean —
//    `cachedLicenseEntitlement` (license.ts) memoizes an answer for a minute
//    because v1's boundary was a week away; a capability boundary is the one
//    instant this module exists to make sharp.
// 2. A previously verified positive capability survives a validation outage
//    only until `min(paidThrough, issuedAt + 14 days)` — the same bound the
//    issuer signs into `exp` (apps/cloud/lib/issuance.ts), so the promise is
//    reachable and no decision advertises past its own signature. A revocation
//    or expiry known locally applies immediately and always beats that grace.
// 3. Generations only move forward. A stale response — positive or negative —
//    for a generation older than the highest one this install ever saw is
//    ignored rather than written.
//
// Nothing here gates the owner's data. Safe sending, stopping, export and
// recovery are not commercial services
// (TIER-01/03). A caller that reads this module for permission to let an owner
// read their own data has misread it.
import { createHash, type KeyObject } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  verifyClaimsV2,
  type ClaimCapability,
  type ClaimsV2Rejection,
  type LicenseClaimsV2,
} from "./claims";

/** How long a verified positive capability may outlive the last successful
 * validation, and therefore how long a capability claim is signed for. Policy
 * constant, not a paid guarantee: `paidThrough` still bounds it. */
export const OUTAGE_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

/** Backward wall-clock movement beyond this, measured against the persisted
 * high-water observation or this process's own monotonic anchor, requires
 * online verification before managed service continues. */
export const CLOCK_ROLLBACK_TOLERANCE_MS = 5 * 60_000;

/** Same directory `licenseFilePath` and `authorityFilePath` already own. The v1
 * cache keeps its own file: a v1 token is not v2 authority, and keeping the two
 * apart means the new reader cannot even see the old one. */
export function entitlementCachePath(): string {
  return path.join(process.env.ENGAGER_HOME || path.join(os.homedir(), ".engager"), "entitlement.json");
}

export interface CachedEntitlement {
  /** The v2 token, verbatim. */
  token: string;
  refreshToken: string;
  /** The organization this install is signed in to. */
  organizationId: string;
  /** The Mac seat this install holds; null for an account-scoped claim. */
  deviceId: string | null;
  /** Highest server-issued time ever observed, epoch SECONDS. Monotone. */
  maxServerTimeSeen: number;
  /** Highest paid generation ever observed. Monotone. */
  maxGenerationSeen: number;
}

function isCachedEntitlementShape(value: unknown): value is CachedEntitlement {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.token === "string" &&
    typeof c.refreshToken === "string" &&
    typeof c.organizationId === "string" &&
    (c.deviceId === null || typeof c.deviceId === "string") &&
    typeof c.maxServerTimeSeen === "number" &&
    typeof c.maxGenerationSeen === "number"
  );
}

/** Never throws: a missing file, unparseable JSON or a shape mismatch are all
 * an absent cache, the shape `readCachedLicense` already uses. */
export function readCachedEntitlement(
  filePath: string = entitlementCachePath(),
): CachedEntitlement | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
  return isCachedEntitlementShape(parsed) ? parsed : null;
}

export function writeCachedEntitlement(
  cache: CachedEntitlement,
  filePath: string = entitlementCachePath(),
): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(cache), { mode: 0o600 });
    // `mode` applies only on CREATE, so a rewrite over a looser-permissioned
    // file would otherwise leave the token world-readable.
    chmodSync(temporary, 0o600);
    renameSync(temporary, filePath);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export type EntitlementReason =
  | "available"
  | "cache_missing"
  | "cache_invalid"
  | "subscription_expired"
  | "revoked"
  | "capability_not_purchased"
  | "generation_superseded"
  | "outage_grace_exhausted"
  | "clock_verification_required";

export type EntitlementDecision = {
  allowed: boolean;
  capability: ClaimCapability;
  reason: EntitlementReason;
  /** Present whenever a signature verified, even on a denial: an owner is told
   * which paid period ended, not merely that something is wrong. */
  claims: LicenseClaimsV2 | null;
  /** The instant this decision stops being valid without a fresh validation. */
  verifiedUntil: number | null;
  /** Why the verification itself failed, when it did. */
  rejection: ClaimsV2Rejection | null;
  recovery:
    | "none"
    | "renew_service"
    | "sign_in"
    | "verify_clock"
    | "run_self_managed";
};

const deny = (
  capability: ClaimCapability,
  reason: EntitlementReason,
  extra: Partial<EntitlementDecision> = {},
): EntitlementDecision => ({
  allowed: false,
  capability,
  reason,
  claims: null,
  verifiedUntil: null,
  rejection: null,
  recovery:
    reason === "clock_verification_required"
      ? "verify_clock"
      : reason === "cache_missing" || reason === "cache_invalid"
        ? "sign_in"
        : "renew_service",
  ...extra,
});

/**
 * Signature verification memo. Keyed on the exact token bytes and the key's
 * fingerprint, so a rotated key re-verifies and a replaced token re-verifies —
 * but a hot path that asks the same question about the same bytes twice does
 * not pay for Ed25519 twice. Time is deliberately NOT part of the key: it is
 * re-evaluated by the caller below on every decision.
 */
const verificationMemo = new Map<string, LicenseClaimsV2 | ClaimsV2Rejection>();
const VERIFICATION_MEMO_LIMIT = 32;

export function resetEntitlementVerificationMemo(): void {
  verificationMemo.clear();
  clockAnchor = null;
}

/** The process's own monotonic anchor. Wall-clock movement is compared against
 * elapsed monotonic time so a machine whose clock is set backwards mid-session
 * is caught even when the persisted high-water observation still looks fine. */
let clockAnchor: { wallMs: number; monotonicMs: number } | null = null;

export type ClockEvidence = {
  /** Wall clock, epoch milliseconds. */
  nowMs: number;
  /** A monotonically non-decreasing process-local reading, milliseconds. */
  monotonicMs: number;
};

function clockSuspect(evidence: ClockEvidence, cache: CachedEntitlement): boolean {
  // A missing high-water observation is itself grounds for online verification:
  // without it there is no evidence the local clock was ever trustworthy.
  if (!Number.isSafeInteger(cache.maxServerTimeSeen) || cache.maxServerTimeSeen <= 0) {
    return true;
  }
  if (cache.maxServerTimeSeen * 1000 - evidence.nowMs > CLOCK_ROLLBACK_TOLERANCE_MS) {
    return true;
  }
  if (!clockAnchor) {
    clockAnchor = { wallMs: evidence.nowMs, monotonicMs: evidence.monotonicMs };
    return false;
  }
  const projected =
    clockAnchor.wallMs + (evidence.monotonicMs - clockAnchor.monotonicMs);
  if (projected - evidence.nowMs > CLOCK_ROLLBACK_TOLERANCE_MS) return true;
  // Forward jumps are allowed to expire service early — the anchor follows the
  // clock forward so a later legitimate reading is not judged against a stale
  // projection — but they never extend a term.
  if (evidence.nowMs > projected) {
    clockAnchor = { wallMs: evidence.nowMs, monotonicMs: evidence.monotonicMs };
  }
  return false;
}

export type EvaluateEntitlementInput = {
  cache: CachedEntitlement | null;
  capability: ClaimCapability;
  publicKey: KeyObject;
  issuer: string;
  organizationId: string;
  deviceId?: string | null;
  clock: ClockEvidence;
};

/**
 * The one decision. Callers hand it the cache they read and the clock evidence
 * they hold; it re-derives nothing about payment policy — the issuing
 * projection already decided what was bought and until when.
 */
export function evaluateCachedEntitlement(
  input: EvaluateEntitlementInput,
): EntitlementDecision {
  const { cache, capability } = input;
  if (!cache) return deny(capability, "cache_missing");
  if (cache.organizationId !== input.organizationId) {
    return deny(capability, "cache_invalid");
  }
  if ((cache.deviceId ?? null) !== (input.deviceId ?? null)) {
    return deny(capability, "cache_invalid");
  }
  if (clockSuspect(input.clock, cache)) {
    return deny(capability, "clock_verification_required");
  }

  const fingerprint = createHash("sha256")
    .update(input.publicKey.export({ format: "der", type: "spki" }))
    .digest("hex");
  const memoKey = `${fingerprint}\n${input.issuer}\n${input.organizationId}\n${cache.deviceId ?? ""}\n${cache.token}`;
  let verified = verificationMemo.get(memoKey);
  if (verified === undefined) {
    const result = verifyClaimsV2(cache.token, {
      // Signature, issuer, audience, subject and device do not depend on the
      // instant; the temporal claims are re-checked below on every call, so a
      // far-future `now` here would memoize a stale rejection.
      now: new Date(cache.maxServerTimeSeen * 1000),
      publicKey: input.publicKey,
      issuer: input.issuer,
      organizationId: input.organizationId,
      deviceId: input.deviceId ?? null,
    });
    verified = result.valid ? result.claims : result.reason;
    if (verificationMemo.size >= VERIFICATION_MEMO_LIMIT) verificationMemo.clear();
    verificationMemo.set(memoKey, verified);
  }
  if (typeof verified === "string") {
    return deny(capability, "cache_invalid", { rejection: verified });
  }
  const claims = verified;

  // A generation this install already knows was superseded cannot grant, even
  // with a perfect signature: it is a token from a paid life that has ended.
  if (claims.generation < cache.maxGenerationSeen) {
    return deny(capability, "generation_superseded", { claims });
  }

  const nowMs = input.clock.nowMs;
  const withClaims = (
    reason: EntitlementReason,
    verifiedUntil: number | null,
  ): EntitlementDecision => ({
    ...deny(capability, reason),
    claims,
    verifiedUntil,
  });

  if (claims.revokedAt !== null && claims.revokedAt * 1000 <= nowMs) {
    return withClaims("revoked", claims.revokedAt * 1000);
  }
  const paidThroughMs = claims.paidThrough * 1000;
  const graceUntilMs = claims.iat * 1000 + OUTAGE_GRACE_MS;
  // The instant this decision stops being valid, and never one the token
  // cannot reach: the issuer signs `exp = min(paidThrough, iat + grace)`, so a
  // shorter term — an older issuance policy, a claim minted near the period
  // boundary — binds here too. A caller that schedules against
  // `verifiedUntil` is scheduling against something the signature covers.
  const verifiedUntil = Math.min(claims.exp * 1000, paidThroughMs, graceUntilMs);
  if (nowMs >= paidThroughMs) {
    return withClaims("subscription_expired", verifiedUntil);
  }
  if (nowMs >= graceUntilMs || nowMs > claims.exp * 1000) {
    // Too long without a successful validation: either the fourteen days this
    // module grants, or the shorter term the signature itself carries.
    return withClaims("outage_grace_exhausted", verifiedUntil);
  }
  if (!claims.capabilities.includes(capability)) {
    return withClaims("capability_not_purchased", verifiedUntil);
  }
  return {
    allowed: true,
    capability,
    reason: "available",
    claims,
    verifiedUntil,
    rejection: null,
    recovery: "none",
    };
}

export type AcceptedEntitlement =
  | { status: "accepted"; cache: CachedEntitlement; claims: LicenseClaimsV2 }
  | { status: "unverifiable"; rejection: ClaimsV2Rejection }
  | { status: "stale_generation" };

/**
 * Take a fresh validation response into the cache. A response that does not
 * verify is dropped rather than written — replacing a working claim with an
 * unverifiable one would spend the remaining grace for nothing — and a response
 * for a generation older than the highest one seen is dropped too, which is
 * what stops a reordered negative answer from cancelling a newer paid period.
 */
export function acceptEntitlementResponse(input: {
  current: CachedEntitlement | null;
  token: string;
  refreshToken: string;
  publicKey: KeyObject;
  issuer: string;
  organizationId: string;
  deviceId?: string | null;
  now: Date;
}): AcceptedEntitlement {
  const result = verifyClaimsV2(input.token, {
    now: input.now,
    publicKey: input.publicKey,
    issuer: input.issuer,
    organizationId: input.organizationId,
    deviceId: input.deviceId ?? null,
  });
  if (!result.valid) {
    return { status: "unverifiable", rejection: result.reason };
  }
  const claims = result.claims;
  const seenGeneration = input.current?.maxGenerationSeen ?? 0;
  if (claims.generation < seenGeneration) return { status: "stale_generation" };
  return {
    status: "accepted",
    claims,
    cache: {
      token: input.token,
      refreshToken: input.refreshToken,
      organizationId: input.organizationId,
      deviceId: input.deviceId ?? null,
      // Monotone in both dimensions: this evidence only ever moves forward, and
      // it is what a later backward clock is measured against.
      maxServerTimeSeen: Math.max(
        input.current?.maxServerTimeSeen ?? 0,
        claims.iat,
      ),
      maxGenerationSeen: Math.max(seenGeneration, claims.generation),
    },
  };
}
