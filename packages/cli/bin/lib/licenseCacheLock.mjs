import { withPathLock } from "./pathLock.mjs";

/** The licence cache's own name for the shared bakery lock in `pathLock.mjs`.
 * One contender at a time refreshes a cache file; the mechanism is generic and
 * the bundled cluster's bring-up holds the same kind of ticket, which is why
 * the timeout message is the caller's word rather than the lock's. */
export async function withLicenseRefreshLock(cachePath, work, options = {}) {
  return withPathLock(cachePath, work, { ...options, busyMessage: "License refresh busy" });
}
