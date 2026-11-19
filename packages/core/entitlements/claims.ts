// Signed capability claims, version 2 — the wire format the new commercial
// projection issues and every managed-service decision verifies (ADR-05).
//
// The version fence is CRYPTOGRAPHIC, not a field comparison. A v2 signature
// covers a domain-separated payload (`engager-license-v2\n<payload>`), so a
// previously issued v1 token cannot be replayed as v2 authority even though
// both are signed by the same Ed25519 key and even if its `v` field were
// rewritten: the signature simply does not verify. `packages/core/entitlements/license.ts`
// keeps verifying v1 for the historical hosted flow, and neither verifier can
// accept the other's tokens.
//
// Unlike v1's single `entitled` bit, v2 carries explicit capabilities, the
// subscription generation, the paid-through boundary and the device seat. None
// of them is display material: every field below is enforcement input.
import * as crypto from "node:crypto";
import type { KeyObject } from "node:crypto";
import type { Capability } from "./capabilities";
import { isOfferId, type OfferId } from "./offer";

export type ClaimCapability = Exclude<Capability, "core_local">;

/** The device identity a claim carries: the seat key's hash, never the key.
 * Lives here rather than beside the seat table so an install can compute its
 * own device id without importing a database module. */
export function deviceIdForKey(deviceKey: string): string {
  return crypto
    .createHash("sha256")
    .update(`engager-mac-seat-v1\0${deviceKey}`)
    .digest("hex");
}

export const CLAIMS_V2_AUDIENCE = "engager-runtime";
export const CLAIMS_V2_DOMAIN = "engager-license-v2";

export interface LicenseClaimsV2 {
  v: 2;
  /** The issuing control plane's origin. */
  iss: string;
  aud: typeof CLAIMS_V2_AUDIENCE;
  /** Signing key id, so a rotation is a key set rather than a fork. */
  kid: string;
  /** The organization these capabilities belong to. */
  sub: string;
  offerId: OfferId;
  subscriptionId: string;
  /** The paid generation. A claim below a locally known generation is stale. */
  generation: number;
  /** The Mac seat this claim is bound to; null for an account-scoped claim
   * (the hosted tenant, which has no device). */
  deviceId: string | null;
  capabilities: ClaimCapability[];
  /** Epoch SECONDS, like v1's `iat`/`exp`. */
  iat: number;
  nbf: number;
  exp: number;
  /** Epoch seconds. The paid period boundary — the outer bound of every
   * offline grace window, and never extended by dunning. */
  paidThrough: number;
  /** Epoch seconds. A known revocation ends service at this instant. */
  revokedAt: number | null;
}

export type ClaimsV2Rejection =
  | "malformed"
  | "bad_signature"
  | "unsupported_version"
  | "wrong_issuer"
  | "wrong_audience"
  | "wrong_subject"
  | "wrong_device"
  | "not_yet_valid"
  | "expired"
  | "clock_rollback";

export type ClaimsV2Verification =
  | { valid: true; claims: LicenseClaimsV2 }
  | { valid: false; reason: ClaimsV2Rejection };

function base64UrlEncode(input: Buffer): string {
  return input.toString("base64url");
}

function base64UrlDecode(input: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(input)) throw new Error("not base64url");
  return Buffer.from(input, "base64url");
}

/** What the signature actually covers. The domain string is inside the signed
 * bytes, which is what makes the version fence cryptographic. */
function signedBytes(payloadSegment: string): Buffer {
  return Buffer.from(`${CLAIMS_V2_DOMAIN}\n${payloadSegment}`, "utf8");
}

const CAPABILITIES: readonly ClaimCapability[] = [
  "desktop_managed",
];

