// Mac first-run setup status: what the "Set up Engager" window derives its
// step from (US-OND-01). The step before an organization exists can never
// come from the organizations.onboarding_step column -- there is no row yet
// -- so this reads evidence on disk instead: the generated env file (an org
// id is written only after createdb, the migration and the org bootstrap
// all succeeded) and the install's own sign-in artifacts. Swift decodes
// this and decides nothing from the filesystem itself (INV-20).
//
// The LinkedIn browser row runs here too (US-OND-04 + US-OND-07): phase
// one builds the browser tools -- the sidecar's Python environment, synced
// from the lockfile into ~/.engager/venv -- and only then does the pinned
// Chromium download run, in the same row and the same event stream. The
// tools phase has no byte count to show (uv reports none), so its progress
// event is indeterminate; the Chromium phase keeps its real counts. The
// Mac `init` is unchanged: this row is where the tools get built, so the
// first LinkedIn connection never stalls on the two-minute sync.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { browserCheckStatus } from "./browserCheck.mjs";
import { browserStatus, installBrowser } from "./browserInstall.mjs";
import { megabytes } from "./browserManifest.mjs";
import { readEnvFile } from "./localEnv.mjs";
import { environmentStatus } from "./macEnvironment.mjs";
import { spaceStatus } from "./macSpace.mjs";
import { BROWSER_TOOLS_MEASURED_BYTES, browserVenvMarker, browserVenvReady, browserVenvState, sidecarVenv } from "./sidecarVenv.mjs";

/** The sign-in artifacts whose presence proves this Mac signed in once:
 *  the licence cache the device flow writes (`licenseLogin.mjs` owns
 *  `license.json`/`entitlement.json`) and the device key
 *  (`entitlementClient.ts`'s `deviceKeyPath()`). Names only -- the Account
 *  door that consumes this needs the fact, never the contents. */
const EVER_SIGNED_IN_FILES = ["license.json", "entitlement.json", "device-key"];

/**
 * The whole status the first-run window renders its This Mac rows from.
 * `database.done` is deliberately strict: the env file exists AND carries
 * a DATABASE_URL AND the ENGAGER_ORG_ID `init` writes last. An env file
 * without the org id is a half-finished run -- `init` is safe to run again
 * over it, and the row reports pending rather than done, so nothing that
 * finished is restarted and nothing unfinished is claimed.
 */
