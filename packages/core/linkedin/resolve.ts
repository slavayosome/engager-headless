import { config } from "../config";
import { developmentBuild } from "@engager/common/development";
import { BrowserUseTransportError } from "./browser-use/transportError";
import type { LinkedInDriver } from "./driver";
import { browserProfileDir } from "./session";

/**
 * One construction per key, so a connector that must not exist twice does not.
 *
 * Replaces the unkeyed `sharedBrowserUse` slot: one process now resolves more
 * than one channel, and a single slot for all of them would hand the second
 * channel whatever the first one opened. The memo lives at module level, which
 * also means it resets with the module graph — exactly what env-driven driver
 * tests rely on.
 *
 * A rejected construction is EVICTED rather than kept. The sidecar's module
 * load is the only thing that can fail in here, and remembering that failure
 * would poison every later grant in the process over one bad import.
 */
const constructions = new Map<string, Promise<LinkedInDriver>>();

function memoizedConstruction(
  key: string,
  build: () => Promise<LinkedInDriver>,
): Promise<LinkedInDriver> {
  const memoized = constructions.get(key);
  if (memoized) return memoized;
  const construction: Promise<LinkedInDriver> = build().catch(
    (error: unknown) => {
      if (constructions.get(key) === construction) constructions.delete(key);
      throw error;
    },
  );
  constructions.set(key, construction);
  return construction;
}

/**
 * The key the process's ONE browser-use sidecar is memoized under.
 *
 * The PROFILE, not the channel: a sidecar is one per browser profile, because
 * only a single Chromium may hold one. A second one does NOT deadlock on the
 * lock — the python journal takes a non-blocking flock and refuses — but it is
 * still a sidecar that cannot work, so there must never be two. Two channels
 * bound to one profile are therefore one sidecar, which is why
 * `openLocalBrowser` adds no key of its own.
 *
 * `browserProfileDir()` rather than the raw env string, so the key is the
 * DIRECTORY: unset and set-to-the-sidecar's-own-default are one profile, and so
 * are `~/x` and `/Users/o/x`. That is the same normalization the sidecar itself
 * applies (bridge.py's expanduser), which is what makes this the physical
 * identity rather than one spelling of it.
 */
function localBrowserKey(): string {
  return `local_browser:${browserProfileDir()}`;
}

/**
 * Hand the local browser profile back: close this process's sidecar (which
 * closes Chrome) and forget the memo, so the next grant builds a fresh one.
 *
 * PROCESS EXIT ONLY now. The per-job lease this file used to carry
 * (`withLocalBrowserLease`) existed so other processes could grab the profile
 * between jobs; they reach the browser through the standing bridge instead,
 * and a per-job release would only re-create the open/close churn the bridge
 * removed. What remains is the promise that nothing outlives its process —
 * the worker's exit path, and the fallback processes' signal hooks, call
 * this so a sidecar never orphans a Chrome holding the profile.
 *
 * Safe to call when nothing was ever built — that is the common case, since
 * most jobs never touch the browser at all.
 */
export async function releaseLocalBrowser(): Promise<void> {
  const key = localBrowserKey();
  const construction = constructions.get(key);
  if (!construction) return;
  constructions.delete(key);
  try {
    // `close` is the browser driver's own, not part of the LinkedInDriver
    // contract every connector implements. Read it structurally rather than
    // widening the interface for one connector's lifecycle.
    const driver = (await construction) as { close?: () => Promise<void> };
    await driver.close?.();
  } catch {
    // A driver that never built, or a sidecar already gone: the memo is the
    // only thing this function promises to clear.
  }
}

/**
 * The subprocess sidecar's module, or a refusal in the transport's own
 * taxonomy.
 *
 * `apps/dashboard/next.config.mjs` keeps this one webpack-ignored, because a
 * Next server owns no Chrome and the packaged dashboard carries the python
 * project at `dist/python`, not beside its own bundle. An ignored request
 * rejects with MODULE_NOT_FOUND, so the ONE route a bundled app can still take
 * when the bridge is unreachable — the subprocess fallback — must translate
 * into the retryable local-transport failure it has always been. A bare
 * resolution fault reads like a broken install; a second holder is worse.
 */
async function importSubprocessTransport(): Promise<
  typeof import("./browser-use/subprocessTransport")
> {
  try {
    return await import("./browser-use/subprocessTransport");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") {
      throw error;
    }
    throw new BrowserUseTransportError(
      "the browser sidecar transport is not bundled in this process",
    );
  }
}

