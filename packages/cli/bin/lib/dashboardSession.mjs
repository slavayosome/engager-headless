import { createHmac, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { openDevelopmentBrowser } from "./developmentBrowser.mjs";

/**
 * THE ONE PLACE A DASHBOARD BECOMES THE MAINTAINED APP. Inside the `.app`
 * bundle the child is served under a plan (owner decision, 2026-09-22: the
 * monthly Mac plan must be active for the app to be usable), and
 * `ENGAGER_MANAGED_APP` identifies maintained native execution
 * (`managedAppArmed()` in `packages/core/entitlements/entitlementClient.ts`).
 *
 * `inAppBundle` is passed in rather than probed: this module has no package
 * directory of its own to look at, and the caller already decided it once at
 * startup. A checkout, the free archive and `npm run up` never arm, so they are
 * free core execution. Every dashboard has its own mandatory cloud gate.
 *
 * The key is written AFTER the caller's env is spread, deliberately:
 * `~/.engager/.env` is user-writable and merged into that env, so a value
 * written there must not be able to disarm a bundle launch. Outside the bundle
 * a hand-set key is left exactly as it is — it gates the person who set it and
 * nobody else, and removing it would take away the only way to exercise the
 * door on a machine without a signed build.
 */
export function managedAppEnvironment(env, inAppBundle) {
  return inAppBundle ? { ...env, ENGAGER_MANAGED_APP: "1" } : { ...env };
}

/** Browser credentials travel in a fragment, never terminal output or an
 * HTTP request URL. The wrapper already supplies its own bridge credential
 * and opens its own window, so it needs no second browser launch. */
export function dashboardEnvironment(env, port, options = {}) {
  if (env.ENGAGER_BRIDGE_TOKEN) return { ...env };
  const token = randomBytes(32).toString("base64url");
  const result = { ...env, ENGAGER_BRIDGE_TOKEN: token };
  const fetchImpl = options.fetchImpl ?? fetch;
  const open = options.open ?? openBrowser;
  const sleep =
    options.sleep ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const origin = `http://127.0.0.1:${port}`;
  const challenge = randomBytes(24).toString("hex");
  const expectedProof = createHmac("sha256", token)
    .update(challenge)
    .digest("hex");
  void (async () => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        const response = await fetchImpl(
          `${origin}/api/health?sessionChallenge=${challenge}`,
          { signal: AbortSignal.timeout(1000) },
        );
        // A process squatting on the port must not receive a fragment token
        // in a browser it controls. Prove this is our child before opening.
        if (
          (response.ok || response.status === 503) &&
          response.headers.get("x-engager-session-proof") === expectedProof
        ) {
          open(`${origin}/unlock#${token}`);
          return;
        }
      } catch {
        /* The dashboard is still starting. */
      }
      await sleep(500);
    }
  })().catch(() => {
    // Opening a browser must never expose its credential through an error.
  });
  return result;
}

function openBrowser(url) {
  if (process.env.ENGAGER_DEV_APP === "1") return openDevelopmentBrowser(url);
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "rundll32"
        : "xdg-open";
  const args =
    process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}
