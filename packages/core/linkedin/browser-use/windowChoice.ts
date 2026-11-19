import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../../config";
import type { WindowPlace } from "../driver";
import { browserProfileDir } from "../session";
import type { BrowserBridgeFile } from "./bridgeFile";
import { BrowserUseClient } from "./client";
import {
  BrowserWindowSchema,
  WindowPlaceSchema,
  type BrowserUseSuccessResponseFor,
  type BrowserWindow,
} from "./protocol";
import { discoverBridge, HttpBrowserUseTransport } from "./remoteTransport";

/**
 * THE OWNER'S CHOICE OF WINDOW for Engager's browser, and what hiding it came
 * to — two small files beside the browser profile, like the journal, each with
 * one writer.
 *
 * The choice is the dashboard's to write and every launch's to read
 * (`window.py` `read_choice`), so a restart and the nightly recycle keep it
 * without a word passing between them. The state is the browser holder's to
 * write after every hide, and the pages' to read: an owner whose window sits on
 * their screen against their choice is told which permission the hide is
 * missing, instead of being left with a window nothing explains.
 *
 * A file rather than a row, because the choice is about THIS MAC: a hosted
 * tenant's browser has no window, and an organization row would carry one
 * machine's answer to every machine. The names are spelled again in
 * `window.py`, and the suite pins the two copies equal.
 */
export const WINDOW_CHOICE_FILE = "browser-window.json";
export const WINDOW_STATE_FILE = "browser-window-state.json";

export { BrowserWindowSchema, WindowPlaceSchema, type BrowserWindow };

export type WindowVisibility =
  BrowserUseSuccessResponseFor<"set_window_visibility">["result"];

function beside(profileDir: string, name: string): string {
  return join(dirname(profileDir), name);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The window the owner chose, or what a launch does without a choice: the
 * sidecar's own default, hidden unless `ENGAGER_BROWSER_HIDDEN` says false — the
 * same fallback `_hidden_by_choice` takes, so the page never shows one answer
 * while the browser acts on another.
 */
export function readWindowChoice(
  profileDir: string = browserProfileDir(),
): BrowserWindow {
  const saved = readJson(beside(profileDir, WINDOW_CHOICE_FILE));
  const choice = BrowserWindowSchema.safeParse(
    saved !== null && typeof saved === "object" ? (saved as { window?: unknown }).window : undefined,
  );
  if (choice.success) return choice.data;
  return config.browserUse.hidden() === "false" ? "shown" : "hidden";
}

/** Saved whole, never half: a launch reading mid-write sees the old choice or
 *  the new one, and an unreadable file is a default rather than a guess. */
export function writeWindowChoice(
  window: BrowserWindow,
  profileDir: string = browserProfileDir(),
): void {
  const path = beside(profileDir, WINDOW_CHOICE_FILE);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ window })}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/**
 * Whether the window is on the owner's screen against their choice NOW: they
 * chose Hidden, and the holder's last hide found no mechanism that worked.
 *
 * Read against the running holder, never alone. A state the holder recorded
 * before this one started describes a browser that is gone, and with no holder
 * at all there is no window to have failed to hide.
 */
export function browserHideFailed(
  bridge: BrowserBridgeFile | null,
  profileDir: string = browserProfileDir(),
): boolean {
  if (!bridge || readWindowChoice(profileDir) !== "hidden") return false;
  const state = readJson(beside(profileDir, WINDOW_STATE_FILE));
  if (state === null || typeof state !== "object") return false;
  const { hideFailed, at } = state as { hideFailed?: unknown; at?: unknown };
  return hideFailed === true && typeof at === "number" && at >= bridge.startedAt;
}

/**
 * The window op, sent to the standing holder over its loopback bridge; null when
 * no holder is reachable, which is no browser to change — the next launch reads
 * the saved choice. It queues behind whatever the holder is doing, a write
 * included, so it can never land inside one. A
 * reveal may say where the window goes (`place`).
 */
export async function applyWindowVisibility(
  params: { window: BrowserWindow } | { reveal: true; place?: WindowPlace },
  fetchImpl: typeof fetch = fetch,
): Promise<WindowVisibility | null> {
  const endpoint = await discoverBridge(fetchImpl);
  if (!endpoint) return null;
  const client = new BrowserUseClient({
    transport: new HttpBrowserUseTransport(endpoint),
  });
  return client.request("set_window_visibility", params);
}

/** The old browser's close (up to 25 s) and the new one's start (its debugger
 *  gets 30 s) are both in one restart; the client's usual minute is less. */
const RESTART_TIMEOUT_MS = 120_000;

/**
 * The sign-in step's Try again, sent to the standing holder: Engager's browser
 * closes, a leftover one holding the profile with it, and starts again on the
 * same profile, its window up in `place`. Nothing is navigated, and the
 * profile is the one in use, so the owner's sign-in comes through.
 *
 * Null when no holder is reachable: there is no browser to restart, and the
 * look that follows starts one of its own. Queued like every other op, so a
 * write is never cut in two by it.
 */
export async function restartBrowser(
  place?: WindowPlace,
  fetchImpl: typeof fetch = fetch,
): Promise<WindowVisibility | null> {
  const endpoint = await discoverBridge(fetchImpl);
  if (!endpoint) return null;
  const client = new BrowserUseClient({
    transport: new HttpBrowserUseTransport(endpoint),
  });
  return client.request("restart_browser", place ? { place } : {}, { timeoutMs: RESTART_TIMEOUT_MS });
}

/**
 * Disconnect's first half, sent to the standing holder: Engager's browser
 * closes and stays closed until an operation next needs one. The profile is
 * about to be archived, and a browser left running on a folder renamed from
 * under it keeps no sign-in: the next account's lived in its memory alone and
 * was gone at the next restart (2026-11-19).
 *
 * False when no holder is reachable, so there was none of its to close.
 */
export async function closeBrowser(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const endpoint = await discoverBridge(fetchImpl);
  if (!endpoint) return false;
  const client = new BrowserUseClient({
    transport: new HttpBrowserUseTransport(endpoint),
  });
  await client.request("close_browser", {}, { timeoutMs: RESTART_TIMEOUT_MS });
  return true;
}
