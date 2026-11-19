// What on this Mac can break setup before it installs anything (US-OND-03):
// an old install's data in the way, a Postgres data directory of another
// major, and another program holding the database port. The CLI classifies
// (INV-20) and the window renders one screen with one action for each; none
// of it reads LinkedIn, an account or a card.
//
// Only the Mac app's own install has these questions -- a bundled cluster
// (`ENGAGER_PGDATA` and `ENGAGER_PG_PORT`, which the CLI defaults inside the
// .app). A checkout or an owner-run Postgres is the owner's to manage, and
// a port that Postgres of theirs holds is the expected state there.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync } from "node:fs";
import path from "node:path";
import { atomicWrite } from "./ownedFiles.mjs";
import { parsePgCtlMajor, pgCtlStopArgs, pgDataVerdict, resolveBin } from "./prereqs.mjs";

/** The install's own record that setup has accounted for what is in this
 *  directory: written when this setup's Database row finishes and when the
 *  owner chooses "Keep my data". Without it an org that exists but was
 *  never signed in is data from somewhere else -- and with it, the owner's
 *  own half-finished setup (an org, no account yet) is never mistaken for
 *  an old install when they quit and reopen. */
export const SETUP_MARKER_FILE = "mac-setup.json";

/** Sign-in artifacts (the licence cache, the device key): an install that
 *  has any of them is a signed-in owner updating the app, who is never asked. */
const SIGNED_IN_FILES = ["license.json", "entitlement.json", "device-key"];

export function writeSetupMarker(homeDir, via, now = () => new Date()) {
  atomicWrite(path.join(homeDir, SETUP_MARKER_FILE), JSON.stringify({ via, at: now().toISOString() }));
}

/** Q-D2: `~/.engager` holds an organization, and neither a licence cache
 *  nor a device key, nor this setup's own marker, says it is the owner's. */
export function oldInstallFound({ homeDir, orgConfigured, fileExists = existsSync }) {
  if (!homeDir || !orgConfigured) return false;
  return [...SIGNED_IN_FILES, SETUP_MARKER_FILE].every((name) => !fileExists(path.join(homeDir, name)));
}

/** The major of the cluster in `ENGAGER_PGDATA` against the bundled server's,
 *  when they differ (`pgDataVerdict`'s `older` and `newer`: starting either is
 *  the corruption the prerequisite check refuses). */
export function pgdataMismatch({ env = process.env, readPgVersion, binaryMajor } = {}) {
  const dataDir = env.ENGAGER_PGDATA;
  if (!dataDir) return { mismatch: false };
  const read =
    readPgVersion ??
    ((file) => {
      try {
        return readFileSync(file, "utf8").trim();
      } catch {
        return null;
      }
    });
  const pgVersion = read(path.join(dataDir, "PG_VERSION"));
  const major =
    binaryMajor === undefined
      ? parsePgCtlMajor(spawnSync(resolveBin("pg_ctl", env), ["--version"], { encoding: "utf8" }).stdout)
      : binaryMajor;
  const verdict = pgDataVerdict({ exists: pgVersion !== null || existsSync(dataDir), pgVersion, binaryMajor: major });
  if (verdict !== "older" && verdict !== "newer") return { mismatch: false };
  return { mismatch: true, clusterMajor: Number(pgVersion), binaryMajor: major };
}

/** The data directory a postmaster's command line names (`postgres -D <dir>`),
 *  allowing a directory with a space in it. `null` when it names none. */
function dataDirOf(command) {
  const match = /\s-D\s+(.+?)(?=\s+-[A-Za-z-]|\s*$)/.exec(command);
  return match ? match[1].replace(/^"(.*)"$/, "$1") : null;
}

/**
 * Who answers on the database port, from the listener's own command line.
 * `ours` is this install's warm cluster (reused on purpose -- the launch
 * never kills a postmaster); `engager` is another Engager's database, the
 * one holder setup may offer to stop; anything else is `foreign`, which
 * setup names and never touches. Pure over what `ps` printed.
 */
export function classifyPostgresHolder({ command, ownPgdata, realpath = realpathSync }) {
  const text = String(command ?? "").trim();
  const isPostgres = /(?:^|\/)postgres(?=\s|$)/.test(text);
  if (!isPostgres) return { kind: "foreign", command: text };
  const dataDir = dataDirOf(text);
  const same = (a, b) => {
    try {
      return realpath(a) === realpath(b);
    } catch {
      return path.resolve(a) === path.resolve(b);
    }
  };
  if (dataDir && ownPgdata && same(dataDir, ownPgdata)) return { kind: "ours", command: text, dataDir };
  const binary = text.split(/\s-/)[0];
  const engagers = binary.includes("runtime-resources/postgresql") || (dataDir ?? "").includes(".engager");
  return { kind: engagers ? "engager" : "foreign", command: text, dataDir };
}

/** The listener on `port`, one `lsof` and one `ps`. A machine with no
 *  `lsof` (or one that cannot answer) reports no holder rather than a guess. */
