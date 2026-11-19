// The one frozen statement of Engager's own LinkedIn browser (US-OND-04):
// which Chromium build setup downloads, from where, and how its bytes are
// known good. Downloaded during Mac setup into ~/.engager/browser -- never
// shipped in the app, never the shared Playwright cache, never the owner's
// Chrome. The size the setup window shows is read from here, never typed
// into copy; `browserInstall.mjs` refuses any byte the sha256 here does
// not vouch for, before anything is unpacked.
//
// The pin is Playwright's chromium 1179 build (Chromium 138.0.7204.23,
// `Chromium.app` layout) -- the build the sidecar's browser-use already
// runs -- fetched from Playwright's own download mirror. Size and sha256
// were measured by downloading and hashing both zips when this pin was
// frozen, the `scripts/bundle/manifest.ts` discipline: this file carries
// only the result, never a placeholder. `browserManifest.test.ts` fails
// if any field is empty.
import path from "node:path";

export const BROWSER_BUILD = "1179";
export const BROWSER_VERSION = "138.0.7204.23";

/** One entry per Mac architecture, frozen the way the bundle manifest
 *  freezes its pins: nothing that imports this can mutate a pin in place. */
export const BROWSER_MANIFEST = Object.freeze([
  Object.freeze({
    arch: "arm64",
    build: BROWSER_BUILD,
    version: BROWSER_VERSION,
    url: "https://playwright-verizon.azureedge.net/builds/chromium/1179/chromium-mac-arm64.zip",
    sizeBytes: 133115207,
    sha256: "59c04f48759b0b7b3cfc15f8bfedd7ddf530e5da7a92da43e3bf37c8daad5c57",
  }),
  Object.freeze({
    arch: "x64",
    build: BROWSER_BUILD,
    version: BROWSER_VERSION,
    url: "https://playwright-verizon.azureedge.net/builds/chromium/1179/chromium-mac.zip",
    sizeBytes: 139968372,
    sha256: "e5142c0f4eda3211adb31667a08eb84e3f199a70ecd9a5597ff4fd2f2d69a6fd",
  }),
]);

/** The entry for a Node `process.arch` value, or null off the two Mac
 *  architectures setup serves. */
export function browserManifestForArch(arch = process.arch) {
  return BROWSER_MANIFEST.find((entry) => entry.arch === arch) ?? null;
}

/** Whole megabytes, the unit every owner-facing number uses. */
export function megabytes(bytes) {
  return Math.round(bytes / 1_000_000);
}

/** `~/.engager/browser/chromium-<build>` -- the install's own browser home.
 *  No segment may contain the text "chrome" (any case): browser-use copies
 *  a profile whose path looks like Chrome's into a temp directory
 *  (profile.py), which would silently move the owner's LinkedIn login;
 *  the neutral name is what keeps `~/.engager/browser-profile` in place. */
export function browserInstallDir(homeDir, entry) {
  return path.join(homeDir, "browser", `chromium-${entry.build}`);
}

/** The executable the sidecar is started with, inside the unpacked app. */
export function browserExecutablePath(homeDir, entry) {
  return path.join(browserInstallDir(homeDir, entry), "Chromium.app", "Contents", "MacOS", "Chromium");
}

/** True when some path segment contains "chrome" (any case) -- the shape
 *  browser-use treats as a real Chrome profile and copies away. */
export function hasChromeSegment(value) {
  return String(value)
    .split(/[\\/]/)
    .some((segment) => segment.toLowerCase().includes("chrome"));
}