function isClaimsV2Shape(value: unknown): value is LicenseClaimsV2 {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.v === "number" &&
    typeof c.iss === "string" &&
    typeof c.aud === "string" &&
    typeof c.kid === "string" &&
    typeof c.sub === "string" &&
    isOfferId(c.offerId as string) &&
    typeof c.subscriptionId === "string" &&
    typeof c.generation === "number" &&
    Number.isSafeInteger(c.generation) &&
    c.generation > 0 &&
    (c.deviceId === null || typeof c.deviceId === "string") &&
    Array.isArray(c.capabilities) &&
    c.capabilities.every((entry) => typeof entry === "string") &&
    typeof c.iat === "number" &&
    typeof c.nbf === "number" &&
    typeof c.exp === "number" &&
    typeof c.paidThrough === "number" &&
    (c.revokedAt === null || typeof c.revokedAt === "number")
  );
}

export function signClaimsV2(
  claims: LicenseClaimsV2,
  privateKey: KeyObject,
): string {
  const payloadSegment = base64UrlEncode(
    Buffer.from(JSON.stringify(claims), "utf8"),
  );
  const signature = crypto.sign(null, signedBytes(payloadSegment), privateKey);
  return `v2.${payloadSegment}.${base64UrlEncode(signature)}`;
}

/** How far ahead of THIS clock an issuance may sit and still verify — the same
 * five minutes `verifyLicenseToken` documents, for the same measured reason. */
export const CLAIMS_V2_SKEW_SECONDS = 5 * 60;

export type VerifyClaimsV2Options = {
  now: Date;
  publicKey: KeyObject;
  issuer: string;
  /** The organization this install belongs to. A claim for another subject is
   * rejected before any capability is read. */
  organizationId: string;
  /** The seat this install holds. `null` asks for an account-scoped claim; a
   * device-bound claim is refused for a caller that presents no device. */
  deviceId?: string | null;
};

export function verifyClaimsV2(
  token: string,
  opts: VerifyClaimsV2Options,
): ClaimsV2Verification {
  const parts = token.split(".");
  if (parts.length !== 3) return { valid: false, reason: "malformed" };
  const [version, payloadSegment, signatureSegment] = parts;
  if (!payloadSegment || !signatureSegment) {
    return { valid: false, reason: "malformed" };
  }
  // A v1 token has two segments and never reaches here; a token labelled v2
  // still has to carry a v2 signature over the v2 domain below.
  if (version !== "v2") return { valid: false, reason: "unsupported_version" };

  let signature: Buffer;
  let payloadJson: string;
  try {
    signature = base64UrlDecode(signatureSegment);
    payloadJson = base64UrlDecode(payloadSegment).toString("utf8");
  } catch {
    return { valid: false, reason: "malformed" };
  }

  let signatureValid: boolean;
  try {
    signatureValid = crypto.verify(
      null,
      signedBytes(payloadSegment),
      opts.publicKey,
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
  if (!isClaimsV2Shape(parsed)) return { valid: false, reason: "malformed" };
  // A capability this build does not know (a retired one on a claim issued
  // before it went) grants nothing; it does not void the claim.
  const claims: LicenseClaimsV2 = {
    ...parsed,
    capabilities: parsed.capabilities.filter((entry) =>
      CAPABILITIES.includes(entry),
    ),
  };
  if (claims.v !== 2) return { valid: false, reason: "unsupported_version" };
  if (claims.iss !== opts.issuer) return { valid: false, reason: "wrong_issuer" };
  if (claims.aud !== CLAIMS_V2_AUDIENCE) {
    return { valid: false, reason: "wrong_audience" };
  }
  if (claims.sub !== opts.organizationId) {
    return { valid: false, reason: "wrong_subject" };
  }
  if ((claims.deviceId ?? null) !== (opts.deviceId ?? null)) {
    return { valid: false, reason: "wrong_device" };
  }

  const nowSeconds = Math.floor(opts.now.getTime() / 1000);
  if (nowSeconds > claims.exp) return { valid: false, reason: "expired" };
  if (nowSeconds < claims.nbf - CLAIMS_V2_SKEW_SECONDS) {
    return { valid: false, reason: "not_yet_valid" };
  }
  if (nowSeconds < claims.iat - CLAIMS_V2_SKEW_SECONDS) {
    return { valid: false, reason: "clock_rollback" };
  }
  return { valid: true, claims };
}
