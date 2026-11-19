// The Space row of Mac setup (US-OND-02): does this Mac have room for what
// setup is about to install, and what of Engager's own can be cleared when
// it does not. It runs before anything downloads -- a full disk crashed the
// database halfway through an install once -- and it decides here, not in
// Swift (INV-20): the window renders the figures this prints.
//
// "Clear caches" removes only what Engager can prove is its own and no
// longer needed, enumerated from three roots by name: the preserved prior
// app copies (`mac-prior/`) other than the one the update ticket names,
// superseded Engager-installed browser builds (`browser/chromium-*`), and
// Engager's own tool caches (`cache/`). Nothing else in ~/.engager is ever
// a candidate -- never `pgdata`, `brain`, `browser-profile`, the licence,
// the device key or a snapshot -- because nothing else is enumerated.
import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, rmSync, statfsSync } from "node:fs";
import path from "node:path";
import { BROWSER_BUILD } from "./browserManifest.mjs";
import { macUpdateTicket } from "./macMaintenance.mjs";

/** Free bytes setup needs on the volume that holds ~/.engager (Q-D4): the
 *  browser tools (4 MB), the unpacked Chromium (292 MB), the download
 *  beside it and a first database come to about 0.7 GB on the owner's Mac,
 *  so this is a margin over the measurement, not the measurement. The one
 *  place the figure lives -- no GB number sits in Swift or in the page. */
export const SETUP_MIN_FREE_BYTES = 2_000_000_000;

/** The required bytes, with a test-only override. `ENGAGER_SETUP_MIN_FREE_BYTES`
 *  lets a harness or a live check raise the bar above the real free space to
 *  see the low-space screen; no release build documents it to owners. */
export function setupMinFreeBytes(env = process.env) {
  const override = Number(env.ENGAGER_SETUP_MIN_FREE_BYTES);
  return Number.isFinite(override) && override > 0 ? Math.floor(override) : SETUP_MIN_FREE_BYTES;
}

/** Free bytes on the volume holding `dir`, read from its nearest existing
 *  ancestor (a first run has no ~/.engager yet). `null` when nothing answers. */
