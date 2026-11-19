// The install's side of a maintained-service capability: its device key, the
// one round trip that refreshes its signed claims, and the local reader every
// managed-service caller asks.
//
// INV-19 holds exactly as it does for `licenseClient.ts`: this is the same
// Engager-owned cloud, reached through the same `cloudPost` retry policy and
// base URL, and it holds no provider secret. The device key travels in the
// request BODY, never a header or a URL, and only when the owner is registering
// or re-registering this machine.
//
// Nothing here can refuse an owner their own data or withhold read, export,
// stop, disconnect or reconcile (TIER-03).
import { type KeyObject, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deviceIdForKey, type ClaimCapability } from "./claims";
import { cloudBaseUrl } from "./cloudUrl";
import {
  acceptEntitlementResponse,
  entitlementCachePath,
  evaluateCachedEntitlement,
  readCachedEntitlement,
  writeCachedEntitlement,
  type ClockEvidence,
  type EntitlementDecision,
} from "./entitlementCache";
import { cloudPost } from "./licenseClient";
import {
  licenseFilePath,
  licensePublicKey,
  readCachedLicense,
  removeCachedLicense,
  verifyLicenseToken,
} from "./license";
import { withLicenseRefreshLock } from "./licenseRefreshLock";

/** Same directory the licence and authority caches already own. */
export function deviceKeyPath(): string {
  return path.join(process.env.ENGAGER_HOME || path.join(os.homedir(), ".engager"), "device-key");
}

/**
 * This machine's opaque seat secret, minted once and persisted before it is
 * ever used. Minting without persisting looks simpler and is not: a
 * registration whose response is lost would leave the control plane holding key
 * A while the next attempt presents key B, and B would consume the account's
 * second seat against the install's own ghost — the argument
 * `readOrMintHolderId` already makes for the authority lease.
 *
 * It is random, not derived: there is no hardware fingerprint here, and moving
 * to a new Mac is registering a new key rather than proving anything about a
 * machine (PRODUCT.md).
 */
export function readOrMintDeviceKey(filePath: string = deviceKeyPath()): string {
  try {
    const existing = readFileSync(filePath, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(existing)) return existing;
  } catch {
    /* no key yet */
  }
  const key = randomBytes(32).toString("hex");
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, `${key}\n`, { mode: 0o600 });
  chmodSync(filePath, 0o600);
  return key;
}

/** This machine's device id when it already holds a key, and null otherwise.
 * Deliberately never mints one: a read path — a dashboard render, a status
 * line — must not consume the account's one seat as a side effect. */
export function readDeviceId(filePath: string = deviceKeyPath()): string | null {
  try {
    const existing = readFileSync(filePath, "utf8").trim();
    return /^[0-9a-f]{64}$/.test(existing) ? deviceIdForKey(existing) : null;
  } catch {
    return null;
  }
}

/** Real elapsed time inside this process, independent of the wall clock. */
function clockEvidence(now?: Date): ClockEvidence {
  return {
    nowMs: (now ?? new Date()).getTime(),
    monotonicMs: Math.round(performance.now()),
  };
}

export type ManagedCapabilityOptions = {
  organizationId: string;
  capability: ClaimCapability;
  /** Omit for the account-scoped cloud claim; pass this machine's seat id for
   * a Mac claim. */
  deviceId?: string | null;
  now?: Date;
  cachePath?: string;
  publicKey?: KeyObject;
  issuer?: string;
};

/**
 * The local read: no network, no async. This is what a supervisor tick, a CLI
 * status line and a dashboard request path call, and a fetch inside a render is
 * a defect (the rule `licenseState.ts` already states).
 */
export function managedCapability(
  opts: ManagedCapabilityOptions,
): EntitlementDecision {
  return evaluateCachedEntitlement({
    cache: readCachedEntitlement(opts.cachePath),
    capability: opts.capability,
    publicKey: opts.publicKey ?? licensePublicKey(),
    issuer: opts.issuer ?? cloudBaseUrl(),
    organizationId: opts.organizationId,
    deviceId: opts.deviceId ?? null,
    clock: clockEvidence(opts.now),
  });
}

