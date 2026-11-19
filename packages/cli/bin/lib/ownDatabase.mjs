import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { atomicWrite, readJson, noSymlinks } from "./ownedFiles.mjs";
import { installState } from "./installState.mjs";
import { processIdentity } from "./coreLifecycle.mjs";
import { ensureBundledPostgresRunning, resolveBin } from "./prereqs.mjs";
import { withPathLock } from "./pathLock.mjs";

/**
 * THIS INSTALLATION'S OWN CLUSTER — the one implementation, shared by the free
 * CLI's lifecycle verbs and by the interactive server that brings the store up
 * when an owner's agent connects (TIER-25). It lives here rather than inside
 * the installer because the second caller is core-side TypeScript, and two
 * spellings of "is this our cluster, and is it accepting" is exactly the drift
 * `prereqs.mjs` already refuses to allow for the start itself.
 *
 * Ownership is proved twice over, because a port is a shared resource: the
 * marker must name THIS installation and port, and a server already answering
 * must report our own data directory. A foreign server on our port is
 * `database_port_conflict` rather than a database we silently adopt.
 */
export function ensureOwnDatabase(root, env, initialize, deps) {
  const pgdata = path.join(root, "pgdata"); noSymlinks(pgdata);
  const marker = path.join(root, "database-owner.json");
  const owner = readJson(marker, null);
  const state = installState(root);
  if (!state) throw new Error("install_required");
  if (owner && (owner.installationId !== state.id || owner.port !== Number(env.ENGAGER_PG_PORT))) throw new Error("database_ownership_mismatch");
  if (!owner && existsSync(pgdata)) throw new Error("database_ownership_unknown");
  // `-d postgres`: without a database name `pg_isready` sends the OS username,
  // and the server answers every probe by logging `FATAL: database "<user>"
  // does not exist`. The readiness answer was always right; `postgres.log` was
  // filling with a failure the probe had invented, every thirty seconds.
  const ready = spawnSync(resolveBin("pg_isready", env), ["-h", "127.0.0.1", "-p", env.ENGAGER_PG_PORT, "-d", "postgres"], { encoding: "utf8", timeout: 3000 });
  if (ready.status === 0) {
    // Personal output settings must not change this exact ownership proof.
    const result = spawnSync(resolveBin("psql", env), ["-X", "-h", "127.0.0.1", "-p", env.ENGAGER_PG_PORT, "-d", "postgres", "-Atc", "show data_directory"], { env, encoding: "utf8", timeout: 3000 });
    if (!owner || result.status !== 0 || path.resolve(result.stdout.trim()) !== pgdata) throw new Error("database_port_conflict");
    return;
  }
  if (!owner && !initialize) throw new Error("database_setup_required");
  if (!owner) atomicWrite(marker, JSON.stringify({ installationId: state.id, port: Number(env.ENGAGER_PG_PORT), dataDirectory: pgdata }));
  if (!ensureBundledPostgresRunning(env, deps, { initdb: initialize })) throw new Error("database_start_failed");
}

/**
 * The deps that keep a bundled cluster's bring-up off the terminal — `init`'s
 * call, where the owner's first command must end with a receipt rather than
 * pages of `initdb` chatter with a receipt buried under it.
 *
 * `initdb`'s output is appended to the install's `postgres.log`, beside the
 * server log `pg_ctl -l` already writes there, so nothing is lost; capturing
 * it also makes `ensureBundledPostgresRunning`'s failure path work, since the
 * `initialised.stderr` it reads was always null under inherited stdio.
 *
 * `pg_ctl start` is `ignore` and can never be piped: a daemonized postmaster
 * that inherits the parent's pipe never lets go of it (DOCTRINE, 2026-08-22).
 * Refusals still reach `log`, which defaults to stderr for the same reason the
 * chatter left stdout — that channel carries the JSON receipt.
 */