export function freeBytesAt(dir, statfs = statfsSync) {
  let at = dir;
  for (;;) {
    try {
      const stats = statfs(at);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch {
      const parent = path.dirname(at);
      if (parent === at) return null;
      at = parent;
    }
  }
}

/** Decimal gigabytes to one decimal -- the unit macOS's own Storage pane
 *  uses, and the unit every owner-facing number here shares. */
export function gigabytes(bytes) {
  return Math.round(bytes / 1e8) / 10;
}

/** Rounded UP, so "free up at least [Z GB]" never undershoots the need. */
function gigabytesUp(bytes) {
  return Math.ceil(bytes / 1e8) / 10;
}

/**
 * The Space row's evidence. `blocks` is the decision the window acts on:
 * low space stops setup only while there is still something to install --
 * a finished setup on a nearly full disk has nothing left that needs room.
 * A statfs that cannot answer is not a full disk (the rule browserInstall
 * already follows): the write that actually fails is the real test.
 */
export function spaceStatus({ homeDir, env = process.env, statfs = statfsSync, setupDone = false } = {}) {
  const required = setupMinFreeBytes(env);
  const free = homeDir ? freeBytesAt(homeDir, statfs) : null;
  const enough = free === null || free >= required;
  return {
    state: enough ? "done" : "failed",
    enough,
    blocks: !enough && !setupDone,
    freeBytes: free ?? 0,
    requiredBytes: required,
    freeGB: gigabytes(free ?? 0),
    requiredGB: gigabytes(required),
    shortfallGB: enough ? 0 : gigabytesUp(required - free),
  };
}

function directoryEntries(root) {
  try {
    // lstat, so a root that is itself a link to somewhere else is not one
    // of Engager's directories to empty.
    if (!lstatSync(root).isDirectory()) return [];
    return readdirSync(root).map((name) => path.join(root, name));
  } catch (error) {
    // A missing root is empty; an unreadable root is unknown. Reporting both
    // as [] would let a failed cleanup hide its Retry with a false zero.
    if (error?.code === "ENOENT") return [];
    throw new Error("cache_inventory_unreadable");
  }
}

/**
 * Everything "Clear caches" may remove, as absolute paths -- recomputed on
 * every call and never taken from a caller, so what is measured and what is
 * removed are the same enumeration. A ticket that cannot be read proves
 * nothing about which prior copy an update needs, so the prior copies are
 * all kept in that case.
 */
export function clearableEntries({ homeDir, readTicket = macUpdateTicket } = {}) {
  if (!homeDir) return [];
  const entries = [];
  let ticket;
  try {
    ticket = readTicket(homeDir);
  } catch {
    ticket = undefined;
  }
  if (ticket !== undefined) {
    // `mac-prior/<ms>/Engager.app` is what the ticket names: its directory
    // is the one preserved copy a rollback may still need.
    const kept = ticket?.prior ? path.dirname(ticket.prior) : null;
    for (const entry of directoryEntries(path.join(homeDir, "mac-prior"))) {
      if (kept === null || path.resolve(entry) !== path.resolve(kept)) entries.push(entry);
    }
  }
  for (const entry of directoryEntries(path.join(homeDir, "browser"))) {
    // Superseded builds only: the pinned build, the resumable partial
    // (`.download`) and anything not named like a build stay.
    const name = path.basename(entry);
    if (/^chromium-\d+$/.test(name) && name !== `chromium-${BROWSER_BUILD}`) entries.push(entry);
  }
  entries.push(...directoryEntries(path.join(homeDir, "cache")));
  return entries;
}

/** Bytes on disk under each entry, from one `du` over all of them: a walk
 *  of 56 preserved app copies is minutes in Node and seconds in du. A du
 *  that cannot run measures nothing rather than guessing. */
function defaultMeasure(entries) {
  if (entries.length === 0) return 0;
  const measured = spawnSync("du", ["-sk", ...entries], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (measured.error || measured.status !== 0) throw new Error("cache_measurement_unavailable");
  const lines = (measured.stdout ?? "").split("\n").filter(Boolean);
  if (lines.length !== entries.length) throw new Error("cache_measurement_unavailable");
  let kilobytes = 0;
  for (const line of lines) {
    const size = Number(line.split("\t")[0]);
    if (!Number.isFinite(size) || size < 0) throw new Error("cache_measurement_unavailable");
    kilobytes += size;
  }
  return kilobytes * 1024;
}

/** The measured size of exactly the set `clearCaches` would remove. */
export function measureClearable({ homeDir, readTicket, measure = defaultMeasure } = {}) {
  const entries = clearableEntries({ homeDir, readTicket });
  const bytes = measure(entries);
  if (!Number.isFinite(bytes) || bytes < 0) throw new Error("cache_measurement_unavailable");
  return { count: entries.length, bytes, gb: gigabytes(bytes) };
}

/**
 * Remove the clearable set. Each entry is removed as a path, never followed:
 * `rmSync` unlinks a symlink rather than emptying its destination, and the set is
 * enumerated afresh here. Returns the figures the next status read will show
 * -- the free space is read again from the disk, not computed from the
 * measurement, because "about [N GB]" is what the owner was promised.
 */
export function clearCaches({ homeDir, env = process.env, statfs = statfsSync, readTicket, remove = rmSync } = {}) {
  const before = freeBytesAt(homeDir, statfs);
  const entries = clearableEntries({ homeDir, readTicket });
  let removed = 0;
  for (const entry of entries) {
    try {
      remove(entry, { recursive: true, force: true });
      removed += 1;
    } catch {
      // One entry that refuses to go leaves the rest of the set removed.
    }
  }
  const after = freeBytesAt(homeDir, statfs);
  return {
    removed,
    freedBytes: before !== null && after !== null ? Math.max(0, after - before) : 0,
    space: spaceStatus({ homeDir, env, statfs }),
  };
}
