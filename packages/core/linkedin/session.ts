import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config";

/**
 * The sidecar's dedicated Chrome profile directory. Same normalization the
 * python side applies (bridge.py expanduser), so a tilde-shaped
 * ENGAGER_BROWSER_PROFILE_DIR resolves to what is actually on disk.
 */
export function browserProfileDir(): string {
  const raw =
    config.browserUse.profileDir()?.trim() ||
    path.join(os.homedir(), ".engager", "browser-profile");
  const expanded = raw.startsWith("~")
    ? path.join(os.homedir(), raw.slice(1))
    : raw;
  return path.resolve(expanded);
}

/**
 * Whether a browser session was ever OPENED for this channel — one fact, and
 * `linkedInConnectionState` is what composes it with the rest.
 *
 * A local session lives in the sidecar's own Chrome profile: the owner signs
 * in themselves and nothing is stored in the database. A stored profile means
 * "a session exists", not "it is live" — liveness needs a probe
 * (get_channel {probe:true}, Channels → Test connection). It is
 * never evidence that an account is CONFIGURED either: Chromium creates the
 * directory the moment it launches, which is how a fresh install once showed
 * "LinkedIn ✓" against a probe that returned login_required.
 *
 * "Does anything reach this account" is still the resolver's question —
 * `not_connected` — and not this one's.
 */
export function linkedInSessionStored(): boolean {
  return existsSync(browserProfileDir());
}
