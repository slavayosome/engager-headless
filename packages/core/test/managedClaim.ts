import type { KeyObject } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { deviceIdForKey, signClaimsV2 } from "@engager/billing/claims";
import { writeCachedEntitlement } from "@engager/billing/entitlementCache";

export const CLAIM_ISSUER = "https://cloud.engager.test";

type ManagedClaim = { deviceKey: string; issuedAt: number; paidThrough: number; generation?: number };

/** The claim the seat route answers a Mac with, issued at `issuedAt` and paid
 *  through `paidThrough` (seconds), signed as the issuer would. */
export function managedClaimToken(privateKey: KeyObject, claim: ManagedClaim): string {
  const { deviceKey, issuedAt, paidThrough, generation = 1 } = claim;
  return signClaimsV2({ v: 2, iss: CLAIM_ISSUER, aud: "engager-runtime", kid: "engager-license-test", sub: "fixture",
    offerId: "cloud_monthly_v1", subscriptionId: "sub_test", generation, deviceId: deviceIdForKey(deviceKey), capabilities: ["desktop_managed"],
    iat: issuedAt, nbf: issuedAt, exp: paidThrough, paidThrough, revokedAt: null }, privateKey);
}

/**
 * The signed claim a Mac holds after its cloud account paid: the device key
 * under `home` and that claim in the entitlement cache.
 */
export function cacheManagedClaim(home: string, privateKey: KeyObject, claim: ManagedClaim) {
  const { deviceKey, issuedAt, generation = 1 } = claim;
  writeFileSync(path.join(home, "device-key"), deviceKey);
  writeCachedEntitlement({ token: managedClaimToken(privateKey, claim), refreshToken: "fixture", organizationId: "fixture",
    deviceId: deviceIdForKey(deviceKey), maxServerTimeSeen: issuedAt, maxGenerationSeen: generation });
}