export function macSetupStatus({
  homeDir,
  envFile,
  fileExists = existsSync,
  envMap,
  arch = process.arch,
  env = process.env,
  statfs,
  environmentProbes,
  keychainItemPresent,
} = {}) {
  const values = envMap ?? readEnvFile(envFile);
  const envFilePresent = envFile ? fileExists(envFile) : values.size > 0;
  const orgConfigured = Boolean(values.get("ENGAGER_ORG_ID"));
  const databaseUrl = Boolean(values.get("DATABASE_URL"));
  const pgdata = values.get("ENGAGER_PGDATA") ?? (homeDir ? path.join(homeDir, "pgdata") : null);
  const pgdataInitialized = pgdata ? fileExists(path.join(pgdata, "PG_VERSION")) : false;
  const databaseDone = envFilePresent && orgConfigured && databaseUrl;
  const everSignedIn = homeDir
    ? EVER_SIGNED_IN_FILES.some((name) => fileExists(path.join(homeDir, name)))
    : false;
  const database = {
    state: databaseDone ? "done" : "pending",
    done: databaseDone,
    envFile: envFilePresent,
    orgConfigured,
    databaseUrl,
    pgdataInitialized,
  };
  // The LinkedIn browser row (US-OND-04 + US-OND-07): done only when BOTH
  // halves are in place -- the browser tools (the sidecar venv setup now
  // builds here) and the pinned executable under ~/.engager/browser. A
  // kept Chromium partial still reports its real byte count, so a reopened
  // window resumes the row where the download stopped. `totalMB` stays the
  // Chromium download's size (the progress bar's denominator); `setupMB`
  // is that plus the measured tools size -- the "about [X MB]" the row's
  // description shows, read from the manifest and the measurement, never
  // typed into copy.
  const chromium = browserStatus({ homeDir, arch, fileExists });
  const toolsReady = homeDir ? browserVenvReady(homeDir, fileExists) : false;
  const toolsMB = megabytes(BROWSER_TOOLS_MEASURED_BYTES);
  const browserDone = chromium.done && toolsReady;
  const browser = {
    ...chromium,
    state: browserDone ? "done" : chromium.state === "partial" ? "partial" : "pending",
    done: browserDone,
    toolsReady,
    toolsMB,
    setupMB: chromium.totalBytes > 0 ? chromium.totalMB + toolsMB : 0,
  };
  // The Browser check row (US-OND-05): the pinned browser started once and
  // closed, vouched for by a marker naming exactly that browser. Its third
  // state, `needsYou` (US-OND-08), is the CLI saying macOS is about to ask
  // the owner a question the window must explain first; the window decides
  // nothing about it, it renders this and sends Continue. `legacyPassed`
  // rides along untouched: it is a pass from before the sign-in round trip,
  // which the CLI cannot weigh -- it never sees the owner's onboarding.
  const browserCheck = browserCheckStatus({ homeDir, arch, fileExists, keychainItemPresent });
  const complete = databaseDone && browser.done && browserCheck.done;
  // The Space row (US-OND-02) reads the disk, not the install: it is
  // evidence about this moment, so it never counts toward `complete` and
  // only blocks while something is still to install.
  const space = spaceStatus({ homeDir, env, statfs, setupDone: complete });
  // What on this Mac can break setup before it installs anything
  // (US-OND-03): the CLI classifies, the window renders one screen each.
  const environment = environmentStatus({
    homeDir,
    env,
    orgConfigured,
    fileExists,
    probes: environmentProbes,
  });
  return {
    complete,
    space,
    environment,
    database,
    browser,
    browserCheck,
    account: { everSignedIn },
    thisMac: {
      complete,
      rows: [
        { id: "space", title: "Space", state: space.state },
        { id: "database", title: "Database", state: database.state },
        { id: "browser", title: "LinkedIn browser", state: browser.state },
        { id: "browserCheck", title: "Browser check", state: browserCheck.state },
      ],
    },
  };
}

/** One human line per fact, for `engager mac-setup status` without --json. */
export function macSetupStatusLines(status) {
  return [
    ...(status.environment?.blocking ? [`✗ Setup is waiting on this Mac (${status.environment.blocking})`] : []),
    status.space.enough
      ? `✓ ${status.space.freeGB} GB free`
      : `✗ Not enough space: ${status.space.freeGB} GB free, setup needs ${status.space.requiredGB} GB`,
    status.database.done ? "✓ Database ready" : "· Database not set up yet",
    status.browser?.done
      ? "✓ LinkedIn browser ready"
      : status.browser?.state === "partial"
        ? `· LinkedIn browser download stopped at ${status.browser.downloadedMB} of ${status.browser.totalMB} MB`
        : status.browser?.toolsReady === false
          ? "· LinkedIn browser tools not installed yet"
          : "· LinkedIn browser not downloaded yet",
    status.browserCheck?.done
      ? "✓ Browser check passed"
      : status.browserCheck?.state === "needsYou"
        ? "· Browser check waits for you: macOS asks about Engager's browser"
        : "· Browser check not run yet",
    status.account.everSignedIn ? "✓ Signed in on this Mac before" : "· Never signed in on this Mac",
    status.complete ? "✓ This Mac is set up" : "· Set up Engager is not finished on this Mac",
  ];
}

/** The owner-facing words for each tools-phase reason code -- the same
 *  discipline as `BROWSER_FAILURE_WORDS`: the window's sentence is built
 *  from these, never from a raw uv line. */
export const BROWSER_TOOLS_FAILURE_WORDS = Object.freeze({
  offline: "you are offline",
  "pypi-refused": "the package server refused the download",
  "disk-full": "there is not enough space",
  "installer-missing": "the browser-tools installer was not found",
  "sync-failed": "the install could not finish",
});