export type CapabilityRefreshOutcome =
  | "refreshed"
  | "no_account_token"
  | "rate_limited"
  | "not_entitled"
  | "seats_exhausted"
  | "key_revoked"
  | "stale_generation"
  | "unverifiable"
  | "unwritable"
  | "failed";

export type RefreshCapabilityOptions = {
  organizationId: string;
  /** The ACCOUNT credential — the device-flow licence token. Separate from the
   * capability claims this call returns, by design: recovery and seat removal
   * authenticate with it in every commercial state. */
  accountToken: string | null;
  action?: "register" | "status";
  /** The licence cache this claim is written against — the file whose lock the
   * write takes, and whose credential it is re-checked against. */
  licensePath?: string;
  deviceKey?: string;
  deviceKeyPath?: string;
  label?: string;
  now?: Date;
  cachePath?: string;
  publicKey?: KeyObject;
  issuer?: string;
  post?: typeof cloudPost;
};

/**
 * One round trip that renews this install's claims. TOTAL, like
 * `maybeRefreshLicense`: every failure resolves to a word and nothing
 * propagates, because a validation outage must leave the previously verified
 * claim — and the grace it carries — exactly where it was.
 */
export async function refreshManagedCapability(
  opts: RefreshCapabilityOptions,
): Promise<CapabilityRefreshOutcome> {
  if (!opts.accountToken) return "no_account_token";
  const deviceKey = opts.deviceKey ?? readOrMintDeviceKey();
  const deviceId = deviceIdForKey(deviceKey);
  const post = opts.post ?? cloudPost;
  const action = opts.action ?? "register";

  let response: { status: number; json: unknown };
  try {
    response = await post("/api/license/seat", {
      token: opts.accountToken,
      action,
      ...(action === "register" ? { deviceKey, label: opts.label } : { deviceId }),
    });
  } catch {
    // INV-16, literal: no unlink, no truncating write, no "clear the bad cache"
    // branch. A still-valid claim outlives every failed refresh until its own
    // paid-through or grace boundary.
    return "failed";
  }
  // The seat surface shares `tenant_provision`'s public budget (60 per client
  // per fifteen minutes), so a caller that polls has to be able to tell "the
  // limiter said wait" from "the cloud said no" -- the wall says one of those out
  // loud and keeps waiting, and would send the owner shopping over the other.
  if (response.status === 429) return "rate_limited";
  if (response.status === 402) return "not_entitled";
  if (response.status === 409) {
    const status = (response.json as { status?: unknown } | null)?.status;
    return status === "seats_exhausted" ? "seats_exhausted" : "key_revoked";
  }
  if (response.status !== 200) return "failed";

  const payload = response.json as { capabilityToken?: unknown } | null;
  if (typeof payload?.capabilityToken !== "string") return "not_entitled";
  // Bound here rather than read inside the lock below: a narrowing on a property
  // does not survive into a callback, and a cast would be asserting what this
  // line already checked.
  const capabilityToken = payload.capabilityToken;

  const cachePath = opts.cachePath ?? entitlementCachePath();
  // THE WRITE TAKES THE LICENCE CACHE'S OWN LOCK, and re-reads the credential
  // inside it. Sign-out removes both files under that same lock
  // (`signOutManagedInstall`, and `licenseLogout` in the CLI), so without this
  // the wall's own minute tick could have a round trip in flight while the owner
  // presses "Sign in again": both files go, the answer lands, and the claim is
  // written back under a credential that no longer exists — admitting a
  // signed-out machine until that claim expires.
  //
  // The property held is about the ACCOUNT, not the bytes: this claim may be
  // written while the file still names the organization it was fetched for. A
  // token comparison would hold something narrower and wrong — the v1 refresh
  // ROTATES that token on its own schedule, so a seat call that left with T1 and
  // waited on the lock would find T2 and throw away a perfectly good claim,
  // every day, until the fourteen-day grace ran out on a paying owner's Mac.
  // (`refreshLocked` compares the REFRESH token for its own write, which changes
  // only on a sign-out or a replacement — the same intent, on a value whose
  // rotation it is itself performing.)
  const licensePath = opts.licensePath ?? licenseFilePath();
  return withLicenseRefreshLock(licensePath, async () => {
    const current = readCachedLicense(licensePath);
    if (!current) return "no_account_token";
    const verified = verifyLicenseToken(current.token, {
      now: opts.now ?? new Date(),
      publicKey: opts.publicKey,
      maxServerTimeSeen: current.maxServerTimeSeen,
    });
    if (!verified.valid || verified.claims.org !== opts.organizationId) {
      return "no_account_token";
    }
    // Explicit seat recovery can replace this identity while an older request
    // is in flight. That answer must not overwrite the new Mac's claim.
    if (readDeviceId(opts.deviceKeyPath) !== deviceId) return "no_account_token";
    const accepted = acceptEntitlementResponse({
      current: readCachedEntitlement(cachePath),
      token: capabilityToken,
      // The account token doubles as the refresh credential for this cache: the
      // seat route re-authenticates it on every call, so no second secret exists.
      // The one ON DISK, which is what the next renewal will present — after a
      // rotation that is no longer the token this answer was fetched with.
      refreshToken: current.token,
      publicKey: opts.publicKey ?? licensePublicKey(),
      issuer: opts.issuer ?? cloudBaseUrl(),
      organizationId: opts.organizationId,
      deviceId,
      now: opts.now ?? new Date(),
    });
    if (accepted.status === "stale_generation") return "stale_generation";
    if (accepted.status === "unverifiable") return "unverifiable";
    try {
      writeCachedEntitlement(accepted.cache, cachePath);
    } catch {
      return "unwritable";
    }
    return "refreshed";
  });
}

