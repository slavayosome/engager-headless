import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  BROWSER_USE_PROTOCOL_VERSION,
} from "./protocol";

/**
 * The browser bridge's discovery file — how every other process finds the one
 * standing browser holder.
 *
 * There was no port, socket, or lockfile that identified a browser OWNER
 * before this: the profile was discovered by path and mutual exclusion was the
 * python journal's flock, which is a refusal, not an address. The agent writes
 * this file when its bridge comes up; clients read it, require the profile to
 * be THEIR profile, probe `/health`, and fall back to spawning their own
 * sidecar when any of that fails. A stale file (the agent crashed) fails the
 * health probe and falls through — the flock still guards the profile on
 * every fallback path.
 *
 * 0600 like the license cache: the token in it authorizes browser operations.
 */
export type BrowserBridgeFile = {
  protocolVersion: number;
  port: number;
  token: string;
  pid: number;
  profileDir: string;
  startedAt: number;
};

export function bridgeFilePath(): string {
  const override = process.env.ENGAGER_BROWSER_BRIDGE_FILE;
  if (override && override.trim() !== "") return override;
  return join(homedir(), ".engager", "browser-bridge.json");
}

export function writeBridgeFile(entry: BrowserBridgeFile, path = bridgeFilePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
}

export function removeBridgeFile(path = bridgeFilePath()): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone — removal promises absence, not a deletion event.
  }
}

/** The file's content when it exists and is shaped like a bridge entry for
 *  THIS protocol version; null for absence, damage, or a version this build
 *  does not speak. */
export function readBridgeFile(path = bridgeFilePath()): BrowserBridgeFile | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(raw) as Partial<BrowserBridgeFile>;
    if (
      value.protocolVersion !== BROWSER_USE_PROTOCOL_VERSION ||
      typeof value.port !== "number" ||
      !Number.isInteger(value.port) ||
      value.port <= 0 ||
      typeof value.token !== "string" ||
      value.token.length === 0 ||
      typeof value.pid !== "number" ||
      typeof value.profileDir !== "string" ||
      value.profileDir.length === 0 ||
      typeof value.startedAt !== "number"
    ) {
      return null;
    }
    return value as BrowserBridgeFile;
  } catch {
    return null;
  }
}
