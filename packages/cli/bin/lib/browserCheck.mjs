// Setup's Browser check (US-OND-05): prove Engager's own browser starts,
// once, before the owner is told this Mac is ready. The pinned Chromium is
// started through the sidecar's own start path on a throwaway profile, asked
// its version over CDP, and closed; the profile is removed. It opens a blank
// page, never a LinkedIn URL, makes no model call, starts no scheduler or
// standing browser, and touches `~/.engager/browser-profile` not at all --
// the owner's LinkedIn login lives there.
//
// It also proves the browser can keep a sign-in (US-OND-09): the sidecar's
// self-check saves a test cookie on a reserved non-LinkedIn host, closes the
// browser gracefully, starts it again on the same profile and reads the
// cookie back. Chromium encrypts its cookie store with a key in the login
// keychain; when macOS refused the browser that key, the cookie is gone after
// the restart and so would a LinkedIn session be. That is the
// `keychain-refused` reason, and the row has no way past it but a Retry.
//
// The result is a marker (`~/.engager/browser-check.json`) naming the build,
// version and digest of the browser it checked: a check that already passed
// for THIS browser is not run again, and a changed browser (a new pin) runs
// it afresh. The marker also records `keychain: "passed"` once the check has
// reached the browser's key in the login keychain: when a "Chromium Safe
// Storage" item already exists and no such record is on file for this build
// and digest, macOS will ask the owner a question the first time the browser
// starts, so the row says so and waits for Continue instead of starting
// (US-OND-08).
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { browserExecutablePath, browserManifestForArch } from "./browserManifest.mjs";
import { atomicWrite } from "./ownedFiles.mjs";
import { chromiumKeychainItemPresent } from "./prereqs.mjs";
import { browserVenvReady, sidecarVenv } from "./sidecarVenv.mjs";

export const BROWSER_CHECK_FILE = "browser-check.json";

/** How long one attempt may take: two starts and two graceful closes, since the
 *  cookie round trip restarts the browser -- 110 s when each is as slow as its
 *  own limit (a 30 s start window, a 25 s shutdown budget). A browser unpacked
 *  a moment ago is scanned by macOS the first time it runs, which is slower
 *  than every later start; this is beyond that total, not equal. */
const CHECK_TIMEOUT_MS = 150_000;

/** How long the first start may take when macOS is going to ask the owner for
 *  their password (US-OND-08): the dialog holds the browser until it is
 *  answered, and nothing on this side can see the dialog. A longer window
 *  stands in for "as long as it is open" -- the owner may be away, or hunting
 *  for the password -- and still ends: a check that nobody answers fails as a
 *  timeout with a Retry rather than hanging the row for good. */
const KEYCHAIN_CHECK_TIMEOUT_MS = 10 * 60_000;

/** The owner-facing words for each reason code, pinned here like the other
 *  rows' (`BROWSER_FAILURE_WORDS`): the window's sentence is built from these,
 *  never from the sidecar's own message, which can carry a path. */
export const BROWSER_CHECK_FAILURE_WORDS = Object.freeze({
  "browser-missing": "Engager's browser is not installed yet",
  "tools-missing": "the browser tools are not installed yet",
  "did-not-start": "the browser did not start",
  timeout: "the browser did not answer in time",
  "keychain-refused": "macOS did not give the browser its key",
  "check-failed": "the check could not finish",
});

export class BrowserCheckError extends Error {
  constructor(reason) {
    super(BROWSER_CHECK_FAILURE_WORDS[reason] ?? reason);
    this.name = "BrowserCheckError";
    this.reason = reason;
    this.words = this.message;
  }
}

/** What identifies "this browser" for the marker: the pinned build, its
 *  version and the digest of the zip it was verified against (an install only
 *  ever lands bytes that matched that digest). */
function identityOf(entry) {
  return { build: entry.build, version: entry.version, sha256: entry.sha256 };
}