/**
 * Whether this process is serving the MAINTAINED macOS application — the one
 * placement whose access is sold (owner decision, 2026-09-22: the monthly Mac
 * plan must be active for the app to be usable).
 *
 * ARMED BY CONSTRUCTION, never by inference. The packaged CLI sets this key on
 * the dashboard child it spawns, and only from inside the `.app` bundle
 * (`IN_APP_BUNDLE` in `packages/cli/bin/engager.mjs`); a checkout, the free
 * archive and `npm run up` never set it, so their core execution keeps its
 * own free policy. Every dashboard requires cloud authorization regardless
 * of this marker. It is deliberately NOT
 * `ENGAGER_DEPLOYMENT_ENV` (user-writable — `license.ts`'s own header), NOT the
 * v1 `entitled` bit (that one means cloud execution — `apps/cloud/lib/
 * issuance.ts`) and NOT the baked build sentinel (INV-18 keeps the CLI payload
 * ungated).
 *
 * Read at CALL time, like the bridge token in `apps/dashboard/middleware.ts`
 * and for the same reason: the packaged server is built once and launched many
 * times, so a value closed over at module scope is read from the wrong launch.
 */
export function managedAppArmed(): boolean {
  return process.env.ENGAGER_MANAGED_APP === "1";
}

export type ManagedAccessOptions = {
  now?: Date;
  /** The v2 claim cache. */
  cachePath?: string;
  /** The v1 licence cache — the account credential, and before any claim exists
   * the only local statement of which account this install signed in to. */
  licensePath?: string;
  deviceKeyPath?: string;
  publicKey?: KeyObject;
  issuer?: string;
};

/**
 * THE ACCOUNT CREDENTIAL this install holds, and the account it names — or null
 * when there is none that verifies.
 *
 * `org` is identity, not entitlement: INV-17's one enforcement bit (`entitled`)
 * is not read here or anywhere below it. The token is returned beside it because
 * the two must not be taken from different places — the seat route derives the
 * organization from the very token it authenticates
 * (`apps/cloud/app/api/license/seat/route.ts`), so registering under any other
 * subject asks the cloud a question about one account with another's credential.
 */
