// The local half of the Phase 16 route contract: three POSTs against the
// Engager-owned cloud, written against the handlers as they landed
// (apps/cloud/app/api/device/start, device/poll, license/refresh route.ts)
// -- every field name and status code below was read off those files, not
// sketched ahead of them.
//
// INV-19: this is the only Engager-added service endpoint a local install
// calls, and it holds no provider secret -- the refresh token travels in the
// request body, never a header. INV-17: `issuedAtSeconds` below is a
// wire-format read of the fresh token's `iat` segment, not a claims
// interpretation -- no signature is checked here and no allowance is
// derived; it exists only so the cache writers (T-17.5, T-17.8) can stamp
// `maxServerTimeSeen` without each re-implementing the token format.
//
// All three calls answer their own 429 as a typed `rate_limited` member
// rather than an opaque throw -- the start route's 429 is exactly the poll
// and refresh routes' (apps/cloud/app/api/device/start/route.ts:41-43), and a
// caller with no typed answer for it would be forced to string-match a
// thrown message to tell "rate limited" from every other failure.
import { createHash, randomUUID, type KeyObject } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { withLicenseRefreshLock } from "./licenseRefreshLock";
import {
  accountDisplay,
  licenseFilePath,
  readCachedLicense,
  verifyLicenseToken,
  writeCachedLicense,
} from "./license";
import { licenseRequired } from "./licenseMode";
import { resolveDeploymentEnvironment } from "@engager/database/environment";

/** Hard per-request deadline. Exported so tests can assert every call carries it. */
export const LICENSE_REQUEST_TIMEOUT_MS = 10_000;

import { CLOUD_BASE_URL, cloudBaseUrl } from "./cloudUrl";

const MAX_ATTEMPTS = 3;

/** Protocol failures and transport failures are DIFFERENT vocabularies (see
 * module doc): a network error, a timeout, an exhausted retry budget, a 5xx,
 * or a body that does not parse into the expected shape all throw this,
 * carrying a status and a short message -- never a token, refresh token, or
 * device code. */
export class LicenseClientError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "LicenseClientError";
    if (status !== undefined) this.status = status;
  }
}

/** Re-exported from `cloudUrl.ts` (its home now -- see that file for why
 * the base URL lives in a module without Node imports) so every existing
 * import site keeps working. */
export { cloudBaseUrl };

export interface DeviceAuthStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

/** Mirrors `PollDeviceAuthResult`/`RefreshLicenseResult`'s own `rate_limited`
 * member: the start route answers the same 429 the other two do, and a
 * caller needs a typed answer for it rather than an opaque throw. */
export type StartDeviceAuthResult =
  | ({ status: "started" } & DeviceAuthStart)
  | { status: "rate_limited" };

export type PollDeviceAuthResult =
  | {
      status: "claimed";
      token: string;
      refreshToken: string;
      issuedAtSeconds: number;
    }
  | {
      status:
        | "authorization_pending"
        | "slow_down"
        | "expired_token"
        | "access_denied";
    }
  | { status: "rate_limited" };

export type RefreshLicenseResult =
  | {
      status: "ok";
      token: string;
      refreshToken: string;
      issuedAtSeconds: number;
    }
  | { status: "invalid_grant" }
  | { status: "rate_limited" };

function jitter(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A 5xx or a 429 is worth retrying; a network/timeout rejection is worth
 * retrying; every other 4xx is a protocol answer and must never be retried
 * inside one call -- `authorization_pending` is the normal steady state of a
 * device flow, and retrying it here would multiply the poll rate the server
 * enforces through `lastPolledAt`. */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

/** Reads the `iat` claim off the token's base64url payload segment without
 * checking the signature -- transport metadata only (INV-17). */
function decodeIssuedAtSeconds(token: string): number {
  const [payloadSegment] = token.split(".");
  if (!payloadSegment) {
    throw new LicenseClientError("malformed license token");
  }
  const padded = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
  // Node's Buffer silently drops characters outside the base64 alphabet, so a
  // segment that is not a token at all decodes to garbage instead of failing.
  // Reject it here so a mangled wire response surfaces as a LicenseClientError.
  if (!/^[A-Za-z0-9+/]*$/.test(padded)) {
    throw new LicenseClientError("malformed license token");
  }
  const padding =
    padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(padded + padding, "base64").toString("utf8"),
    );
  } catch {
    throw new LicenseClientError("malformed license token");
  }
  const iat = (parsed as { iat?: unknown } | null)?.iat;
  if (typeof iat !== "number") {
    throw new LicenseClientError("malformed license token");
  }
  return iat;
}

