import { withLicenseRefreshLock } from "./licenseCacheLock.mjs";
// engager login / engager logout -- the standalone CLI's device-code path.
// The maintained Mac signs in through its Google/email app-session flow.
// This module never holds a device code: it only ever sees the local
// dashboard proxy's own answers, and those answers never carry one -- see
// apps/dashboard/app/api/license/device/route.ts's module doc for why. It
// cannot import packages/core/entitlements/license.ts's writeCachedLicense either --
// packages/cli/bin/engager.mjs is dependency-free plain JS with no type
// surface -- which is the whole reason `login` proxies through the
// dashboard's Next server instead of calling the cloud itself.
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** POST one device-flow action against the local dashboard's proxy route.
 * The body sent is always exactly `{ action }` -- the CLI never attaches a
 * deviceCode because it was never handed one.
 *
 * Deliberately does not check `res.ok`: the route's module doc
 * (apps/dashboard/app/api/license/device/route.ts) guarantees every protocol
 * answer -- `pending`, `slow_down`, `rate_limited`, `expired`, `denied`,
 * `complete` -- is HTTP 200, and every transport failure to the cloud is a
 * fixed `{"status":"error"}` body on a 502. Both parse fine as JSON, so the
 * `status` field alone is what `licenseLogin` below branches on. */
async function post(fetchImpl, baseUrl, action) {
  const res = await fetchImpl(`${baseUrl}/api/license/device`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action }),
  });
  return res.json();
}

/** RFC 8628's device-flow backoff: a `slow_down` answer means the last poll
 * landed inside the server's own interval window, so the next one widens the
 * cadence by five seconds rather than repeating at the same rate. A
 * `rate_limited` or `error` answer gets the identical treatment below -- both
 * are answers the proxy route emits while the sign-in is still live (a
 * `deviceCode` is already pending server-side), so the CLI backs off and
 * keeps polling the SAME flow rather than declaring it dead. Failing fast on
 * either would send the owner back to `engager login`, which POSTs a fresh
 * `start` and REPLACES the route's module-level `pending` -- discarding an
 * approval the owner may already have granted in the browser. */
const SLOW_DOWN_INCREMENT_SEC = 5;

/** RFC 8628's own default, used when the advertised interval is missing or
 * unusable. */
const POLL_INTERVAL_FALLBACK_SEC = 5;
const APP_SIGNIN_MESSAGE = "engager login: open Engager and sign in with Google or email.";

/** The ONLY origin this CLI ever dials for the device flow (INV-19: no
 * service endpoint of its own). It speaks to the local dashboard's own
 * loopback proxy route, never the Engager cloud directly -- the one
 * outbound call to the cloud is the dashboard's, inside
 * apps/dashboard/app/api/license/device/route.ts. */
export function loopbackBaseUrl(port) {
  return `http://127.0.0.1:${port}`;
}

/**
 * Drives one device-code sign-in against the local dashboard's proxy route
 * (`/api/license/device`) and returns an exit code rather than calling
 * `process.exit` -- that is what makes it drivable from a test, the same
 * reason `localEnv.mjs`'s `ensureLocalEnv` takes its `envFile` as an
 * argument instead of resolving one itself.
 *
 * `sleep` has no default: a caller that forgets to inject one gets a
 * TypeError immediately instead of a test that quietly waits on the real
 * clock. `fetchImpl` defaults to the global `fetch` so a real `engager
 * login` invocation needs no wiring beyond `baseUrl`.
 */