function verifiedAccount(
  opts: ManagedAccessOptions,
): { organizationId: string; token: string } | null {
  const licence = readCachedLicense(opts.licensePath);
  if (!licence) return null;
  const verified = verifyLicenseToken(licence.token, {
    now: opts.now ?? new Date(),
    publicKey: opts.publicKey,
    maxServerTimeSeen: licence.maxServerTimeSeen,
  });
  return verified.valid
    ? { organizationId: verified.claims.org, token: licence.token }
    : null;
}

/**
 * THE ACCOUNT this install acts for — the subject every v2 claim is signed
 * against, and `null` on an install that has never signed in.
 *
 * It is NOT `ENGAGER_ORG_ID`. That is the org this runtime's own database is
 * scoped to: for a Mac install a local row `engager init` created, and for a
 * hosted tenant the tenant's own org beside the separate
 * `ENGAGER_CLOUD_ACCOUNT_ORG_ID` the provisioner passes
 * (`apps/cloud/lib/tenant.ts`). Neither is the account the cloud issues claims
 * for, so a decision made against it would refuse every real Mac.
 *
 * THE ACCOUNT CREDENTIAL ANSWERS FIRST, and that order is the whole of how an
 * account switch on one Mac recovers: sign out, sign in as B, and the subject is
 * B from the first read — so B's claim is what this install asks for and the
 * claim A left behind is `cache_invalid` (a signed `sub` that is not the account
 * this install holds) rather than the subject B's registration is attempted
 * under.
 *
 * The claim cache is the fallback, not the source, and it covers exactly one
 * state: a credential that has expired offline. The v1 token lives seven days
 * and a claim carries fourteen, so a machine kept offline in between would
 * otherwise lose the grace its claim was signed to give it. A claim whose own
 * `sub` disagrees with the cache field is still refused on every read
 * (`evaluateCachedEntitlement`), so the fallback cannot be steered by editing
 * the file.
 */
export function managedAccountId(opts: ManagedAccessOptions = {}): string | null {
  return (
    verifiedAccount(opts)?.organizationId ??
    readCachedEntitlement(opts.cachePath)?.organizationId ??
    null
  );
}

/**
 * The claim half of a sign-out. `signOutManagedInstall` below is what callers
 * use — this is the removal it performs, exported for its own test and kept
 * separate from the lock so there is one place that says what is deleted and one
 * that says when.
 *
 * Only ever an explicit owner act (the one deletion INV-16 allows), never a
 * refresh-failure path, which is why nothing in `refreshManagedSeat` touches it.
 * Removing a claim is not destructive in the sense INV-16 protects: it is a
 * cache of a cloud decision, re-fetched by the next registration, and no owner
 * data lives in it.
 */
export function removeManagedClaims(
  filePath: string = entitlementCachePath(),
): void {
  rmSync(filePath, { force: true });
}

/**
 * THE OWNER'S SIGN-OUT, whole: the account credential and the claims it fetched,
 * removed together under the one lock every other mutation of those files takes
 * (`licenseLogout` is the CLI's spelling of exactly this). Doing them separately
 * is what leaves a window for a refresh in flight to write a claim back after
 * the credential is gone, so the lock is not decoration — it is the difference
 * between signing out and appearing to.
 *
 * The device key stays: it is this machine's seat identity, and minting a new
 * one would spend the account's other seat on the same Mac.
 */
export async function signOutManagedInstall(
  opts: { licensePath?: string; cachePath?: string; revoke?: (refreshToken: string) => Promise<void> } = {},
): Promise<void> {
  const licensePath = opts.licensePath ?? licenseFilePath();
  await withLicenseRefreshLock(licensePath, async () => {
    const credential = readCachedLicense(licensePath)?.refreshToken;
    try {
      if (credential && opts.revoke) await opts.revoke(credential);
    } catch {
      // Local sign-out still completes when the cloud is unavailable.
    }
    removeCachedLicense(licensePath);
    removeManagedClaims(opts.cachePath);
  });
}