/**
 * Build one local-browser driver. Pure over its inputs so the write-authority
 * contract is testable without a database: `writesEnabled: false` constructs
 * a driver whose writes fail before any request reaches the sidecar, so no
 * page is visited, nothing is journaled and no composer is filled. Loaded via dynamic import() so bundlers
 * (the local dashboard) reach the transport-independent client and driver while
 * the subprocess transport stays on its own side of the boundary.
 */
export async function buildLocalBrowserDriver(opts: {
  profileDir: string | undefined;
  idleReleaseMs: number;
  writesEnabled: boolean;
  browserHidden?: "true" | "false" | undefined;
  browserExecutable?: string | undefined;
}): Promise<LinkedInDriver> {
  const { BrowserUseClient } = await import("./browser-use/client");
  const { BrowserUseDriver } = await import("./browser-use/driver");
  const { SubprocessBrowserUseTransport } = await importSubprocessTransport();
  const { profileDir } = opts;
  if (!opts.writesEnabled) {
    // Read-only by default: every write fails before it is requested.
    return new BrowserUseDriver(
      new BrowserUseClient({
        transport: new SubprocessBrowserUseTransport({
          ...(profileDir ? { profileDir } : {}),
          ...(opts.browserExecutable ? { browserExecutable: opts.browserExecutable } : {}),
          ...(opts.browserHidden ? { browserHidden: opts.browserHidden } : {}),
          env: browserMediaChildEnv(),
          idleReleaseMs: opts.idleReleaseMs,
        }),
      }),
    );
  }
  // Write authority was granted deliberately — the dashboard's write switch,
  // read off the channel row at construction. It is the one write gate the
  // driver holds, not the only one: canEngage() (which re-reads the flag per
  // write), the kill switch, pacing, per-profile caps and explicit message
  // approval all run upstream in the action gate.
  const client = new BrowserUseClient({
    transport: new SubprocessBrowserUseTransport({
      ...(profileDir ? { profileDir } : {}),
      ...(opts.browserExecutable ? { browserExecutable: opts.browserExecutable } : {}),
      ...(opts.browserHidden ? { browserHidden: opts.browserHidden } : {}),
      env: browserMediaChildEnv(),
      idleReleaseMs: opts.idleReleaseMs,
    }),
  });
  return new BrowserUseDriver(client, { writesEnabled: true });
}

/**
 * The media switch as the sidecar must receive it: STATED, never inherited.
 *
 * `CHILD_ENV_ALLOWLIST` is ambient plumbing — paths, locale, certificates,
 * proxies — and carries no Engager variable at all. A product switch smuggled
 * into it is drift: the packaged CLI
 * restates that same list for `uv`, and handing uv a browser setting it has no
 * use for is not what "what one may see the other may see" means.
 * `ENGAGER_BROWSER_HIDDEN`, this switch's documented sibling, is read by the
 * parent and passed explicitly for exactly that reason; env rather than its
 * `--browser-hidden` argv only because the sidecar already reads this one from
 * the environment, and a second spelling of one setting is worse than either.
 *
 * A locally launched Chrome — free bytes, an owner who may be watching the
 * window — does not block media unless the owner set the switch.
 */
export function browserMediaChildEnv(): Readonly<Record<string, string>> {
  const owner = process.env.ENGAGER_BROWSER_BLOCK_MEDIA?.trim();
  return owner ? { ENGAGER_BROWSER_BLOCK_MEDIA: owner } : {};
}

/**
 * Marks THIS process as the bridge's owner — set by the bridge server before
 * it serves anything, so the owner's own grants keep building the subprocess
 * sidecar instead of routing to themselves over loopback.
 */
let bridgeOwner = false;
let localSessionOwner = false;
export function markLocalBridgeOwner(owner = true, sessionOnly = false): void {
  bridgeOwner = owner;
  localSessionOwner = sessionOnly;
}

/**
 * Build a driver over the standing bridge instead of a subprocess of our own.
 *
 * The write gate stays in THIS process, mirroring
 * `buildLocalBrowserDriver`'s split exactly: a caller constructed read-only
 * sends no write request and cannot write, whatever the agent's sidecar
 * would accept. `canEngage` re-reads the flag per write.
 */
