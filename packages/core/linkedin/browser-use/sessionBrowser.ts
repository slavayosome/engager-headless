import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../../config";

let enabled = false;
let stopped = false;
let starting: Promise<boolean> | undefined;
let directory: string | undefined;

/** Only the standalone interactive server owns this session lifetime. */
export function enableSessionBrowser(): void {
  enabled = true;
  stopped = false;
}

/** Called by a local connector or before a session-owned drain.
 * No browser is launched until the first operation reaches the shared FIFO. */
export function startSessionBrowser(): Promise<boolean> {
  if (stopped) return Promise.reject(new Error("browser_session_closed"));
  if (!enabled) return Promise.resolve(false);
  starting ??= (async () => {
    if (process.env.ENGAGER_BROWSER_SESSION_FILE) return false;
    if (config.browserUse.bridgeEnabled()) {
      const { discoverBridge } = await import("./remoteTransport");
      if (await discoverBridge()) return false;
    }
    const { startBrowserBridge } = await import("./bridgeServer");
    directory = mkdtempSync(join(tmpdir(), "engager-browser-session-"));
    const sessionFile = join(directory, "bridge.json");
    const bridge = await startBrowserBridge({ sessionFile });
    if (!bridge) throw new Error("browser_session_unavailable");
    process.env.ENGAGER_BROWSER_SESSION_FILE = sessionFile;
    return true;
  })();
  const attempt = starting;
  return attempt.then(started => {
    // A standing holder may disappear before the next grant. Rediscover then.
    if (!started && starting === attempt) starting = undefined;
    return started;
  });
}

export async function stopSessionBrowser(): Promise<void> {
  enabled = false;
  stopped = true;
  await starting?.catch(() => undefined);
  if (directory) {
    const { stopBrowserBridge } = await import("./bridgeServer");
    await stopBrowserBridge();
    rmSync(directory, { recursive: true, force: true });
    directory = undefined;
    delete process.env.ENGAGER_BROWSER_SESSION_FILE;
  }
  starting = undefined;
}