/** A released or foreign-account key cannot be reused. Only an explicit
 * recovery click may discard it, after the cloud refuses that exact key.
 * Ordinary sign-out preserves the key so it cannot consume a second seat. */
export async function recoverRevokedManagedInstall(
  opts: ManagedAccessOptions & { post?: typeof cloudPost } = {},
): Promise<"signed_out" | "not_revoked" | "stale_install" | "failed"> {
  const licensePath = opts.licensePath ?? licenseFilePath();
  const credential = readCachedLicense(licensePath);
  const account = verifiedAccount(opts);
  if (!credential || !account) return "not_revoked";
  try {
    const deviceKey = readFileSync(opts.deviceKeyPath ?? deviceKeyPath(), "utf8").trim();
    if (!/^[a-f0-9]{64}$/.test(deviceKey)) return "not_revoked";
    const deviceId = deviceIdForKey(deviceKey);
    const response = await (opts.post ?? cloudPost)("/api/license/seat", {
      token: account.token, action: "register", deviceKey,
    });
    // The refusal covers both a released key and a key owned by another
    // account, without revealing that account. Neither branch mutates a seat.
    const status = (response.json as { status?: unknown } | null)?.status;
    if (response.status !== 409 || status !== "key_revoked") return "not_revoked";
    return await withLicenseRefreshLock(licensePath, async () => {
      const current = readCachedLicense(licensePath);
      if (current?.token !== account.token || current?.refreshToken !== credential.refreshToken || readDeviceId(opts.deviceKeyPath) !== deviceId) {
        return "stale_install";
      }
      removeCachedLicense(licensePath);
      removeManagedClaims(opts.cachePath);
      rmSync(opts.deviceKeyPath ?? deviceKeyPath(), { force: true });
      return "signed_out";
    });
  } catch {
    return "failed";
  }
}

/**
 * MAY THIS MAC RUN THE MAINTAINED APP — one verdict, computed one way, for the
 * middleware, the licence word the corridor reads, the health payload the
 * supervisor reads and the Settings card.
 *
 * Local and synchronous (`managedCapability`'s own rule): no network, no async,
 * and no policy of its own beyond naming the account and the seat. An install
 * with no account, or no seat key, holds no claim at all — which is the same
 * decision an absent cache makes, taken from the one evaluator rather than
 * restated here so there is no second shape of "denied" to keep in step.
 */
export function managedAccess(opts: ManagedAccessOptions = {}): EntitlementDecision {
  const organizationId = managedAccountId(opts);
  // Never mints: a render, a health probe and a middleware hop must not consume
  // the account's one seat by looking (`readDeviceId`).
  const deviceId = readDeviceId(opts.deviceKeyPath);
  if (organizationId === null || deviceId === null) {
    return evaluateCachedEntitlement({
      cache: null,
      capability: "desktop_managed",
      publicKey: opts.publicKey ?? licensePublicKey(),
      issuer: opts.issuer ?? cloudBaseUrl(),
      organizationId: organizationId ?? "",
      deviceId,
      clock: clockEvidence(opts.now),
    });
  }
  return managedCapability({
    ...opts,
    organizationId,
    capability: "desktop_managed",
    deviceId,
  });
}

/** Install-scoped, in-memory throttle for the background seat refresh — the
 * same shape and the same reason as `REFRESH_THROTTLE_MS` in
 * `licenseClient.ts`: never a job row, never per-org, and it dies with the
 * process. Six hours keeps the contract's "at least daily when online" with
 * room to spare for a machine that is only awake in the mornings. */
const SEAT_REFRESH_THROTTLE_MS = 6 * 60 * 60_000;
let lastSeatRefreshAt = 0;

/** How soon held background work looks at the licence again, so a renewal lifts the hold within minutes. */
export const LICENSE_HOLD_RECHECK_MS = 5 * 60_000;