/** One POST, with the shared timeout, jittered retry, and error vocabulary.
 * `path` is joined onto `cloudBaseUrl()` fresh on every call rather than
 * once at module scope, so a test that flips the license gate between calls
 * observes the right base URL each time. Exported: `entitlementClient.ts`
 * is its second caller, alongside the three license-flow functions below —
 * one retry policy and one base URL for every Engager-owned cloud route a
 * local install calls. */
export async function cloudPost(
  path: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const url = `${cloudBaseUrl()}${path}`;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(LICENSE_REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      if (attempt < MAX_ATTEMPTS) {
        await sleep(jitter(150, 400) * attempt);
        continue;
      }
      const msg = e instanceof Error ? e.message : String(e);
      throw new LicenseClientError(`cloud request failed (${path}): ${msg}`);
    }

    if (isRetryableStatus(res.status) && attempt < MAX_ATTEMPTS) {
      await sleep(jitter(150, 400) * attempt);
      continue;
    }

    let json: unknown;
    try {
      const text = await res.text();
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new LicenseClientError(
        `cloud response was not JSON (${path})`,
        res.status,
      );
    }

    if (res.status >= 500) {
      throw new LicenseClientError(
        `cloud request failed (${path})`,
        res.status,
      );
    }

    return { status: res.status, json };
  }
  // Every branch of the loop above returns or throws by the last attempt
  // (attempt === MAX_ATTEMPTS never takes a `continue`); this satisfies the
  // compiler, not a reachable runtime path.
  throw new LicenseClientError(
    `cloud request failed (${path}): retry budget exhausted`,
  );
}

export async function startDeviceAuth(opts: {
  clientName: string;
}): Promise<StartDeviceAuthResult> {
  const { status, json } = await cloudPost("/api/device/start", {
    clientName: opts.clientName,
  });

  if (status === 429) {
    return { status: "rate_limited" };
  }

  if (status !== 200) {
    const error = (json as { error?: unknown } | null)?.error;
    throw new LicenseClientError(
      `device start failed: ${typeof error === "string" ? error : "unknown"}`,
      status,
    );
  }
  const body = json as Partial<DeviceAuthStart> | null;
  if (
    typeof body?.deviceCode !== "string" ||
    typeof body?.userCode !== "string" ||
    typeof body?.verificationUri !== "string" ||
    typeof body?.expiresIn !== "number" ||
    typeof body?.interval !== "number"
  ) {
    throw new LicenseClientError("device start response was malformed", status);
  }
  return {
    status: "started",
    deviceCode: body.deviceCode,
    userCode: body.userCode,
    verificationUri: body.verificationUri,
    expiresIn: body.expiresIn,
    interval: body.interval,
  };
}

const POLL_ERROR_TO_STATUS: Record<
  string,
  "authorization_pending" | "slow_down" | "expired_token" | "access_denied"
> = {
  authorization_pending: "authorization_pending",
  slow_down: "slow_down",
  expired_token: "expired_token",
  access_denied: "access_denied",
};

export async function pollDeviceAuth(opts: {
  deviceCode: string;
}): Promise<PollDeviceAuthResult> {
  const { status, json } = await cloudPost("/api/device/poll", {
    deviceCode: opts.deviceCode,
  });

  if (status === 429) {
    return { status: "rate_limited" };
  }

  if (status === 400) {
    const error = (json as { error?: unknown } | null)?.error;
    const mapped =
      typeof error === "string" ? POLL_ERROR_TO_STATUS[error] : undefined;
    if (!mapped) {
      throw new LicenseClientError(
        `device poll returned an unknown answer`,
        status,
      );
    }
    return { status: mapped };
  }

  if (status !== 200) {
    throw new LicenseClientError("device poll failed", status);
  }

  const body = json as { token?: unknown; refreshToken?: unknown } | null;
  if (
    typeof body?.token !== "string" ||
    typeof body?.refreshToken !== "string"
  ) {
    throw new LicenseClientError("device poll response was malformed", status);
  }
  return {
    status: "claimed",
    token: body.token,
    refreshToken: body.refreshToken,
    issuedAtSeconds: decodeIssuedAtSeconds(body.token),
  };
}