function readMarker(homeDir, readFile = (file) => readFileSync(file, "utf8")) {
  try {
    const parsed = JSON.parse(readFile(path.join(homeDir, BROWSER_CHECK_FILE)));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function markerMatches(marker, entry) {
  const identity = identityOf(entry);
  return Boolean(marker) && Object.keys(identity).every((key) => marker[key] === identity[key]);
}

/** Whether the marker records the check reaching this browser's key. Keyed by
 *  the build and the digest alone -- the two things macOS knows an ad-hoc
 *  signed browser by -- so a version string corrected in the manifest does not
 *  ask the owner again. */
function keychainPassed(marker, entry) {
  return Boolean(marker) && marker.build === entry.build && marker.sha256 === entry.sha256 && marker.keychain === "passed";
}

/** Whether the marker is a pass from before the cookie round trip existed: it
 *  names this build and digest and carries no keychain verdict at all. Same
 *  key as `keychainPassed`, for the same reason. */
function legacyPass(marker, entry) {
  return Boolean(marker) && marker.build === entry.build && marker.sha256 === entry.sha256 && marker.keychain === undefined;
}

/**
 * What setup can say about the Browser check row without running anything:
 * done when the pinned browser is installed AND the marker vouches for exactly
 * that browser AND records that it kept a sign-in (`keychain: "passed"`).
 * Pending otherwise -- including a browser that changed since.
 *
 * A marker from before the round trip existed reads pending too, and says so
 * with `legacyPassed`: the browser did start once, the sign-in was never
 * tried. This function cannot see whether the owner's onboarding is finished,
 * so it does not decide whether that earlier pass is enough; the app weighs
 * the flag against the dashboard's `org.setupDone` (`macSetupComplete`).
 *
 * `needsYou` is the one other answer: the check is next (browser and tools in
 * place), no passed keychain record exists for this browser, and the login
 * keychain already holds "Chromium Safe Storage" -- so macOS will ask for the
 * owner's password when the browser first starts, and the window explains it
 * and waits for Continue first (US-OND-08). The probe runs only then, never on
 * a Mac whose browser is not ready to be checked.
 */
export function browserCheckStatus({
  homeDir,
  arch = process.arch,
  fileExists = existsSync,
  readFile,
  manifestEntry,
  keychainItemPresent = chromiumKeychainItemPresent,
} = {}) {
  const entry = manifestEntry ?? browserManifestForArch(arch);
  if (!homeDir || !entry) return { state: "pending", done: false, legacyPassed: false };
  const installed = fileExists(browserExecutablePath(homeDir, entry));
  const marker = installed ? readMarker(homeDir, readFile) : null;
  const done = installed && markerMatches(marker, entry) && keychainPassed(marker, entry);
  if (done) {
    return {
      state: "done",
      done: true,
      legacyPassed: false,
      version: marker.browserVersion ?? entry.version,
      checkedAt: marker.at,
    };
  }
  const needsYou =
    installed && browserVenvReady(homeDir, fileExists) && !keychainPassed(marker, entry) && keychainItemPresent();
  return { state: needsYou ? "needsYou" : "pending", done: false, legacyPassed: legacyPass(marker, entry) };
}

/** The sidecar's own refusal codes, as the reason the window words. */
function reasonForCode(code) {
  if (code === "BROWSER_NOT_INSTALLED") return "browser-missing";
  if (code === "DEPENDENCY_MISSING" || code === "DEPENDENCY_VERSION_MISMATCH") return "tools-missing";
  if (code === "BROWSER_UNAVAILABLE") return "did-not-start";
  if (code === "KEYCHAIN_REFUSED") return "keychain-refused";
  return "check-failed";
}

/** The last JSON object a self-check printed, or null. Stdout of this mode is
 *  one object; anything else on it (a library's stray line) is ignored. */
function parseOutcome(stdout) {
  for (const line of String(stdout).split("\n").reverse()) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && "ok" in parsed) return parsed;
    } catch {
      /* not the answer */
    }
  }
  return null;
}

/** The detached group belongs to this exact spawn. Browser Use's browser
 * inherits it, including when a failed sidecar leaves the browser behind.
 * A profile appearing on another process's command line proves no ownership. */
async function reapCheckGroup(child) {
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 1) return;
  const signal = (name) => {
    try { process.kill(-child.pid, name); } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  signal("SIGTERM");
  await delay(400);
  signal("SIGKILL");
}

/** The signals that end this process while a check is running. */
const ABANDON_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];

