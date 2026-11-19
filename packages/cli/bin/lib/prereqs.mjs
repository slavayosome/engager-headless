// Prerequisite detection + consented auto-install for `engager init/setup/doctor`.
// Policy: NOTHING is installed without an explicit yes (or --yes). On macOS we
// offer Homebrew installs; on Linux we print the commands and stop. The agent
// CLI is REQUIRED: it is the product's inference backend, not just the chat.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os, { userInfo } from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { DEFAULT_POSTGRES, postgresConnection } from "./localEnv.mjs";

const MIN_NODE_MAJOR = 22;

/**
 * The oldest server the schema can be created on, restating
 * `MINIMUM_POSTGRES_VERSION_NUM` in `packages/database/migrate.ts` — migration
 * 0122 declares `UNIQUE ... NULLS NOT DISTINCT`, which is PG 15 syntax. The
 * migration owns the authoritative refusal; this copy exists so init can pick
 * the RIGHT server before it creates a database on the wrong one, and so the
 * owner reads the version verdict in the prerequisite list rather than out of
 * a stack trace.
 */
const MIN_POSTGRES_VERSION_NUM = 150_000;

/** Ports searched for a usable server when nothing is configured yet: the
 *  default, then where a second Homebrew cluster (a `postgresql@17` beside an
 *  older `postgresql@14`) lands. */
const CANDIDATE_PORTS = [5432, 5433, 5434];

/** The pg client tools a bundled runtime ships alongside its own server. */
const PG_CLIENT_TOOLS = new Set(["psql", "pg_isready", "createdb", "pg_ctl", "initdb"]);

/**
 * Where to find one external binary — the seam that lets a bundled runtime
 * point the Postgres client tools, `node`, and `uv` at itself instead of
 * trusting PATH. `ENGAGER_PG_BIN_DIR` resolves the five pg tools;
 * `ENGAGER_NODE_BIN` resolves `"node"`; `ENGAGER_UV_BIN` resolves `"uv"` — the
 * same key the browser-use client reads, deliberately, so doctor probes the
 * binary that will actually be spawned. Everything else, and any of these
 * with its key unset, resolves to the bare name unchanged, which is what
 * every call site already did. `"node"` has no probe routed through it
 * today — the CLI re-spawns itself with `process.execPath` — so the mapping
 * is claimed here and pinned by a test; Phase 22 is its consumer.
 */
export function resolveBin(name, env = process.env) {
  if (PG_CLIENT_TOOLS.has(name) && env.ENGAGER_PG_BIN_DIR) {
    return path.join(env.ENGAGER_PG_BIN_DIR, name);
  }
  if (name === "node" && env.ENGAGER_NODE_BIN) return env.ENGAGER_NODE_BIN;
  if (name === "uv" && env.ENGAGER_UV_BIN) return env.ENGAGER_UV_BIN;
  return name;
}

function has(command, args = ["--version"]) {
  return spawnSync(command, args, { encoding: "utf8" }).status === 0;
}

/** `{ versionNum, version }` of the server at one address, or null when
 *  nothing answers there. */