export async function refreshLicense(opts: {
  refreshToken: string;
  operationId?: string;
  post?: typeof cloudPost;
}): Promise<RefreshLicenseResult> {
  const { status, json } = await (opts.post ?? cloudPost)("/api/license/refresh", {
    refreshToken: opts.refreshToken,
    operationId: opts.operationId ?? randomUUID(),
  });

  if (status === 429) {
    return { status: "rate_limited" };
  }

  if (status === 401) {
    return { status: "invalid_grant" };
  }

  if (status !== 200) {
    throw new LicenseClientError("license refresh failed", status);
  }

  const body = json as { token?: unknown; refreshToken?: unknown } | null;
  if (
    typeof body?.token !== "string" ||
    typeof body?.refreshToken !== "string"
  ) {
    throw new LicenseClientError(
      "license refresh response was malformed",
      status,
    );
  }
  return {
    status: "ok",
    token: body.token,
    refreshToken: body.refreshToken,
    issuedAtSeconds: decodeIssuedAtSeconds(body.token),
  };
}

/** Install-scoped, in-memory throttle for `maybeRefreshLicense` -- once per
 * six hours, never a job row and never per-org (it dies with the process). */
const REFRESH_THROTTLE_MS = 6 * 60 * 60_000;
let lastRefreshAttemptAt = 0;

/** Test-only: drop the throttle stamp so the next call attempts a fresh
 * refresh, the shape `resetLicenseEntitlementCache` (license.ts:233-237)
 * already uses for its own module-level memo. */
export function resetLicenseRefreshThrottle(): void {
  lastRefreshAttemptAt = 0;
}

interface MaybeRefreshLicenseOptions {
  now?: Date;
  path?: string;
  publicKey?: KeyObject;
  post?: typeof cloudPost;
  /** Skip the six-hour throttle -- the sign-in wall's "check again", where
   * the owner has just subscribed and a refresh that waits until the next
   * tick is a wall that stays up for hours. The stamp is still written, so
   * the background tick after a forced check stays throttled. */
  force?: boolean;
  /** Replay only an already persisted rotation; never start a new one. */
  pendingOnly?: boolean;
}

/** The background refresh hook every call site (agent boot, the scheduler
 * tick, the dashboard staleness check -- all T-17.8) drops in instead of
 * `refreshLicense` directly. TOTAL: every failure path -- the gate off, no
 * cache, the throttle, a thrown LicenseClientError, `invalid_grant`,
 * `rate_limited`, a token that fails to verify, an unwritable file --
 * resolves `false` and nothing propagates, so none of the three call sites
 * needs a try/catch of its own. Resolves `true` only when the cache file was
 * rewritten. The outer try/catch below is the pin for that promise where the
 * body itself cannot make one: `licenseRequired()`, `readCachedLicense()`,
 * and `verifyLicenseToken()` are documented as never throwing today, but the
 * blast radius if one ever did is asymmetric -- `scripts/agent.ts` top-level-
 * awaits this call before `startScheduler()`, so an uncaught throw here
 * would stop the sidecar short of the scheduler and halt all unattended
 * work. */
export async function maybeRefreshLicense(
  opts?: MaybeRefreshLicenseOptions,
): Promise<boolean> {
  return (await licenseRefreshOutcome(opts)) === "refreshed";
}

/** Why a refresh did or did not rewrite the cache -- `maybeRefreshLicense`
 * collapses this to a boolean for the background ticks; the sign-in wall
 * reads the word, because `invalid_grant` (a consumed or revoked refresh
 * token) has exactly one way out, signing in again, and a wall that kept
 * saying "still no active plan" over it was a dead end. */
export type LicenseRefreshOutcome =
  | "refreshed"
  | "gate_off"
  | "no_cache"
  | "throttled"
  | "invalid_grant"
  | "rate_limited"
  | "unverifiable"
  | "unwritable"
  | "failed";

/** Total, like `maybeRefreshLicense`: a throw anywhere is `"failed"`. */
export async function licenseRefreshOutcome(
  opts?: MaybeRefreshLicenseOptions,
): Promise<LicenseRefreshOutcome> {
  try {
    return await attemptLicenseRefresh(opts);
  } catch {
    return "failed";
  }
}

async function attemptLicenseRefresh(
  opts?: MaybeRefreshLicenseOptions,
): Promise<LicenseRefreshOutcome> {
  // Gate-off inertia: a checkout has no install to license and must never
  // phone home. The explicit-path exception is deliberate and narrow, and it
  // mirrors verifyLicenseToken's publicKey override (license.ts:128-129):
  // overrides exist only where the gate is off (INV-18), so a caller that
  // supplies its own file path -- the unit suite, the fixture e2e -- gets a
  // live code path without arming the gate itself.
  if (opts?.path === undefined && (["local", "test"].includes(resolveDeploymentEnvironment()) || !licenseRequired())) {
    return "gate_off";
  }

  const cachePath = opts?.path ?? licenseFilePath();
  return withLicenseRefreshLock(cachePath, () =>
    refreshLocked(opts, cachePath),
  );
}