/** Test-only, mirroring `resetLicenseRefreshThrottle`. */
export function resetManagedSeatRefreshThrottle(): void {
  lastSeatRefreshAt = 0;
}

export type RefreshManagedSeatOptions = ManagedAccessOptions & {
  /** Skip the throttle — the owner asking (a completed sign-in, the wall's
   * "check again"), never a background tick. */
  force?: boolean;
  label?: string;
  post?: typeof cloudPost;
};

export type ManagedSeatRefreshOutcome = CapabilityRefreshOutcome | "throttled";

/**
 * REGISTER THIS MAC AND TAKE ITS CLAIMS — the wiring `refreshManagedCapability`
 * has been waiting for, holding the two facts a caller would otherwise have to
 * know: which account to ask about, and that the account credential is the v1
 * licence token already on disk.
 *
 * TOTAL, like `maybeRefreshLicense`: every failure resolves to a word and
 * nothing propagates, because a validation outage must leave the previously
 * verified claim — and the grace it carries — exactly where it was.
 *
 * `register` is the action in every arm, including the periodic one:
 * `assignSeat` is idempotent on the same device key, consumes nothing the
 * second time and stamps `lastSeenAt` (`packages/billing/seats.ts`), so one
 * action covers both taking a seat and renewing the claims a seat already held.
 */
export async function refreshManagedSeat(
  opts: RefreshManagedSeatOptions = {},
): Promise<ManagedSeatRefreshOutcome> {
  const now = opts.now ?? new Date();
  // A claim is signed only to the paid-through instant, so every renewal date
  // ends it while the plan carries on. One that no longer admits background
  // work is asked about again on the held work's own cadence, not six hours
  // after the last ask.
  const throttle = managedAccess(opts).allowed ? SEAT_REFRESH_THROTTLE_MS : LICENSE_HOLD_RECHECK_MS;
  if (!opts.force && now.getTime() - lastSeatRefreshAt < throttle) {
    return "throttled";
  }
  // The VERIFIED credential and the account it names, together and never
  // `managedAccountId`'s claim-cache fallback: the seat route derives the
  // organization from the token it authenticates, so a subject taken from a
  // stale claim would register account B's machine under account A — which the
  // control plane refuses as a foreign device key, and which
  // `acceptEntitlementResponse` would drop as `unverifiable` even if it did not.
  // A credential that does not verify has nothing to register with; the v1
  // refresh beside this one is what recovers that.
  const account = verifiedAccount(opts);
  if (!account) return "no_account_token";
  // Stamped BEFORE the request, so a hung one cannot let the next tick pile a
  // second on top of it (`refreshLocked`'s own reason).
  lastSeatRefreshAt = now.getTime();
  try {
    return await refreshManagedCapability({
      organizationId: account.organizationId,
      accountToken: account.token,
      now,
      label: opts.label ?? os.hostname(),
      // The file this claim is written against, so the re-check inside the lock
      // asks the same credential this subject came from.
      ...(opts.licensePath === undefined ? {} : { licensePath: opts.licensePath }),
      // Minted HERE rather than inside the refresh, so `deviceKeyPath` reaches
      // the one call that is allowed to create a key: without it a caller that
      // redirected every other file would still spend a seat against the real
      // `~/.engager`.
      deviceKey: readOrMintDeviceKey(opts.deviceKeyPath),
      deviceKeyPath: opts.deviceKeyPath,
      ...(opts.cachePath === undefined ? {} : { cachePath: opts.cachePath }),
      ...(opts.publicKey === undefined ? {} : { publicKey: opts.publicKey }),
      ...(opts.issuer === undefined ? {} : { issuer: opts.issuer }),
      ...(opts.post === undefined ? {} : { post: opts.post }),
    });
  } catch {
    // `refreshManagedCapability` is total today; this is the pin for that
    // promise where the call sites cannot make one — a route handler and the
    // supervisor's adopt round trip each have to answer something either way.
    return "failed";
  }
}