export function readPortHolder({ port, ownPgdata, run = spawnSync, realpath }) {
  const listing = run("/usr/sbin/lsof", ["-nP", `-tiTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  const pid = Number.parseInt(String(listing.stdout ?? "").split("\n").find((line) => /^\d+$/.test(line.trim())) ?? "", 10);
  if (!Number.isInteger(pid)) return { kind: "none", port };
  const ps = run("/bin/ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  return { port, pid, ...classifyPostgresHolder({ command: ps.stdout, ownPgdata, realpath }) };
}

/** The actual data directory's postmaster, independent of its port. A stale
 *  pid is harmless only when the process is gone; unreadable state or failed
 *  process inspection cannot establish that the directory is safe to move. */
export function readPostmaster({ ownPgdata, run = spawnSync, read = readFileSync, signal = process.kill, realpath }) {
  let pid;
  try {
    pid = Number(read(path.join(ownPgdata, "postmaster.pid"), "utf8").split("\n")[0]);
  } catch (error) {
    return { kind: error.code === "ENOENT" ? "none" : "unknown" };
  }
  if (!Number.isInteger(pid) || pid <= 0) return { kind: "unknown" };
  try {
    signal(pid, 0);
  } catch (error) {
    return { kind: error.code === "ESRCH" ? "none" : "unknown" };
  }
  const ps = run("/bin/ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  if (ps.error || ps.status !== 0) return { kind: "unknown" };
  return { pid, ...classifyPostgresHolder({ command: ps.stdout, ownPgdata, realpath }) };
}

/**
 * The whole `environment` object of `mac-setup status`, and the one
 * `blocking` verdict the window acts on. A cluster of another major comes
 * first (nothing can open it), then a port holder (a foreign program, then
 * another Engager's database), then an old install's data -- so the owner
 * answers one question at a time, and "Start fresh" on the first of them
 * settles the rest.
 */
export function environmentStatus({
  homeDir,
  env = process.env,
  orgConfigured,
  fileExists = existsSync,
  probes = {},
} = {}) {
  const bundled = Boolean(env.ENGAGER_PGDATA && env.ENGAGER_PG_PORT);
  if (!bundled) {
    return {
      applicable: false,
      oldInstall: { found: false },
      pgdata: { mismatch: false },
      portHolder: { kind: "none" },
      blocking: null,
    };
  }
  const oldInstall = { found: oldInstallFound({ homeDir, orgConfigured, fileExists }) };
  const pgdata = pgdataMismatch({ env, ...probes.pgdata });
  const portHolder = (probes.readPortHolder ?? readPortHolder)({ port: env.ENGAGER_PG_PORT, ownPgdata: env.ENGAGER_PGDATA });
  const blocking = pgdata.mismatch
    ? "pgdata"
    : portHolder.kind === "foreign"
      ? "portForeign"
      : portHolder.kind === "engager"
        ? "portEngager"
        : oldInstall.found
          ? "oldInstall"
          : null;
  return { applicable: true, oldInstall, pgdata, portHolder, blocking };
}

/** "Keep my data": the owner's say-so that what is here is theirs. Writes
 *  only the marker -- nothing in the directory is touched. */
export function keepData({ homeDir }) {
  writeSetupMarker(homeDir, "keep");
  return { kept: true };
}

/** `~/.engager.bak-20261022-143005`, the local time to the second, with a
 *  counter if that name is somehow taken: never a name that overwrites. */
export function backupName(homeDir, now = new Date(), fileExists = existsSync) {
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const base = `${homeDir}.bak-${stamp}`;
  let candidate = base;
  for (let n = 2; fileExists(candidate); n += 1) candidate = `${base}-${n}`;
  return candidate;
}

/**
 * "Start fresh": this install's own bundled cluster, if it is running, is
 * stopped first (a data directory moved under a running postmaster is how
 * a database dies), then the whole directory is MOVED to
 * `<home>.bak-<date>-<time>` -- never deleted -- and an empty one takes its
 * place. The move is one rename on one volume, so it either happened or it
 * did not. The data directory's postmaster is checked even when an older
 * install started it on another port. An uncertain inspection never
 * permits the move.
 */
export function startFresh({
  homeDir,
  env = process.env,
  run = spawnSync,
  readHolder = readPostmaster,
  now = new Date(),
  rename = renameSync,
  makeDir = mkdirSync,
  fileExists = existsSync,
} = {}) {
  const stopArgs = pgCtlStopArgs(env);
  if (stopArgs) {
    const inspect = () => readHolder({ ownPgdata: env.ENGAGER_PGDATA, run });
    try {
      const before = inspect();
      if (before.kind !== "none" && before.kind !== "ours") return { moved: false, reason: "database-running" };
      if (before.kind === "ours") {
        const stopped = run(resolveBin("pg_ctl", env), [...stopArgs.slice(0, -1), "-w", "stop"], { encoding: "utf8", timeout: 60_000 });
        if (stopped.error || stopped.status !== 0) return { moved: false, reason: "database-running" };
        if (inspect().kind !== "none") return { moved: false, reason: "database-running" };
      }
    } catch {
      return { moved: false, reason: "database-running" };
    }
  }
  const backup = backupName(homeDir, now, fileExists);
  try {
    rename(homeDir, backup);
    makeDir(homeDir, { recursive: true, mode: 0o700 });
  } catch {
    return { moved: false, reason: "move-failed" };
  }
  return { moved: true, backup };
}

/**
 * "Stop it": a graceful stop of another Engager's database, and nothing
 * else. The holder is read afresh here, never taken from the window, and a
 * holder that is not a Postgres of Engager's -- or names no data directory
 * -- is refused: this verb never signals a process it cannot prove is one.
 */
export function stopPortHolder({ env = process.env, run = spawnSync, readHolder = readPortHolder } = {}) {
  const holder = readHolder({ port: env.ENGAGER_PG_PORT, ownPgdata: env.ENGAGER_PGDATA });
  if (holder.kind === "none") return { stopped: true, alreadyFree: true };
  if (holder.kind !== "engager" || !holder.dataDir) return { stopped: false, reason: "not-stoppable", kind: holder.kind };
  const stopped = run(resolveBin("pg_ctl", env), ["-D", holder.dataDir, "-m", "fast", "-w", "stop"], {
    encoding: "utf8",
    timeout: 60_000,
  });
  return stopped.status === 0 ? { stopped: true } : { stopped: false, reason: "stop-failed" };
}