async function refreshLocked(
  opts: MaybeRefreshLicenseOptions | undefined,
  cachePath: string,
): Promise<LicenseRefreshOutcome> {
  // No cache, no refresh -- signing in is the device flow's job, not a
  // background tick's.
  const cache = readCachedLicense(opts?.path);
  if (!cache) {
    return "no_cache";
  }

  const now = opts?.now ?? new Date();
  if (
    !opts?.force &&
    now.getTime() - lastRefreshAttemptAt < REFRESH_THROTTLE_MS
  ) {
    return "throttled";
  }
  // Stamped BEFORE the network call, so a hung request cannot let the next
  // tick pile a second one on top.
  lastRefreshAttemptAt = now.getTime();

  let result: RefreshLicenseResult;
  try {
    // Persist the operation before the first request, independently of the
    // license cache: a failed refresh leaves the valid cached license intact.
    const parentHash = createHash("sha256")
      .update(cache.refreshToken)
      .digest("hex");
    const operationPath = `${cachePath}.refresh`;
    let operationId: string | undefined;
    try {
      const saved = JSON.parse(readFileSync(operationPath, "utf8"));
      if (
        saved.parentHash === parentHash &&
        typeof saved.operationId === "string"
      )
        operationId = saved.operationId;
    } catch {
      /* no operation for this parent yet */
    }
    if (!operationId) {
      if (opts?.pendingOnly) return "no_cache";
      operationId = randomUUID();
      const temporary = `${operationPath}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify({ parentHash, operationId }), {
          mode: 0o600,
        });
        renameSync(temporary, operationPath);
      } finally {
        rmSync(temporary, { force: true });
      }
    }
    result = await refreshLicense({
      refreshToken: cache.refreshToken,
      operationId,
      post: opts?.post,
    });
  } catch {
    // INV-16, literal here: no rmSync, no truncating write, no "clear the
    // bad cache" branch. A still-valid cached license outlives every failed
    // refresh until its own exp.
    return "failed";
  }
  if (result.status !== "ok") {
    // invalid_grant and rate_limited are exactly as soft -- the file is
    // untouched either way.
    return result.status;
  }

  const verification = verifyLicenseToken(result.token, {
    now,
    publicKey: opts?.publicKey,
  });
  if (!verification.valid) {
    // A 200 whose token does not verify locally is dropped rather than
    // written -- replacing a working license with an unverifiable one would
    // spend the remaining grace for nothing. The persisted operation can
    // recover this exact signed response after a temporary clock/key issue.
    return "unverifiable";
  }

  try {
    // Signing out or replacing the account during the request wins.
    if (readCachedLicense(cachePath)?.refreshToken !== cache.refreshToken)
      return "no_cache";
    writeCachedLicense(
      {
        token: result.token,
        refreshToken: result.refreshToken,
        ...accountDisplay(cache),
        ...(cache.termsAcceptedAt === undefined ? {} : { termsAcceptedAt: cache.termsAcceptedAt }),
        // Monotone, never backward -- the clock-rollback check exists to
        // distrust the CACHE, and this write advances that evidence with a
        // token the server just minted.
        maxServerTimeSeen: Math.max(
          cache.maxServerTimeSeen,
          verification.claims.iat,
        ),
      },
      opts?.path,
    );
  } catch {
    return "unwritable";
  }
  return "refreshed";
}

/** A response can be lost after the cloud consumes its parent credential.
 * Replay the saved operation under the ordinary cache lock, then let the
 * caller perform fresh cloud authorization with the recovered credential. */
export async function recoverPendingLicenseRefresh(opts: {
  path?: string; post?: typeof cloudPost; publicKey?: KeyObject; now?: Date;
} = {}): Promise<boolean> {
  return maybeRefreshLicense({ ...opts, path: opts.path ?? licenseFilePath(), force: true, pendingOnly: true });
}

/** User-initiated cloud control needs authentication even on a free local
 * install. This explicit boundary bypasses only the background no-phone-home
 * guard, and shares the normal recovery receipt and cache mutation lock.
 * A transient failure may use a still-valid credential; an expired one fails. */
export async function refreshCloudCredentials(
  opts: { path?: string; now?: Date; publicKey?: KeyObject } = {},
): Promise<boolean> {
  const path = opts.path ?? licenseFilePath();
  const outcome = await licenseRefreshOutcome({ ...opts, path, force: true });
  if (outcome === "refreshed") return true;
  if (outcome === "invalid_grant" || outcome === "no_cache") return false;
  const cache = readCachedLicense(path);
  return (
    cache !== null &&
    verifyLicenseToken(cache.token, {
      now: opts.now ?? new Date(),
      publicKey: opts.publicKey,
    }).valid
  );
}