async function buildBridgeDriver(opts: {
  endpoint: { url: string; token: string };
  writesEnabled: boolean;
  /** Which memo entry a dead bridge evicts — the caller's key. */
  memoKey: string;
}): Promise<LinkedInDriver> {
  const { BrowserUseClient, BrowserUseTransportError } = await import(
    "./browser-use/client"
  );
  const { BrowserUseDriver } = await import("./browser-use/driver");
  const { HttpBrowserUseTransport } = await import(
    "./browser-use/remoteTransport"
  );
  const inner = new HttpBrowserUseTransport(opts.endpoint);
  // A bridge that dies (agent restart: new port, new token) must not poison
  // the memo for the life of this process: evict on transport failure, so the
  // FAILING op still fails (its caller already retries) and the next grant
  // re-discovers — landing on the new bridge, or on the subprocess fallback.
  const transport: typeof inner = {
    send: async (request, options) => {
      try {
        return await inner.send(request, options);
      } catch (error) {
        if (error instanceof BrowserUseTransportError) {
          constructions.delete(opts.memoKey);
        }
        throw error;
      }
    },
    close: () => inner.close(),
  } as typeof inner;
  const client = new BrowserUseClient({ transport });
  if (!opts.writesEnabled) return new BrowserUseDriver(client);
  return new BrowserUseDriver(client, { writesEnabled: true });
}

/**
 * The local browser connector for this process. `ENGAGER_BROWSER_PROFILE_DIR`
 * says HOW to open it; write authority comes off the channel row (the flag
 * that retired `ENGAGER_BROWSER_WRITES`), read fresh at construction and
 * fail-closed when the read cannot answer. Construction happens outside any
 * caller's tx by the same contract that keeps driver I/O out of transactions.
 *
 * The memo can hold this answer for the life of a construction, and the
 * authoritative per-write check lives in `canEngage` for exactly that reason:
 * a flip lands there immediately, while a stale-ON construction here fails
 * safe at the next send, where `canEngage` reads it again.
 *
 * WHERE the browser lives is decided here too: when the standing bridge (the
 * agent's loopback holder) is reachable for this profile, the driver routes
 * over it and no subprocess is spawned — one Chrome for the whole install.
 * The subprocess path survives as the fallback (the agent itself, the agent
 * down, `ENGAGER_BROWSER_BRIDGE=off`), where the journal flock still guards
 * the profile.
 */
export function browserUseDriverFromEnv(): Promise<LinkedInDriver> {
  // THE OWNER REBUILDS ITS DRIVER PER GRANT, deliberately unmemoized: the
  // transport underneath is the bridge's one persistent sidecar, so a build
  // spawns nothing — and the driver's write gate then follows every flip of
  // `writes_enabled` immediately, where the per-job release used to be what
  // refreshed a stale-OFF construction.
  if (bridgeOwner) return buildOwnerDriver();
  return memoizedConstruction(localBrowserKey(), async () => {
    const writesEnabled = await readWriteAuthority();
    if (config.browserUse.bridgeEnabled() || process.env.ENGAGER_BROWSER_SESSION_FILE) {
      const { discoverBridge } = await import(
        "./browser-use/remoteTransport"
      );
      const endpoint = await discoverBridge();
      if (endpoint) {
        return buildBridgeDriver({
          endpoint,
          writesEnabled,
          memoKey: localBrowserKey(),
        });
      }
      // A drain must never fall back to a second sidecar when its session's
      // holder disappears. Any interrupted write keeps its journal evidence.
      if (process.env.ENGAGER_BROWSER_SESSION_FILE) {
        throw new Error("browser_session_unavailable");
      }
    }
    const { startSessionBrowser } = await import("./browser-use/sessionBrowser");
    if (await startSessionBrowser()) return buildOwnerDriver();
    return buildLocalBrowserDriver({
      profileDir: config.browserUse.profileDir(),
      idleReleaseMs: config.browserUse.idleReleaseMs(),
      writesEnabled,
      browserHidden: config.browserUse.hidden(),
      browserExecutable: config.browserUse.executable(),
    });
  });
}

async function readWriteAuthority(): Promise<boolean> {
  // A Dev artifact may exercise read-only integration; confirmed sends in
  // acceptance fixtures use MockDriver, never the owner's real account.
  if (developmentBuild()) return false;
  const orgId = config.organizationId();
  if (!orgId) return false;
  try {
    const { getChannelWriteAuthority } = await import(
      "../operations/orgSettings"
    );
    const { withOrg } = await import("@engager/database/tenant");
    return await withOrg(orgId, (tx) => getChannelWriteAuthority(tx));
  } catch {
    // No database to ask is no authority granted — the read-only driver
    // still serves every read lane.
    return false;
  }
}

async function buildOwnerDriver(): Promise<LinkedInDriver> {
  const [{ queuedOwnerTransport }, { BrowserUseClient }, { BrowserUseDriver }] =
    await Promise.all([
      import("./browser-use/bridgeServer"),
      import("./browser-use/client"),
      import("./browser-use/driver"),
    ]);
  const client = new BrowserUseClient({ transport: queuedOwnerTransport() });
  if (!(await readWriteAuthority())) return new BrowserUseDriver(client);
  return new BrowserUseDriver(client, { writesEnabled: true });
}