export class BrowserToolsError extends Error {
  constructor(reason) {
    super(BROWSER_TOOLS_FAILURE_WORDS[reason] ?? reason);
    this.name = "BrowserToolsError";
    this.reason = reason;
    this.words = this.message;
  }
}

/** Why a `uv sync` stopped, as a reason code. Only the shapes setup can
 *  act on get their own words; everything else is the honest generic.
 *  uv's stderr is matched, never repeated. */
function browserToolsFailureReason({ error, stderr }) {
  if (error?.code === "ENOENT") return "installer-missing";
  if (error?.code === "ENOSPC" || /no space left on device/i.test(stderr ?? "")) return "disk-full";
  if (error?.code === "ETIMEDOUT") return "offline";
  const text = stderr ?? "";
  if (/\b(401|403|404)\b|forbidden|unauthorized/i.test(text)) return "pypi-refused";
  if (/dns|name resolution|failed to lookup|network is unreachable|connection (refused|reset|closed)|timed out|timeout|offline/i.test(text)) {
    return "offline";
  }
  return "sync-failed";
}

/**
 * Phase one of the LinkedIn browser row: build the sidecar's Python
 * environment from the lockfile only (`uv sync --locked`, the one
 * spelling in `sidecarVenv.mjs`), into ~/.engager/venv with uv's cache
 * and managed Python in Engager's own folders. Idempotent -- an
 * environment that already answers ready spawns nothing, and a Retry
 * after a stop re-runs the sync over uv's cache, so finished wheels are
 * not fetched twice. Nothing here needs `uvx`, opens a page, or makes a
 * model call; `spawnImpl` is injectable only so tests record a fake
 * uv's argv instead of reaching PyPI.
 */
export function installBrowserTools({ homeDir, pkg, env = process.env, onEvent = () => {}, spawnImpl = spawnSync } = {}) {
  if (browserVenvReady(homeDir)) return { alreadyReady: true };
  onEvent({ type: "progress", phase: "tools", indeterminate: true });
  const fail = (reason) => {
    onEvent({
      type: "failed",
      phase: "tools",
      command: "mac-setup run browser",
      reason,
      words: BROWSER_TOOLS_FAILURE_WORDS[reason],
    });
    return new BrowserToolsError(reason);
  };
  const venv = sidecarVenv(homeDir, pkg, env);
  mkdirSync(homeDir, { recursive: true });
  rmSync(browserVenvMarker(homeDir), { force: true });
  const synced = spawnImpl(venv.uv, venv.args, { cwd: homeDir, env: venv.env, encoding: "utf8", timeout: 600000 });
  // A non-zero exit is not-ready whatever is on disk -- uv writes the
  // interpreter first, so the marker alone cannot tell a finished sync
  // from an interrupted one (the free CLI's warm states the same rule).
  if (synced.error || synced.status !== 0) {
    throw fail(browserToolsFailureReason({ error: synced.error, stderr: synced.stderr }));
  }
  writeFileSync(browserVenvMarker(homeDir), "");
  if (browserVenvState(homeDir, pkg, env).venv !== "ready") throw fail("sync-failed");
  return { alreadyReady: false };
}

/**
 * The whole LinkedIn browser row, both phases in one event stream: the
 * tools phase's single indeterminate progress event (and, on a stop, its
 * failed event with no byte count), then US-OND-04's determinate
 * Chromium events untouched. Throws `BrowserToolsError` or
 * `BrowserInstallError`, each after emitting its terminal failed event.
 */
export async function runMacBrowserSetup({
  homeDir,
  pkg,
  env = process.env,
  arch = process.arch,
  onEvent = () => {},
  spawnImpl = spawnSync,
  installBrowserImpl = installBrowser,
  fetchImpl,
  unpackImpl,
  manifestEntry,
} = {}) {
  installBrowserTools({ homeDir, pkg, env, onEvent, spawnImpl });
  return installBrowserImpl({ homeDir, arch, onEvent, fetchImpl, unpackImpl, manifestEntry });
}