export async function licenseLogin({
  baseUrl,
  fetchImpl = fetch,
  sleep,
  log = console.log,
  now = Date.now,
}) {
  let start;
  try {
    start = await post(fetchImpl, baseUrl, "start");
  } catch {
    log(
      "engager login: the dashboard is not running — start `engager up` first.",
    );
    return 1;
  }

  if (start.status === "app_signin_required") {
    log(APP_SIGNIN_MESSAGE);
    return 1;
  }
  if (start.status !== "started") {
    log("engager login: could not start sign-in — try again in a minute.");
    return 1;
  }

  log(
    `engager login: enter code ${start.userCode} at ${start.verificationUri}`,
  );

  // A hard stop at the advertised expiresIn so this can never spin forever
  // against a server that stopped answering meaningfully -- the cloud's own
  // deadline, not one this CLI invents.
  const deadline = now() + start.expiresIn * 1000;
  // The deadline bounds wall time, not request count: an advertised interval of
  // 0 would poll the owner's own dashboard as fast as the loop can run for the
  // whole window. RFC 8628's 5s default is the floor when the answer is absent
  // or unusable, and one second is the floor for anything else.
  let intervalSec = Math.max(
    Number(start.interval) || POLL_INTERVAL_FALLBACK_SEC,
    1,
  );

  while (now() < deadline) {
    await sleep(intervalSec * 1000);

    let poll;
    try {
      poll = await post(fetchImpl, baseUrl, "poll");
    } catch {
      // The dashboard answered when `start` fired -- a throw here is a
      // dropped connection mid-poll, not proof the server is down, so this
      // does not repeat the start-time diagnosis.
      log(
        "engager login: lost the connection to the dashboard partway through — if it's still running, run `engager login` again to retry.",
      );
      return 1;
    }

    // `poll?.` and not `poll.`: the default arm exists for "the server said
    // something unexpected", and a null body would otherwise throw past it as
    // an unhandled rejection -- a stack trace where the owner should get a
    // sentence and an exit code.
    switch (poll?.status) {
      case "app_signin_required":
        log(APP_SIGNIN_MESSAGE);
        return 1;
      case "complete":
        log("engager login: signed in.");
        return 0;
      case "pending":
        continue;
      case "slow_down":
      case "rate_limited":
      case "error":
        intervalSec += SLOW_DOWN_INCREMENT_SEC;
        continue;
      case "denied":
        log(
          "engager login: sign-in was denied — run `engager login` again to retry.",
        );
        return 1;
      case "expired":
        log(
          "engager login: the sign-in code expired — run `engager login` again to retry.",
        );
        return 1;
      default:
        log(
          "engager login: sign-in failed — run `engager login` again to retry.",
        );
        return 1;
    }
  }

  log(
    "engager login: the sign-in code expired — run `engager login` again to retry.",
  );
  return 1;
}

/** Where the cached license lives under a `homeDir` (engager.mjs's own
 * `HOME_DIR`, `path.join(os.homedir(), ".engager")`). Spelled here ONCE so
 * `licenseLogout` below and `engager.mjs`'s `logout` arm never restate it
 * independently -- and so `defaultLicenseFilePath` (also below) and
 * packages/core/entitlements/license.ts's `licenseFilePath()` can be pinned equal by a
 * real test instead of a comment. */
export function cachedLicensePath(homeDir) {
  return path.join(homeDir, "license.json");
}

/** `cachedLicensePath` applied to the real home directory -- what
 * `engager.mjs` actually deletes on a real `engager logout`. Exists
 * separately from `cachedLicensePath` so `licenseLogin.test.ts` can pin this
 * SPECIFIC path, computed independently of any injected test directory,
 * against packages/core/entitlements/license.ts's `licenseFilePath()`. */
export function defaultLicenseFilePath() {
  return cachedLicensePath(path.join(os.homedir(), ".engager"));
}

/** Where the signed capability claims live under the same `homeDir` --
 * `entitlementCachePath()` in packages/core/entitlements/entitlementCache.ts, spelled
 * here for the same reason `cachedLicensePath` is: this module reaches no
 * TypeScript, and `licenseLogin.test.ts` pins the two equal. */
export function cachedClaimsPath(homeDir) {
  return path.join(homeDir, "entitlement.json");
}

/**
 * INV-16: the ONE deletion of this machine's credentials the phase allows, and
 * always an explicit owner act -- never call this from a refresh-failure path.
 * Deletes ONLY `<homeDir>/license.json` and `<homeDir>/entitlement.json`, never
 * `homeDir` itself and nothing else inside it -- the env file, the device key
 * and the sidecar venv survive. `force: true` makes a missing file (an install
 * that never signed in) a no-op success rather than a thrown ENOENT.
 *
 * The claims go with the credential because they are that credential's answer:
 * left behind, they admit the maintained app to the account the owner has just
 * signed out of (`managedAccess()`), so a sign-out would be a sign-out
 * everywhere except the wall. Nothing is lost that signing in again does not
 * fetch, and the DEVICE KEY deliberately stays: it is this machine's seat
 * identity, and minting a new one would spend the account's second seat on the
 * same Mac.
 *
 * `homeDir` has no default, the same shape `licenseLogin`'s `sleep`
 * parameter uses above: a caller that forgets to pass it gets a loud
 * TypeError instead of a test that quietly deletes the real ~/.engager.
 * `engager.mjs`'s `logout` arm passes its own `HOME_DIR` explicitly and does
 * nothing else -- this function is the whole implementation.
 */
export async function licenseLogout({ homeDir, log = console.log }) {
  await withLicenseRefreshLock(cachedLicensePath(homeDir), async () => {
    rmSync(cachedLicensePath(homeDir), { force: true });
    // Inside the same lock: a refresh landing between the two removals would
    // otherwise rewrite one of them against an account that is already gone.
    rmSync(cachedClaimsPath(homeDir), { force: true });
  });
  log("engager logout: removed this machine's cached license and plan claims.");
}