/** One start-and-close, on a profile of its own that is gone afterwards. */
async function attemptCheck({ homeDir, pkg, env, executable, spawnImpl, timeoutMs, tmpRoot }) {
  const profile = mkdtempSync(path.join(tmpRoot, "engager-browser-check-"));
  let timedOut = false;
  let child;
  let abandon;
  try {
    const venv = sidecarVenv(homeDir, pkg, env);
    const args = [
      "run",
      "--project",
      venv.project,
      "--locked",
      "python",
      "-u",
      path.join(venv.project, "bridge.py"),
      "--self-check",
      "--profile-dir",
      profile,
      "--browser-executable",
      executable,
    ];
    child = spawnImpl(venv.uv, args, {
      cwd: venv.project,
      env: { ...venv.env, ANONYMIZED_TELEMETRY: "false", PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      // Its own group, so a timeout takes `uv` and the Python under it together.
      detached: true,
    });
    // Cancel, or the window closing, SIGTERMs this process alone. The group is
    // detached, so nothing else would take `uv`, the Python and the browser
    // down with it, or remove the profile they hold.
    abandon = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // ESRCH: the group already left. Anything else must not stop the
        // profile's removal or the exit this handler exists for.
        child.kill("SIGKILL");
      }
      rmSync(profile, { recursive: true, force: true });
      process.exit(1);
    };
    for (const signal of ABANDON_SIGNALS) process.once(signal, abandon);
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    // stderr is drained and dropped: it carries the library's own chatter and
    // paths, and the window's words come from reason codes alone.
    child.stderr.on("data", () => {});
    const exit = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, timeoutMs);
      child.once("error", (error) => {
        clearTimeout(timer);
        resolve({ error });
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ code });
      });
    });
    if (timedOut) return { ok: false, reason: "timeout" };
    if (exit.error) return { ok: false, reason: exit.error.code === "ENOENT" ? "tools-missing" : "check-failed" };
    const outcome = parseOutcome(stdout);
    if (outcome?.ok === true && exit.code === 0) return { ok: true, browserVersion: String(outcome.version ?? "") };
    return { ok: false, reason: outcome ? reasonForCode(outcome.code) : "check-failed" };
  } finally {
    if (abandon) for (const signal of ABANDON_SIGNALS) process.off(signal, abandon);
    await reapCheckGroup(child);
    rmSync(profile, { recursive: true, force: true });
  }
}

/**
 * Run the check, or answer at once when this browser already passed it. Events
 * carry the phase and reason codes only: a progress event when the start
 * begins, then exactly one terminal done or failed. A browser that did not
 * start is tried once more before the row fails -- the first start of a
 * browser unpacked a moment ago is the slow one -- while a browser that is
 * not there, or answers nothing, is not.
 *
 * When the status reads `needsYou` the window has explained the keychain
 * question and the owner pressed Continue, so this is the run that makes
 * macOS ask: the status is read here, before the browser can create the
 * keychain item itself, to give the first start `keychainTimeoutMs` instead
 * of `timeoutMs`.
 */
export async function runBrowserCheck({
  homeDir,
  pkg,
  env = process.env,
  arch = process.arch,
  onEvent = () => {},
  spawnImpl = spawn,
  timeoutMs = CHECK_TIMEOUT_MS,
  keychainTimeoutMs = KEYCHAIN_CHECK_TIMEOUT_MS,
  tmpRoot = os.tmpdir(),
  manifestEntry,
  keychainItemPresent = chromiumKeychainItemPresent,
  now = () => new Date(),
} = {}) {
  const entry = manifestEntry ?? browserManifestForArch(arch);
  const fail = (reason) => {
    onEvent({
      type: "failed",
      phase: "check",
      command: "mac-setup run browser-check",
      reason,
      words: BROWSER_CHECK_FAILURE_WORDS[reason],
    });
    return new BrowserCheckError(reason);
  };
  if (!homeDir || !entry) throw fail("browser-missing");
  const executable = browserExecutablePath(homeDir, entry);
  if (!existsSync(executable)) throw fail("browser-missing");
  if (!browserVenvReady(homeDir)) throw fail("tools-missing");
  const before = browserCheckStatus({ homeDir, manifestEntry: entry, keychainItemPresent });
  if (before.done) {
    onEvent({ type: "done", version: before.version, alreadyChecked: true });
    return { alreadyChecked: true, version: before.version };
  }

  onEvent({ type: "progress", phase: "check" });
  const startTimeoutMs = before.state === "needsYou" ? keychainTimeoutMs : timeoutMs;
  let outcome;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    outcome = await attemptCheck({ homeDir, pkg, env, executable, spawnImpl, timeoutMs: startTimeoutMs, tmpRoot });
    if (outcome.ok || outcome.reason !== "did-not-start") break;
  }
  if (!outcome.ok) throw fail(outcome.reason);

  const version = outcome.browserVersion || entry.version;
  atomicWrite(
    path.join(homeDir, BROWSER_CHECK_FILE),
    JSON.stringify({
      ...identityOf(entry),
      browserVersion: version,
      keychain: "passed",
      at: now().toISOString(),
    }),
  );
  onEvent({ type: "done", version, alreadyChecked: false });
  return { alreadyChecked: false, version };
}