function probePostgres({ host, port, user }) {
  const result = spawnSync(
    resolveBin("psql"),
    [
      // Startup files can override -tA and print text before the version.
      "-X",
      ...(host ? ["-h", host] : []),
      ...(port ? ["-p", String(port)] : []),
      ...(user ? ["-U", user] : []),
      "-d",
      "postgres",
      "-tAc",
      "select current_setting('server_version_num'), version()",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return null;
  const [versionNum, version] = (result.stdout ?? "").trim().split("|");
  return { versionNum: Number(versionNum ?? 0), version: version ?? "" };
}

/**
 * Addresses to probe, in the precedence `detectPostgres` follows — one
 * address per level, never a mix. Exported pure so the precedence is
 * testable without spawning `psql`.
 *
 * A configured `ENGAGER_MIGRATE_DATABASE_URL`/`DATABASE_URL` wins outright.
 * Below that pin, `ENGAGER_PG_PORT` collapses the scan to that single seam
 * port; below THAT, `PGPORT` does likewise — deliberate, because today
 * `PGPORT` rewrites all three scan entries to the same address and probes it
 * three times for one answer. With neither set, the full `CANDIDATE_PORTS`
 * scan runs. `PGHOST || DEFAULT_POSTGRES.host` is the host throughout.
 */
export function postgresCandidates(envMap = new Map(), env = process.env) {
  const configured = postgresConnection(
    envMap.get("ENGAGER_MIGRATE_DATABASE_URL") || envMap.get("DATABASE_URL"),
  );
  if (configured) {
    return [{ host: configured.host, port: configured.port, user: configured.user }];
  }
  const host = env.PGHOST || DEFAULT_POSTGRES.host;
  if (env.ENGAGER_PG_PORT) return [{ host, port: Number(env.ENGAGER_PG_PORT) }];
  if (env.PGPORT) return [{ host, port: Number(env.PGPORT) }];
  return CANDIDATE_PORTS.map((port) => ({ host, port }));
}

/**
 * WHICH server this install talks to, and whether it is new enough.
 *
 * An env file that already names one settles it — that pin is the owner's, and
 * a search that silently preferred a different cluster would move their data.
 * Below that pin, `postgresCandidates` also honors `ENGAGER_PG_PORT` (and
 * beneath it `PGPORT`) as a single seam address before falling back to the
 * candidate-port scan. With nothing configured at all, the candidate ports
 * are searched in order and the first server meeting the version floor wins,
 * so a machine running 17 beside an older default cluster is provisioned
 * against 17 instead of failing mid-migration. Returns the address plus
 * `{ ok, versionNum, version }`; `reachable: false` means nothing answered
 * anywhere searched.
 */
export function detectPostgres(envMap = new Map()) {
  const configured = postgresConnection(
    envMap.get("ENGAGER_MIGRATE_DATABASE_URL") || envMap.get("DATABASE_URL"),
  );
  const candidates = postgresCandidates(envMap);

  let best = null;
  for (const candidate of candidates) {
    const probe = probePostgres(candidate);
    if (!probe) continue;
    const found = { ...candidate, ...probe, reachable: true, pinned: Boolean(configured) };
    if (probe.versionNum >= MIN_POSTGRES_VERSION_NUM) return { ...found, ok: true };
    // Keep the first server that answered at all: it is what the owner is told
    // about when nothing on this machine is new enough.
    best ??= { ...found, ok: false };
  }
  return best ?? { ...(candidates[0] ?? DEFAULT_POSTGRES), reachable: false, ok: false, pinned: Boolean(configured) };
}

/** One line naming the server and the verdict — shared by init and doctor so
 *  both name the address, never just "reachable". `version()` answers a banner
 *  with the build platform and compiler in it; only the release belongs here. */
function postgresLine(postgres) {
  const at = `${postgres.host ?? DEFAULT_POSTGRES.host}:${postgres.port ?? DEFAULT_POSTGRES.port}`;
  const release = (postgres.version ?? "").split(" on ")[0];
  if (!postgres.reachable) return `✗ no Postgres server answering on ${at}`;
  if (!postgres.ok) {
    return (
      `✗ Postgres on ${at} is ${release || "too old"} — Engager needs 15 or newer\n` +
      `  The schema uses UNIQUE ... NULLS NOT DISTINCT (PG 15+). Start a 15+ server, or point\n` +
      `  DATABASE_URL and ENGAGER_MIGRATE_DATABASE_URL at one you already run.`
    );
  }
  return `✓ Postgres server reachable on ${at} (${release})`;
}

/**
 * Which agent CLI this install runs model calls through, and the binary to
 * probe for it.
 *
 * DELIBERATE, RECORDED DUPLICATION of the selection in
 * `packages/core/ai/agentCli`. This file is dependency-free plain JS that
 * cannot import TS core, and `engager init` needs the answer before any of
 * that is loadable. Exactly three narrow facts are copied: `ENGAGER_AGENT_CLI`
 * names the agent (empty or "auto" means the auto default, Claude);
 * `ENGAGER_AGENT_CLI_BIN` overrides the binary, which otherwise IS the agent
 * id — both shipped adapters spawn their own; and `ENGAGER_CODEX_BIN`
 * overrides Codex's binary ahead of `ENGAGER_AGENT_CLI_BIN`, so a Codex pin
 * reads its own key first and falls back to the shared one, matching
 * `codexAdapter.bin()`.
 *
 * What is NOT copied is whether the resolved agent can actually SERVE
 * background inference. That is a capability with one authority, and
 * `engager doctor` reads it off the get_status round-trip below rather
 * than restating it here. So this row answers one question only — is the
 * binary this install would spawn on PATH — and says nothing more.
 */
export function agentCliPrereq(envMap = new Map(), { present = has } = {}) {
  const configured = (envMap.get("ENGAGER_AGENT_CLI") ?? "").trim().toLowerCase();
  const pinned = configured !== "" && configured !== "auto";
  const agent = pinned ? configured : "claude";
  const bin =
    (agent === "codex" && envMap.get("ENGAGER_CODEX_BIN")) ||
    envMap.get("ENGAGER_AGENT_CLI_BIN") ||
    agent;
  // Named by its binary whenever that is not the auto default, so a pinned
  // install is never told a binary it does not use is missing — nor told
  // nothing is wrong when the one it does use is absent.
  const label = bin === "claude" ? "Claude Code CLI" : `agent CLI \`${bin}\``;
  return { agent, bin, pinned, label, present: present(bin) };
}

/**
 * Whether Claude has ever been signed in on this machine — the second
 * question `agentCliPrereq` deliberately does not answer. `has(bin)` (its
 * `--version` probe) reads the same "installed" for a signed-in and a
 * never-signed-in `claude`; a fresh install passes it and then fails every
 * model call the product makes.
 *
 * DELIBERATE, RECORDED DUPLICATION, beside the note on `agentCliPrereq`
 * above: this file restates narrow facts about the agent CLI on purpose
 * because it is dependency-free plain JS and cannot import TS core. The fact
 * restated here is WHERE the `claude` CLI keeps its credential — on macOS,
 * the `Claude Code-credentials` item in the login keychain (read via
 * `security find-generic-password`, presence only, never the secret); on
 * every platform including a macOS install that keeps the file instead, the
 * `~/.claude/.credentials.json` file.
 *
 * The honest residual: this is a heuristic about where a credential lives,
 * not a token validator, and must not grow into one. An expired, revoked, or
 * rate-limited token still reads "ready" here, and a future release that
 * moves the storage location reads "signed-out" on a perfectly working
 * install. The first real inference call is the authority, and
 * `packages/core/ai/agentCli` owns that. Doctor's job is the machine that has
 * NEVER signed in — the state a first run actually meets and the one no
 * error message explains well.
 *
 * Never throws — a doctor that crashes on a corrupt credentials file is worse
 * than one that says signed-out, the same rule `licenseStatusLine`'s doc
 * comment states for a corrupt license file. Every dependency is injected so
 * the test drives all three verdicts without touching the real keychain, the
 * real home directory, or a real binary.
 */
export function claudeAuthStatus({
  bin = "claude",
  platform = process.platform,
  spawn = spawnSync,
  readFile = (file) => readFileSync(file, "utf8"),
  homeDir = os.homedir(),
} = {}) {
  if (spawn(bin, ["--version"], { encoding: "utf8" }).status !== 0) return "absent";
  if (platform === "darwin" && process.env.ENGAGER_DEV_APP !== "1") {
    const keychain = spawn(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials"],
      { encoding: "utf8" },
    );
    if (keychain.status === 0) return "ready";
  }
  // The fallback runs on darwin too, deliberately: a machine that keeps the
  // file rather than the keychain item must not be reported signed-out.
  try {
    const parsed = JSON.parse(readFile(path.join(homeDir, ".claude", ".credentials.json")));
    return parsed && typeof parsed === "object" ? "ready" : "signed-out";
  } catch {
    return "signed-out";
  }
}

/**
 * Whether the login keychain already holds the item every Chromium-branded
 * build keeps its cookie key in -- the one question setup's Browser check
 * needs answered BEFORE it opens Engager's browser (US-OND-08). If the item
 * is there and this browser did not make it, macOS asks the owner for a
 * password the first time the browser reaches it; if it is not there,
 * Chromium creates it without a dialog.
 *
 * Presence only, in the shape of `claudeAuthStatus`'s read above: no `-w`, no
 * `-g`, stdio ignored, so the secret is never requested and nothing the tool
 * prints is even captured. Engager never writes or deletes this item either
 * (`keychainBoundary.test.ts` greps the shipped sources for that); the
 * browser is the only thing that touches it.
 *
 * The Dev artifact runs its browser on a mock keychain in a private HOME
 * (backend.py's `_isolated_development_browser`), so for it there is no
 * dialog to announce and the answer is always no. Off macOS there is no keychain.
 * Never throws: a probe that cannot run reads as "no item", the screen that
 * skips straight to the check.
 */
export function chromiumKeychainItemPresent({
  platform = process.platform,
  env = process.env,
  spawn = spawnSync,
} = {}) {
  if (platform !== "darwin" || env.ENGAGER_DEV_APP === "1") return false;
  try {
    // Bounded: this runs inside `mac-setup status` at launch, and a keychain
    // that never answers must read as no item (a timeout leaves status null).
    return (
      spawn("security", ["find-generic-password", "-s", "Chromium Safe Storage"], { stdio: "ignore", timeout: 5_000 })
        .status === 0
    );
  } catch {
    return false;
  }
}

/**
 * `assumeYes` wins over `nonInteractive` deliberately: the supervisor drives
 * `init --yes --non-interactive`, and a `--non-interactive` that declined
 * first would refuse the Homebrew installs a first run needs. `assumeYes` is
 * consent; `nonInteractive` is the guarantee that nothing ever asks — not a
 * second way to say no to what `--yes` already answered.
 */
export async function confirm(question, { assumeYes, nonInteractive } = {}) {
  if (assumeYes) {
    console.log(`${question} — yes (--yes)`);
    return true;
  }
  if (nonInteractive) {
    console.log(`${question} — no (--non-interactive; re-run with --yes to consent)`);
    return false;
  }
  // No terminal to ask on (piped stdin, CI, `| sh`): awaiting rl.question here
  // never settles and node exits 13 with NOTHING printed. Decline out loud
  // instead, and name the flag that skips the question entirely.
  if (!process.stdin.isTTY) {
    console.log(`${question} — no (stdin is not a terminal; re-run with --yes to consent)`);
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [Y/n] `)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

function brewInstall(pkg) {
  const args = ["install", pkg];
  console.log(`→ brew ${args.join(" ")}`);
  return spawnSync("brew", args, { stdio: "inherit" }).status === 0;
}

/**
 * Homebrew's versioned Postgres formulae are KEG-ONLY: `brew install
 * postgresql@17` succeeds and still leaves `createdb`/`pg_isready` off PATH.
 * Without this, init "installed" Postgres, skipped its own server check
 * (which needs pg_isready to run at all), and then died on `createdb` with an
 * empty error message. Put the keg's bin on PATH for the rest of this run and
 * hand the user the one line that makes it permanent.
 */
function linkKegOnlyBin(formula) {
  const prefix = spawnSync("brew", ["--prefix", formula], { encoding: "utf8" });
  const binDir = prefix.status === 0 ? `${prefix.stdout.trim()}/bin` : "";
  if (!binDir || !existsSync(binDir)) return false;
  if (!(process.env.PATH ?? "").split(":").includes(binDir)) {
    process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
  }
  console.log(`  ${formula} is keg-only — using ${binDir} for this run.`);
  console.log(`  Make it permanent:  echo 'export PATH="${binDir}:$PATH"' >> ~/.zshrc`);
  return true;
}

/**
 * `-d postgres` on every readiness PROBE (never on a `--version` presence
 * check). Without a database name `pg_isready` sends the OS username, and the
 * server answers by logging `FATAL: database "<user>" does not exist` — a
 * failure the probe invented, in the log an owner opens when something is
 * genuinely wrong. Phase 35-C gave the flag to the two probes `ownDatabase.mjs`
 * spawns; these are the ones a bundled cluster's own bring-up spawns, and they
 * are why a fresh `init` still left exactly one of those FATALs behind.
 */
const READINESS_DB = ["-d", "postgres"];

/** Start whichever postgresql formula brew has (postgresql@17/@16/…).
 *  `quiet` keeps brew's own output off stdout -- `preflight --json` must
 *  print one object and nothing else. `spawn` is the seam
 *  `ensureBundledPostgresRunning` already takes, so the argv this path probes
 *  with is pinned by a test on a machine that has no brew. */
function startBrewPostgres({ quiet = false, spawn = spawnSync } = {}) {
  const list = spawn("brew", ["services", "list"], { encoding: "utf8" });
  const formula =
    list.stdout
      ?.split("\n")
      .map((line) => line.split(/\s+/)[0])
      .find((name) => name?.startsWith("postgresql")) ?? "postgresql@17";
  if (!quiet) console.log(`→ brew services start ${formula}`);
  spawn("brew", ["services", "start", formula], { stdio: quiet ? "ignore" : "inherit" });
  const accepting = () =>
    spawn(resolveBin("pg_isready"), ["-q", ...READINESS_DB], { encoding: "utf8" })
      .status === 0;
  // The server takes a moment to accept connections after service start.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (accepting()) return true;
    spawn("sleep", ["1"]);
  }
  return accepting();
}

/**
 * argv for `pg_ctl start` against a bundled cluster — pure so the exact
 * command is pinned without spawning a database. `null` when
 * `ENGAGER_PGDATA` is unset (the default, brew-managed path); the caller
 * falls back to `startBrewPostgres` in that case, since a bundled cluster is
 * not brew's and `brew services start` would start the wrong server or none.
 */
export function pgCtlStartArgs(env = process.env) {
  if (!env.ENGAGER_PGDATA) return null;
  const port = env.ENGAGER_PG_PORT;
  // This private cluster is reached over localhost TCP. Distribution builds
  // otherwise try a system-owned socket directory an ordinary user cannot use.
  const options = `${port ? `-p ${port} ` : ""}-c unix_socket_directories=`;
  return ["-D", env.ENGAGER_PGDATA, "-w", ...(env.ENGAGER_PG_LOG ? ["-l", env.ENGAGER_PG_LOG] : []), "-o", options, "start"];
}

/**
 * argv for `pg_ctl stop` against the same bundled cluster, the same `null`
 * contract as `pgCtlStartArgs`. `-m fast` rather than the default smart:
 * `engager uninstall --purge` is about to delete the data directory, and a
 * stop that waits on an open dashboard connection is a stop that never
 * finishes.
 */
export function pgCtlStopArgs(env = process.env) {
  if (!env.ENGAGER_PGDATA) return null;
  return ["-D", env.ENGAGER_PGDATA, "-m", "fast", "stop"];
}

/** The major version integer out of a `pg_ctl --version` banner
 *  (`pg_ctl (PostgreSQL) 14.18 (Homebrew)` → `14`), or `null` for anything
 *  unrecognised — a future banner rewording must not be misread as a
 *  version. */
export function parsePgCtlMajor(text) {
  const match = /\(PostgreSQL\)\s+(\d+)/.exec(text ?? "");
  return match ? Number(match[1]) : null;
}

/**
 * Whether a persistent `ENGAGER_PGDATA` may be opened by these binaries, and
 * how — the destructive decision INV-20 puts here instead of on the
 * supervisor side. `exists`/`pgVersion`/`binaryMajor` arrive already read, so
 * every branch is drivable without touching a filesystem or a database.
 *
 * `binaryMajor === null` reads `current`, deliberately: an unparseable
 * `pg_ctl --version` must not brick a working install. `current` is
 * byte-for-byte today's behaviour — start it and let the postmaster speak
 * for itself — where a refusal would be this function inventing a new
 * failure. This is a cheap guard against a KNOWN corruption (an older major
 * cluster left by a previous app version), not a version authority.
 *
 * `PG_VERSION` holds the bare major on PG 10+ and a `9.6`-shaped string
 * before it; `Number("9.6")` compares older than every modern major, so no
 * special case is needed for the pre-10 spelling.
 *
 * `empty` means "exists and holds no `PG_VERSION`", not "holds nothing". A
 * directory that is neither a cluster nor initdb-able is caught by
 * `initdb`'s own refusal to write into a non-empty directory, which prints a
 * readable error — that case does not need a sixth verdict here.
 */
export function pgDataVerdict({ exists, pgVersion, binaryMajor }) {
  if (!exists) return "absent";
  if (pgVersion === null) return "empty";
  if (binaryMajor === null) return "current";
  const clusterMajor = Number(pgVersion);
  if (clusterMajor === binaryMajor) return "current";
  if (clusterMajor < binaryMajor) return "older";
  return "newer";
}

/**
 * argv for `initdb` against a bundled cluster — the same spelling
 * `scripts/bundle/smoke.ts` already uses (`OWNER = userInfo().username`),
 * restated rather than improved on: `ensureLocalEnv` writes
 * `ENGAGER_MIGRATE_DATABASE_URL` as `postgresql://<osUser>@…`, and a cluster
 * whose superuser is spelled differently fails at migration instead of here.
 * `null` when `ENGAGER_PGDATA` is unset — the same brew-path contract
 * `pgCtlStartArgs` carries.
 */
export function initdbArgs(env = process.env, osUser = userInfo().username) {
  if (!env.ENGAGER_PGDATA) return null;
  return ["-D", env.ENGAGER_PGDATA, "-U", osUser];
}

/**
 * What to do with a bundled `ENGAGER_PGDATA`, as one decision: `initdb` and
 * `start` come back together precisely so the two cannot be decided in two
 * places and disagree — never start what was refused, never initdb over a
 * cluster.
 *
 * `absent`/`empty` → initialise then start. `current` → start only. `older`
 * and `newer` both refuse — starting is the corruption this exists to
 * prevent — and the refusal names the data directory and both majors, with
 * what to do about it: for `older` the bundled server is newer than the
 * cluster and the fix is `pg_upgrade` or a fresh `ENGAGER_PGDATA`; for
 * `newer` these binaries are older than the cluster and this build must not
 * open it.
 */
export function bundledClusterPlan({ verdict, dataDir, clusterMajor, binaryMajor }) {
  if (verdict === "absent" || verdict === "empty") {
    return { initdb: true, start: true, refusal: null };
  }
  if (verdict === "current") {
    return { initdb: false, start: true, refusal: null };
  }
  const refusal =
    verdict === "older"
      ? `✗ ${dataDir} holds a PostgreSQL ${clusterMajor} cluster, but the bundled server is ${binaryMajor} — refusing to start a newer major against an older cluster. Run pg_upgrade, or point ENGAGER_PGDATA at a fresh directory.`
      : `✗ ${dataDir} holds a PostgreSQL ${clusterMajor} cluster, but the bundled server is only ${binaryMajor} — these binaries are older than the cluster and must not open it. Use a newer bundle, or point ENGAGER_PGDATA at a fresh directory.`;
  return { initdb: false, start: false, refusal };
}

/**
 * Check everything the local stack needs; on macOS offer to install what's
 * missing (per-item consent). Returns { ok, warnings, postgres } — ok=false
 * means a hard prerequisite is still missing after the user's choices, and
 * `postgres` is the server the env file should be written against.
 */
export async function ensurePrerequisites({ assumeYes = false, envMap, nonInteractive = false } = {}) {
  const warnings = [];
  let ok = true;

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const nodeOk = nodeMajor >= MIN_NODE_MAJOR;
  console.log(`${nodeOk ? "✓" : "✗"} Node ${process.versions.node} (need >= ${MIN_NODE_MAJOR})`);
  if (!nodeOk) ok = false;

  const darwin = process.platform === "darwin";
  const brewAvailable = darwin && has("brew");
  const aptCommands = [];

  // [label, present(), brew formula, {kegOnly}] — `present` is a FUNCTION so the
  // same check re-runs after an install and proves it actually landed on PATH.
  const items = [
    ["prereq:uv", "uv (python sidecar runner)", () => has(resolveBin("uv")), "uv", {}],
    [
      "prereq:pg-client",
      // psql among them: it is how the version floor below is read off the
      // server, and it ships in the same package as the other two.
      "Postgres client tools (pg_isready, createdb, psql)",
      () =>
        has(resolveBin("pg_isready")) && has(resolveBin("createdb")) && has(resolveBin("psql")),
      "postgresql@17",
      { kegOnly: true },
    ],
  ];

  for (const [name, label, present, formula, opts] of items) {
    const installed = present();
    console.log(`${installed ? "✓" : "✗"} ${label}`);
    if (installed) continue;
    if (brewAvailable) {
      if (await confirm(`  Install ${formula} via Homebrew?`, { assumeYes, nonInteractive })) {
        if (!brewInstall(formula)) {
          console.log(`✗ brew install ${formula} failed — install it yourself and re-run.`);
          ok = false;
        } else {
          if (opts.kegOnly) linkKegOnlyBin(formula);
          // Never take `brew install` exit 0 as proof: a keg-only formula
          // installs fine while leaving the command unreachable.
          if (present()) {
            console.log(`✓ ${label}`);
          } else {
            console.log(`✗ ${label} still not usable after install — open a new shell (or fix PATH) and re-run.`);
            ok = false;
          }
        }
      } else {
        console.log(`  Skipped. Install it yourself, then re-run.`);
        ok = false;
      }
    } else if (darwin) {
      console.log(`  Homebrew not found — install ${label} yourself (https://brew.sh makes this one command).`);
      ok = false;
    } else {
      const fix = prerequisiteFix(name, { platform: process.platform });
      if (fix?.kind === "command") aptCommands.push(fix.command);
      ok = false;
    }
  }

  // The SERVER, not just the tools: which one this install will use, whether
  // it answers, and whether it is new enough to take the schema. All three are
  // settled here, before a database is created against the answer.
  let postgres = detectPostgres(envMap);
  if (!postgres.reachable && has(resolveBin("pg_isready"))) {
    console.log("✗ Postgres server not accepting connections");
    if (pgCtlStartArgs()) {
      // One consent for the whole bundled bring-up: the initdb/start/refuse
      // decision is `ensureBundledPostgresRunning`'s, the same call the
      // serving arms and `engager preflight` make, so `init` cannot answer
      // "may this data directory be opened?" differently from them. The
      // refusal prints from inside it; the ✗ server line below carries the
      // verdict either way.
      if (
        await confirm("  Initialize and start the bundled Postgres cluster?", { assumeYes, nonInteractive })
      ) {
        if (ensureBundledPostgresRunning(process.env, undefined, { initdb: true })) {
          postgres = detectPostgres(envMap);
        }
      }
    } else if (brewAvailable) {
      if (await confirm("  Start Postgres via `brew services`?", { assumeYes, nonInteractive })) {
        if (startBrewPostgres()) postgres = detectPostgres(envMap);
      }
    } else {
      console.log("  Start it yourself (e.g. `sudo service postgresql start`), then re-run.");
    }
  }
  if (has(resolveBin("psql"))) {
    console.log(postgresLine(postgres));
    if (!postgres.ok) ok = false;
  }

  // AI READINESS, reported separately and NOT a machine prerequisite.
  //
  // Engager runs every model call — discovery enrichment, Brain seeding,
  // product ingest, drafting — through the owner's own agent CLI on their
  // existing subscription, so its absence is real and this row says so. What
  // it must not do is stop provisioning: the dashboard's picker is how the
  // owner CHOOSES an agent, and an install that refuses to come up because the
  // choice has not been made yet can never present it. A Mac with no agent
  // CLI, or with one Engager cannot drive, provisions the machine, serves the
  // dashboard, and meets the picker; `engager doctor` and the Agent page name
  // the inference failure from there.
  const agent = agentCliPrereq(envMap);
  const agentFix = prerequisiteFix("prereq:agent-cli", { agentBin: agent.bin });
  console.log(
    agent.present
      ? `✓ ${agent.label} on PATH`
      : `✗ ${agent.label} not found — Engager runs every model call through it${agentFix ? ` (${agentFix.url})\n    ${agentFix.command}` : ""}\n    To configure an agent later, run engager agent-setup inventory --json.`,
  );

  if (aptCommands.length > 0) {
    console.log("\nInstall the missing prerequisites, then re-run:");
    for (const cmd of [...new Set(aptCommands)]) console.log(`  ${cmd}`);
  }

  return { ok, warnings, postgres };
}

/** The Homebrew Postgres keg on this machine, when one is installed but its
 *  `bin` is off PATH — the commonest macOS cause of a missing-client-tools
 *  ✗, and the one the owner must not answer by reinstalling what they have.
 *  `null` when brew lists no postgresql formula. */
function brewPostgresKeg() {
  const list = spawnSync("brew", ["list", "--formula"], { encoding: "utf8" });
  const formula = list.stdout
    ?.split("\n")
    .find((name) => name.trim().startsWith("postgresql"))
    ?.trim();
  if (!formula) return null;
  const prefix = spawnSync("brew", ["--prefix", formula], { encoding: "utf8" });
  if (prefix.status !== 0) return null;
  return { formula, binDir: `${prefix.stdout.trim()}/bin` };
}

/**
 * The ONE table of what fixes a failing prerequisite, keyed on the row name
 * `prerequisiteReport` emits. Every surface that tells the owner what to do
 * — `doctor`'s lines, `init`'s "install it yourself" lines, `preflight`'s
 * JSON and the first-run window rendering it — reads this table, so the
 * command the terminal prints and the command the window offers to copy are
 * the same string.
 *
 * Three kinds. `auto`: the product starts it itself (`ensureBundledPostgresRunning`,
 * `startBrewPostgres`), nothing to type. `command`: the terminal line that
 * installs it, with an optional `label` and `url` for the surface that can
 * open a page. `url`: nothing on this machine can install it, only a page to
 * open. `null`: nothing to prescribe for that row on this machine.
 *
 * Nothing here runs anything. The founder rule that nothing is installed
 * without an explicit yes holds: the terminal is the yes.
 */
export function prerequisiteFix(
  name,
  { platform = process.platform, brew = false, brewPostgres = null, bundled = false, agentBin = "claude" } = {},
) {
  const darwin = platform === "darwin";
  const homebrew = { kind: "url", url: "https://brew.sh", label: "Install Homebrew, then re-check" };
  switch (name) {
    case "prereq:node":
      return { kind: "url", url: "https://nodejs.org", label: "Install Node 22 or newer" };
    case "prereq:uv":
      return { kind: "command", command: "curl -LsSf https://astral.sh/uv/install.sh | sh" };
    case "prereq:pg-client":
      if (brewPostgres) {
        return {
          kind: "command",
          command: `echo 'export PATH="${brewPostgres.binDir}:$PATH"' >> ~/.zshrc`,
          label: `${brewPostgres.formula} is installed but keg-only — put it on PATH, then open a new shell`,
        };
      }
      if (brew) return { kind: "command", command: "brew install postgresql@17" };
      if (darwin) return homebrew;
      return { kind: "command", command: "sudo apt-get install -y postgresql postgresql-client" };
    case "prereq:pg-server":
      if (bundled || brew) return { kind: "auto" };
      if (darwin) return homebrew;
      return { kind: "command", command: "sudo service postgresql start" };
    case "prereq:agent-cli":
      // The vendors' one official commands, mirrored from core's installer
      // table (`packages/core/ai/agentCli/installers.ts`) — plain JS cannot
      // import the TS core, so `installers.test.ts` pins these strings to
      // the table's instead of letting doctor drift from the button.
      if (agentBin === "claude") {
        return {
          kind: "command",
          command: "curl -fsSL https://claude.ai/install.sh | bash",
          url: "https://claude.com/claude-code",
          label: "Install Claude Code",
        };
      }
      if (agentBin === "codex") {
        return {
          kind: "command",
          command: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
          url: "https://developers.openai.com/codex/cli/",
          label: "Install Codex",
        };
      }
      return null;
    case "prereq:agent-signin":
      return { kind: "command", command: "claude /login" };
    default:
      return null;
  }
}

/**
 * Every machine prerequisite as one row each — `{ name, status, title,
 * detail?, fix? }` — plus the report's verdict and, on a claude-pinned
 * install, the sign-in probe's word for `doctorReport.setClaude`. Pure over
 * its deps: `doctor`, `preflight` and `init`'s readout all render THESE rows,
 * and the first-run window decodes them, so a prerequisite exists in one
 * place or not at all.
 *
 * `fix` is attached to failing rows only, from `prerequisiteFix`. Two rows
 * carry a nuance the others do not. `prereq:pg-server` reads
 * `postgresStartFailure`: a caller that already tried to start the server
 * (`preflight`) hands in why it could not, and the row then shows that text
 * with no `auto` fix — a spinner that never stops would be the alternative.
 * `prereq:agent-signin` is `warn`, never `fail`, and never moves `ok`:
 * `claudeAuthStatus` is a heuristic about where a credential lives, and a
 * false positive must not wall the setup (see its doc comment).
 */
export function prerequisiteReport(envMap = new Map(), deps = {}) {
  const {
    platform = process.platform,
    nodeVersion = process.versions.node,
    present = has,
    env = process.env,
    postgres = detectPostgres(envMap),
    claudeAuth = (bin) => claudeAuthStatus({ bin }),
    postgresStartFailure = null,
  } = deps;
  const darwin = platform === "darwin";
  const brew = darwin && present("brew");
  const agent = agentCliPrereq(envMap, { present });
  const pgClientOk =
    present(resolveBin("pg_isready", env)) &&
    present(resolveBin("createdb", env)) &&
    present(resolveBin("psql", env));
  const brewPostgres =
    deps.brewPostgres !== undefined ? deps.brewPostgres : brew && !pgClientOk ? brewPostgresKeg() : null;
  const fixContext = { platform, brew, brewPostgres, bundled: Boolean(env.ENGAGER_PGDATA), agentBin: agent.bin };
  const row = (name, ok, title, detail) => {
    const entry = { name, status: ok ? "ok" : "fail", title };
    if (detail) entry.detail = detail;
    if (!ok) {
      const fix = prerequisiteFix(name, fixContext);
      if (fix) entry.fix = fix;
    }
    return entry;
  };
  /** The same row with `warn` in place of `fail`: printed with a ✗, excluded
   *  from the machine verdict, and still carrying what to do about it. */
  const aiRow = (name, ok, title, detail) => {
    const entry = row(name, ok, title, detail);
    if (entry.status === "fail") entry.status = "warn";
    return entry;
  };

  const nodeOk = Number(nodeVersion.split(".")[0]) >= MIN_NODE_MAJOR;
  const at = `${postgres.host ?? DEFAULT_POSTGRES.host}:${postgres.port ?? DEFAULT_POSTGRES.port}`;
  const release = (postgres.version ?? "").split(" on ")[0];
  const server = row(
    "prereq:pg-server",
    postgres.ok,
    "Postgres server",
    postgres.ok
      ? `reachable on ${at} (${release})`
      : !postgres.reachable
        ? (postgresStartFailure ?? `no server answering on ${at}`)
        : `${at} is ${release || "too old"} — Engager needs 15 or newer. The schema uses UNIQUE ... NULLS NOT DISTINCT (PG 15+). Start a 15+ server, or point DATABASE_URL and ENGAGER_MIGRATE_DATABASE_URL at one you already run.`,
  );
  if (postgresStartFailure && !postgres.reachable) delete server.fix;

  const rows = [
    row("prereq:node", nodeOk, `Node >= ${MIN_NODE_MAJOR}`, nodeOk ? undefined : `Node ${nodeVersion} found`),
    row("prereq:uv", present(resolveBin("uv", env)), "uv on PATH"),
    row(
      "prereq:pg-client",
      pgClientOk,
      "Postgres client tools",
      brewPostgres ? `${brewPostgres.formula} is installed but keg-only` : undefined,
    ),
    server,
    // AI READINESS, reported BESIDE the machine and never as one of its
    // failures. Engager runs its own model calls through this CLI, so its
    // absence is real — but it is not a machine prerequisite, and a Mac with
    // no agent CLI (or one Engager cannot drive) must still reach the
    // dashboard's own picker and choose there. A `fail` here is what made an
    // agent-less or Codex-only install look unable to provision at all.
    aiRow(
      "prereq:agent-cli",
      agent.present,
      `${agent.label} (runs every model call)`,
      agent.present
        ? undefined
        : "not found — choose an agent on the dashboard's Agent page once it is running",
    ),
  ];
  let claude;
  if (agent.agent === "claude") {
    claude = claudeAuth(agent.bin);
    if (claude === "signed-out") {
      rows.push({
        name: "prereq:agent-signin",
        status: "warn",
        title: `${agent.label} signed in`,
        detail:
          "installed but not signed in — sign in with the CLI, or choose another agent on the dashboard's Agent page",
        fix: prerequisiteFix("prereq:agent-signin", fixContext),
      });
    } else if (claude === "ready") {
      rows.push({ name: "prereq:agent-signin", status: "ok", title: `${agent.label} signed in` });
    }
  }
  const ok = rows.every((entry) => entry.status !== "fail");
  return { rows, ok, claude };
}

/** One human line per row — the ✓/✗ readout `doctor` and `init` print —
 *  with the fix folded under a failing row as the same string the JSON
 *  carries. An `auto` fix names who starts it rather than what to type. */
export function prerequisiteLines(rows) {
  return rows.map((entry) => {
    let line = `${entry.status === "ok" ? "✓" : "✗"} ${entry.title}${entry.detail ? ` — ${entry.detail}` : ""}`;
    const fix = entry.fix;
    if (!fix) return line;
    if (fix.kind === "auto") return `${line}\n  → engager starts it (init, preflight, dashboard, agent)`;
    if (fix.label) line += `\n  → ${fix.label}`;
    if (fix.kind === "command") line += `\n    ${fix.command}`;
    else line += `\n    ${fix.url}`;
    return line;
  });
}

/**
 * Start the Postgres server this install would use, if one is installed and
 * merely stopped -- `engager preflight`'s bring-up, and the answer to "why
 * is a stopped database the owner's problem?". Bundled (`ENGAGER_PGDATA`):
 * `ensureBundledPostgresRunning` with `initdb` allowed, because preflight is
 * the only thing running while the first-run window owns the machine. Brew
 * (no `ENGAGER_PGDATA`, darwin, brew and the client tools present): one
 * `brew services start`. Anything else: nothing to start here, and the
 * server row's own fix applies. Returns `{ ok, failure }` -- `failure` is
 * the reason a start that was ATTEMPTED did not bring a server up (a
 * refusal, a `pg_ctl` that exited without a listener), or `null`, so the
 * server row can show that text instead of promising an `auto` start that
 * already failed.
 *
 * `quiet` captures finite probes and discards daemon startup output:
 * `--json` must print one object, and (DOCTRINE, 2026-08-22) `pg_ctl start`
 * under a PIPED stdio hangs the parent forever when the daemonized
 * postmaster inherits the pipe -- the app runs this command through a pipe,
 * so `ignore` is the only safe spelling for that startup command.
 */
export function bringUpPostgres(envMap = new Map(), deps = {}) {
  const {
    env = process.env,
    platform = process.platform,
    quiet = false,
    present = has,
    spawn = spawnSync,
    detect = () => detectPostgres(envMap),
    startBundled = (log) =>
      ensureBundledPostgresRunning(
        env,
        {
          // Finite commands keep their output: the version probe enforces the
          // cluster-major guard, and initdb's stderr explains a refusal.
          // Only pg_ctl start can leave a daemon holding the parent's pipe.
          spawn: (command, args, options) =>
            spawn(
              command,
              args,
              quiet
                ? {
                    ...options,
                    stdio: path.basename(command) === "pg_ctl" && args.includes("start")
                      ? "ignore"
                      : ["ignore", "pipe", "pipe"],
                    encoding: "utf8",
                  }
                : options,
            ),
          readFile: readFileSync,
          exists: existsSync,
          log,
        },
        { initdb: true },
      ),
    startBrew = () => startBrewPostgres({ quiet, spawn }),
  } = deps;
  if (detect().reachable) return { ok: true, failure: null };
  if (pgCtlStartArgs(env)) {
    const lines = [];
    if (startBundled((line) => lines.push(line))) return { ok: true, failure: null };
    return {
      ok: false,
      failure: lines.at(-1) ?? `pg_ctl start exited without a server answering on ${env.ENGAGER_PG_PORT ?? DEFAULT_POSTGRES.port}`,
    };
  }
  if (platform === "darwin" && present("brew") && present(resolveBin("pg_isready", env))) {
    if (startBrew()) return { ok: true, failure: null };
    return { ok: false, failure: "brew services start did not bring a Postgres server up" };
  }
  return { ok: false, failure: null };
}

/** The ONE place a bundled cluster is opened. When the environment points
 *  at a BUNDLED cluster (`ENGAGER_PGDATA` set -- the same null contract every
 *  seam here carries) and no server is accepting yet, start it with the exact
 *  argv `pgCtlStartArgs` computes; a major mismatch gets `bundledClusterPlan`'s
 *  own refusal text. `initdb` decides what an absent or empty data directory
 *  gets: `false` (the serving arms -- `engager dashboard`, `engager agent`)
 *  prints a refusal, because two processes starting concurrently must never
 *  race `initdb` on the same directory; `true` (`engager init` after its
 *  consent, and `engager preflight`, which is the only thing running while
 *  the first-run window owns the machine) initialises it first with
 *  `initdbArgs`' argv. Deps are injected so a test drives every arm without
 *  a database. Returns true when a server is accepting by the time we are
 *  done -- already, or because the start worked. */
export function ensureBundledPostgresRunning(
  env = process.env,
  deps = { spawn: spawnSync, readFile: readFileSync, exists: existsSync, log: console.log },
  { initdb = false } = {},
) {
  const startArgs = pgCtlStartArgs(env);
  if (!startArgs) return true; // brew-managed contract: not this seam's cluster
  const accepting = () =>
    deps.spawn(
      resolveBin("pg_isready", env),
      ["-h", "localhost", ...(env.ENGAGER_PG_PORT ? ["-p", env.ENGAGER_PG_PORT] : []), ...READINESS_DB],
      { encoding: "utf8" },
    ).status === 0;
  if (accepting()) return true;
  const dataDir = env.ENGAGER_PGDATA;
  const exists = deps.exists(dataDir);
  let pgVersion = null;
  if (exists) {
    try {
      pgVersion = deps.readFile(path.join(dataDir, "PG_VERSION"), "utf8").trim();
    } catch {
      pgVersion = null;
    }
  }
  const binaryMajor = parsePgCtlMajor(
    deps.spawn(resolveBin("pg_ctl", env), ["--version"], { encoding: "utf8" }).stdout,
  );
  const verdict = pgDataVerdict({ exists, pgVersion, binaryMajor });
  const plan = bundledClusterPlan({ verdict, dataDir, clusterMajor: pgVersion, binaryMajor });
  if (plan.refusal) {
    deps.log(plan.refusal);
    return false;
  }
  if (plan.initdb) {
    if (!initdb) {
      deps.log(`✗ ${dataDir} holds no cluster yet — run \`engager init\` first.`);
      return false;
    }
    // A failed initdb must be the failure named, never the `pg_ctl start`
    // that would fail after it for a reason the owner cannot see -- and
    // never a start attempted against a half-written directory.
    const initialised = deps.spawn(resolveBin("initdb", env), initdbArgs(env), { stdio: "inherit" });
    if (initialised.status !== 0) {
      const reason = (initialised.stderr ?? "").trim().split("\n").filter(Boolean).at(-1);
      deps.log(`✗ initdb exited ${initialised.status ?? "abnormally"} initialising ${dataDir}${reason ? ` — ${reason}` : ""}`);
      return false;
    }
  }
  deps.spawn(resolveBin("pg_ctl", env), startArgs, { stdio: "inherit" });
  return accepting();
}