export function quietDatabaseDeps(env, log = (line) => console.error(line)) {
  const target = env.ENGAGER_PG_LOG;
  return {
    spawn: (command, args, options) => {
      const name = path.basename(command);
      const daemon = name === "pg_ctl" && args.includes("start");
      const result = spawnSync(command, args, { ...options, stdio: daemon ? "ignore" : ["ignore", "pipe", "pipe"], encoding: "utf8" });
      const captured = name === "initdb" ? `${result.stdout ?? ""}${result.stderr ?? ""}` : "";
      // A log this install cannot write is never what fails an installation;
      // the cluster is the thing being created here, not the record of it.
      if (target && captured) try { noSymlinks(target); appendFileSync(target, `--- initdb ${new Date().toISOString()} ---\n${captured}`, { mode: 0o600 }); } catch { /* unwritable log */ }
      return result;
    },
    readFile: readFileSync,
    exists: existsSync,
    log,
  };
}

export function stopOwnDatabase(root, env) {
  const marker = readJson(path.join(root, "database-owner.json"), null);
  if (!marker) return;
  if (marker.installationId !== installState(root)?.id) throw new Error("database_ownership_mismatch");
  const data = path.join(root, "pgdata"), pidFile = path.join(data, "postmaster.pid");
  noSymlinks(pidFile);
  if (!existsSync(pidFile)) return;
  const lines = readFileSync(pidFile, "utf8").split("\n");
  const identity = processIdentity(Number(lines[0]));
  if (!identity || !identity.command.includes(data) || path.resolve(lines[1] ?? "") !== data) throw new Error("database_stop_ownership_unresolved");
  const result = spawnSync(resolveBin("pg_ctl", env), ["-D", data, "-m", "fast", "-w", "stop"], { env, encoding: "utf8", timeout: 15000 });
  if (result.status !== 0 || existsSync(pidFile)) throw new Error("database_stop_failed");
}

/**
 * The interactive server's bring-up: what `engager up` used to do for an owner
 * who now never types it.
 *
 * Three things differ from the lifecycle verbs' call, and each is the reason
 * this wrapper exists rather than a second call site.
 *
 * It NEVER initialises. Creating a cluster stays with `engager init`, which
 * holds the lifecycle lock and has the owner's consent; two interactive
 * clients racing `initdb` on one directory is the failure `prereqs.mjs`
 * already refuses, and an MCP host may start several of us at once.
 *
 * It says nothing on stdout. A stdio server's stdout is the JSON-RPC channel,
 * so both the progress line and `pg_ctl`'s inherited output would corrupt the
 * protocol stream. Logs go to the caller's channel and the child's go nowhere.
 *
 * It REFUSES SOFTLY. A cluster we cannot start is an unavailable dependency,
 * not a failed installation: the caller still binds its transport, so Skills
 * discovery and file retrieval keep answering and the owner hears the reason
 * by name instead of watching every tool fail at once.
 */
export async function ensureInteractiveDatabase(
  env = process.env,
  log = (line) => console.error(line),
) {
  const root = env.ENGAGER_HOME;
  // No bundled cluster in this environment: a checkout or a hosted tenant
  // reaches its database by URL and there is nothing here to bring up.
  if (!root || !env.ENGAGER_PGDATA) return { state: "not_bundled" };
  // The same deps `init` uses, for one of the same reasons and one of its own:
  // a stdio server's stdout is the protocol itself, so neither the progress
  // nor the child's output may reach it. Its `initdb` arm stays dead here —
  // this call never initialises.
  const quiet = quietDatabaseDeps(env, log);
  try {
    return await withPathLock(
      path.join(root, "database-start"),
      async () => {
        ensureOwnDatabase(root, env, false, quiet);
        return { state: "ready" };
      },
      { busyMessage: "database_start_busy", timeoutMs: 40_000 },
    );
  } catch (error) {
    const code = error instanceof Error ? error.message : "database_unavailable";
    log(`[mcp] local store unavailable: ${code}`);
    return { state: "unavailable", code };
  }
}
