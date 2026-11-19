// The display/gate state read off the cached license file: one pure
// filesystem read that answers which of four states this install is in.
// This is what the corridor and the alert bar consult -- it is NOT the
// send-time enforcement seam. Sending keeps reading the one `entitled` bit
// through `cachedLicenseEntitlement` (INV-17); this module re-derives nothing
// from `plan`, `status`, or timestamp claims, and nothing in that path may
// import it.
//
// Inside the maintained macOS app (`managedAppArmed()`) the word comes from
// this Mac's signed `desktop_managed` claim instead -- the same
// `managedAccess()` verdict `apps/dashboard/middleware.ts` refuses on, so the
// corridor's client-side wall and the server-side chokepoint cannot disagree
// about one install. That arm is not a second interpretation of the v1 token:
// the two credentials answer different questions, and neither is derived from
// the other's fields.
//
// No network, no async: this is what a dashboard request path calls, and a
// fetch inside a page render is a defect (phase-17 brief).
import type { KeyObject } from "node:crypto";
import type { EntitlementDecision } from "./entitlementCache";
import { managedAccess, managedAppArmed } from "./entitlementClient";
import { readCachedLicense, verifyLicenseToken } from "./license";
import { licenseRequired } from "./licenseMode";
import { resolveDeploymentEnvironment } from "@engager/database/environment";

export type LicenseGateState = "off" | "missing" | "lapsed" | "ok";

/**
 * The maintained app's word, from this Mac's own signed claim and nothing else.
 *
 * Two words, not eight: the corridor has exactly one door for "no plan"
 * (`corridorRedirect` walls `missing` and `lapsed` identically), so every
 * refusal a claim can carry — expired, revoked, not purchased, wrong device, a
 * clock this install cannot trust — is `lapsed`.
 *
 * `signedIn` is what separates the two, and it is the account credential's
 * presence rather than the claim's: an owner who has just signed in on a
 * plan-less account holds no claim at all, and answering `missing` there would
 * put the device flow back on the front door they just came through — a sign-in
 * loop with no way to reach the subscribe button. So a signed-in install with no
 * usable claim is `lapsed` (the no-active-plan state), and only an install with
 * no account credential is `missing`.
 */
export function managedGateState(
  access: EntitlementDecision,
  signedIn: boolean,
): LicenseGateState {
  if (access.allowed) return "ok";
  return signedIn ? "lapsed" : "missing";
}

export interface LicenseState {
  state: LicenseGateState;
  issuedAtSeconds: number | null;
}

/** Every dashboard caller lands here when the gate is off and no explicit
 * `path` was given -- gate-off by construction (INV-18). The explicit-path
 * exception is narrow and deliberate: `path` is a location override
 * `cachedLicenseEntitlement` already honours ungated (`license.ts:252`
 * passes `opts.path` straight to `readCachedLicense`), while `publicKey`
 * stays gated inside `verifyLicenseToken` itself (`license.ts:128-129`).
 * Without it the file can never be read in an unarmed test build. Because
 * `path` also flips this answer away from `off`, it must stay a test and
 * fixture-e2e affordance: a product caller passing one on an ungated build
 * would wall an install the gate says is not walled at all. */
export function readLicenseState(
  opts: { now?: Date; path?: string; publicKey?: KeyObject } = {}
): LicenseState {
  // FIRST, and never behind the environment read below: inside the maintained
  // app the word comes from this Mac's signed `desktop_managed` claim, which is
  // the only thing an owner cannot write themselves. `ENGAGER_DEPLOYMENT_ENV` is
  // `local` on every Mac install — deciding on it here would answer "off" on the
  // shipped product, which is the wall disarmed by the file it walls.
  if (managedAppArmed()) {
    const account = accountCredentialState(opts);
    const access = managedAccess({
      ...(opts.now === undefined ? {} : { now: opts.now }),
      ...(opts.publicKey === undefined ? {} : { publicKey: opts.publicKey }),
      // The same location override this function's own `path` is, forwarded:
      // `accountCredentialState` honours it, and a caller that redirected the
      // licence for one half and not the other would be reading two installs.
      ...(opts.path === undefined ? {} : { licensePath: opts.path }),
    });
    return {
      state: managedGateState(access, account.state !== "missing"),
      // The ACCOUNT credential's age, deliberately, not the claim's: this field
      // has one consumer (`licenseCacheAgeSeconds`, driving `/api/setup-state`'s
      // daily refresh), and the account token is the credential the seat route
      // authenticates every claim renewal with. Reporting the claim's own age
      // instead would let a freshly renewed claim hold that refresh off until
      // the seven-day account token behind it had expired.
      issuedAtSeconds: account.issuedAtSeconds,
    };
  }
  const environment = resolveDeploymentEnvironment();
  if (opts.path === undefined && (environment === "local" || environment === "test" || !licenseRequired())) {
    return { state: "off", issuedAtSeconds: null };
  }
  return accountCredentialState(opts);
}

/** The v1 account credential's own state, with no gate arm in front of it —
 * `readLicenseState`'s original body, extracted because the armed arm above
 * needs the same two facts (is this install signed in, and how old is the
 * credential) without the gate-off shortcut that sits between them. */
function accountCredentialState(
  opts: { now?: Date; path?: string; publicKey?: KeyObject }
): LicenseState {
  const cache = readCachedLicense(opts.path);
  if (!cache) {
    return { state: "missing", issuedAtSeconds: null };
  }

  const now = opts.now ?? new Date();
  const result = verifyLicenseToken(cache.token, {
    now,
    maxServerTimeSeen: cache.maxServerTimeSeen,
    publicKey: opts.publicKey,
  });
  if (result.valid && result.entitled) {
    return { state: "ok", issuedAtSeconds: result.claims.iat };
  }
  return { state: "lapsed", issuedAtSeconds: null };
}

/** The entry the dashboard calls: `readLicenseState`'s `.state` projection. */
export function readLicenseGateState(
  opts: { now?: Date; path?: string; publicKey?: KeyObject } = {}
): LicenseGateState {
  return readLicenseState(opts).state;
}

/** Staleness derived from `issuedAtSeconds` alone -- `null` means "unknown
 * age", which callers read as stale, so an expired token is refresh-eligible
 * rather than mysteriously fresh. */
export function licenseCacheAgeSeconds(now: Date, state: LicenseState): number | null {
  if (state.issuedAtSeconds === null) return null;
  return Math.floor(now.getTime() / 1000) - state.issuedAtSeconds;
}
