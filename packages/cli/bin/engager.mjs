#!/usr/bin/env node
// The front door to the ONE local product — not a separate runner. Two modes,
// same code paths underneath:
//   checkout  — running inside the repository: subcommands exec the repo's own
//               scripts via tsx from source.
//   packaged  — installed from npm: subcommands run the esbuild-compiled
//               entries in dist/, state lives in ~/.engager (env file, sidecar
//               venv), and the dashboard stays checkout-only for now.
import "./lib/developmentBootstrap.mjs";
import { developmentActivated, verifyDevelopmentDatabase } from "./lib/developmentProfile.mjs";
import { openDevelopmentAgentBrowser, openDevelopmentBrowser } from "./lib/developmentBrowser.mjs";
import { prepareMacUpdate, prepareDevelopmentMacUpdate, finishMacUpdate, cancelMacUpdate, macSchemaPath, macUpdateTicket, migrationFingerprint } from "./lib/macMaintenance.mjs";
import { verifyMacMigrationHistory } from "./lib/macDatabase.mjs";
import { withLifecycleLock, recoverLifecycleLock, lifecycleStatus } from "./lib/coreLifecycle.mjs";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { desktopPlatform, setupClient } from "./lib/clientSetup.mjs";
import { writeCodexMcp } from "./lib/codexMcp.mjs";
import { runInstaller, installerFailure, installerEnvironment } from "./lib/installer.mjs";
import { ensureOwnDatabase } from "./lib/ownDatabase.mjs";
import { installLegacySkills, uninstallLegacySkills } from "./lib/legacySkills.mjs";
import {
  agentCliPrereq,
  bringUpPostgres,
  ensureBundledPostgresRunning,
  ensurePrerequisites,
  prerequisiteLines,
  pgCtlStopArgs,
  prerequisiteReport,
  resolveBin,
} from "./lib/prereqs.mjs";
import {
  deploymentModeLine,
  doctorExitCode,
  doctorReport,
  renderDoctorJson,
  reportBackgroundInference,
} from "./lib/doctorReport.mjs";
import {
  databaseNameFromEnv,
  ensureLocalEnv,
  postgresConnection,
  readEnvFile,
  setEnvKey,
} from "./lib/localEnv.mjs";
import { authorityStatusLine } from "./lib/authorityStatus.mjs";
import { managedAppEnvironment } from "./lib/dashboardSession.mjs";
import { licenseLogin, licenseLogout, loopbackBaseUrl } from "./lib/licenseLogin.mjs";
import { licenseStatusLine } from "./lib/licenseStatus.mjs";
import { BrowserInstallError } from "./lib/browserInstall.mjs";
import { BrowserToolsError, macSetupStatus, macSetupStatusLines, runMacBrowserSetup } from "./lib/macSetup.mjs";
import { BrowserCheckError, runBrowserCheck } from "./lib/browserCheck.mjs";
import { keepData, startFresh, stopPortHolder, writeSetupMarker } from "./lib/macEnvironment.mjs";
import { clearCaches, measureClearable } from "./lib/macSpace.mjs";
import {
  claudeMcpAddArgs,
  inAppBundle,
  mcpInvocation,
  shimPath,
  shimStatus,
  removeCodexMcpBlock,
  shimStatusLine,
  writeShim,
} from "./lib/shim.mjs";

const BIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(BIN_DIR, "..");
const CHECKOUT_ROOT = path.resolve(PKG, "..", "..");
const CHECKOUT = existsSync(path.join(CHECKOUT_ROOT, "packages", "core"));
const HOME_DIR = process.env.ENGAGER_HOME ?? path.join(os.homedir(), ".engager");
/** A harness seam, not a product flag — deliberately absent from HELP: the
 *  checkout/packaged pair is the contract, and an advertised third location
 *  would be a second one. Without it a checkout-mode `init` subprocess writes
 *  and rewrites the DEVELOPER'S OWN REPO `.env` — `provision()` passes
 *  ENV_FILE to `ensureLocalEnv`, and `init()` then calls `setEnvKey(ENV_FILE,
 *  "ENGAGER_ORG_ID", …)` below — so an e2e harness run would repoint the
 *  developer's `DATABASE_URL` and org at a throwaway cluster. */
const ENV_FILE =
  process.env.ENGAGER_ENV_FILE ??
  (CHECKOUT ? path.join(CHECKOUT_ROOT, ".env") : path.join(HOME_DIR, ".env"));

/** npx runs from a CACHE directory that npm may evict at any time, and the
 *  `engager` binary it exposes vanishes the moment the command exits. An
 *  install there works for one run but cannot host a durable MCP registration
 *  or a `engager up` the user types tomorrow. */
const NPX_CACHE_INSTALL = !CHECKOUT && /[/\\]_npx[/\\]/.test(PKG);

const IN_APP_BUNDLE = !CHECKOUT && inAppBundle(PKG);

/** A bundle launch owns its whole runtime (owner directive, 2026-08-31):
 *  inside the .app, default the bundled-Postgres trio so a Finder launch
 *  -- which exports nothing -- reaches the same cluster `engager init`
 *  provisioned. Explicit env still wins, so a developer pointing at
 *  another cluster keeps it. 54329 is phase-22's port; `pgdata` sits
 *  beside the rest of `~/.engager` because the bundle is replaced
 *  wholesale on update and the cluster must survive that. */
if (IN_APP_BUNDLE) {
  process.env.ENGAGER_PG_BIN_DIR ??= path.join(PKG, "..", "runtime-resources", "postgresql", "bin");
  process.env.ENGAGER_PGDATA ??= path.join(HOME_DIR, "pgdata");
  process.env.ENGAGER_PG_PORT ??= "54329";
  // The bundled uv, for the same reason: the browser-use client reads this
  // key (`packages/core/linkedin/browser-use/subprocessTransport.ts`) and the uv row
  // probes it, and a Finder launch has no uv on PATH. Only when the bundle
  // actually carries one — a key naming a missing file is worse than no key,
  // because it makes `resolveBin`'s fall through to PATH unreachable.
  const bundledUv = path.join(PKG, "..", "runtime-resources", "uv", "uv");
  if (existsSync(bundledUv)) process.env.ENGAGER_UV_BIN ??= bundledUv;
}
const SHIM_PATH = shimPath(os.homedir());

const HELP = `Engager headless

Usage: engager <command>

  init         Create the local database and organization, install skills and register MCP.
               Use --yes to accept prerequisite installs or --non-interactive to skip prompts.
  up, agent    Run the scheduler and worker in the foreground. Ctrl-C stops them.
  mcp          Serve MCP over stdio for a local agent.
  call         Call an MCP tool, e.g. engager call get_status.
  doctor       Check the local installation. Add --json for a machine-readable report.
  mac-setup    Install the Mac browser with "mac-setup run browser" after building.
  agent-setup  Discover, connect and check your own agent CLI.
  export       Export local data with --portable --output FILE --passphrase-file FILE.
  restore      Restore an export with FILE --passphrase-file FILE.
  uninstall    Remove Engager's client registrations and installed skills.
  --version    Print the installed version.`;

/** KEY=VALUE lines from the mode's env file, never overriding the real
 *  environment — the same precedence the product's own scripts use. */
function baseEnv() {
  const env = { ...process.env };
  if (existsSync(ENV_FILE)) {
    for (const [key, value] of readEnvFile(ENV_FILE)) {
      if (env[key] === undefined) env[key] = value;
    }
  }
  // Where this install runs, for usage data (INV-19): the Mac app's launcher
  // is the only thing that says "mac". Every child (agent, dashboard, MCP)
  // inherits it, so every event carries the same placement.
  env.ENGAGER_PLACEMENT ??= IN_APP_BUNDLE ? "mac" : "checkout";
  if (!CHECKOUT) {
    // Read-only install dirs (npm global, brew Cellar): the sidecar venv must
    // land outside the package. The child-env allowlist passes this through.
    env.UV_PROJECT_ENVIRONMENT ??= path.join(HOME_DIR, "venv");
    // Where THIS install lives, said rather than derived: the dashboard is a
    // webpack build, whose `import.meta.url` is the build machine's path, so
    // its skills registry and its in-session drain cannot find the package
    // from their own location.
    env.ENGAGER_SKILLS_DIR ??= path.join(PKG, "skills");
    env.ENGAGER_CLI_ROOT ??= PKG;
  }
  return managedAppEnvironment(env, IN_APP_BUNDLE);
}

/** Where children run: the repo in checkout mode; ~/.engager in packaged mode
 *  (entry scripts loadEnvFile("./.env") relative to cwd, so the env file must
 *  sit in the working directory). */
function childCwd() {
  if (CHECKOUT) return CHECKOUT_ROOT;
  mkdirSync(HOME_DIR, { recursive: true });
  return HOME_DIR;
}

/** [command, args] for a product entry in the current mode. */
function entry(name) {
  return CHECKOUT
    ? [process.execPath, ["--import", "tsx", entryCheckoutPath(name)]]
    : [process.execPath, [path.join(PKG, "dist", `${name}.mjs`)]];
}

function entryCheckoutPath(name) {
  const map = {
    mcp: path.join(CHECKOUT_ROOT, "packages", "core", "mcp", "server.ts"),
    agent: path.join(CHECKOUT_ROOT, "scripts", "agent.ts"),
    worker: path.join(CHECKOUT_ROOT, "scripts", "worker.ts"),
    scheduler: path.join(CHECKOUT_ROOT, "scripts", "scheduler.ts"),
    migrate: path.join(CHECKOUT_ROOT, "packages", "database", "migrate.ts"),
    bootstrap: path.join(CHECKOUT_ROOT, "scripts", "bootstrap-org.ts"),
    "core-command": path.join(CHECKOUT_ROOT, "scripts", "core-command.ts"),
    "refresh-license": path.join(CHECKOUT_ROOT, "scripts", "refresh-license.ts"),
  };
  return map[name];
}

function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: childCwd(),
    env: baseEnv(),
    stdio: "inherit",
    ...options,
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("exit", (code, signal) => {
    process.exit(signal ? 1 : (code ?? 1));
  });
}

function runEntry(name) {
  const [command, args] = entry(name);
  run(command, args);
}

/** Like `run`, but the CALLER keeps control: this resolves the child's exit
 *  code instead of taking the whole process down with it. */
function runEntryToCompletion(name, extraArgs, extraEnv = {}) {
  const [command, args] = entry(name);
  return new Promise((resolve) => {
    const child = spawn(command, [...args, ...extraArgs], {
      cwd: childCwd(),
      env: { ...baseEnv(), ...extraEnv },
      stdio: "inherit",
    });
    child.on("error", () => resolve(1));
    child.on("exit", (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });
}

const DASHBOARD_PORT = process.env.ENGAGER_DASHBOARD_PORT ?? "3000";

/** The one version this binary reports. npm always packs package.json, and the
 *  package's `files` list deliberately does NOT carry the root VERSION file —
 *  so the manifest beside the bin is the only copy a packaged install has.
 *  scripts/check-versions.ts is what keeps it equal to the root VERSION. */
function packageVersion() {
  return JSON.parse(readFileSync(path.join(PKG, "package.json"), "utf8")).version;
}

/** `createdb` for the DATABASE_URL database — a no-op when it already exists.
 *
 *  Addressed EXPLICITLY off the env file. `createdb <name>` alone connects to
 *  whatever cluster libpq defaults to, which on a machine running two of them
 *  is not necessarily the one the URLs name: the database was created over
 *  there, this printed ✓, and the migration then failed on a server where it
 *  did not exist. The owner URL supplies the identity, because `engager_app`
 *  is a non-superuser that cannot create databases at all. */
function createDatabase(envMap) {
  const dbName = databaseNameFromEnv(envMap);
  const target =
    postgresConnection(envMap.get("ENGAGER_MIGRATE_DATABASE_URL")) ?? {};
  const bin = resolveBin("createdb");
  const result = spawnSync(
    bin,
    [
      ...(target.host ? ["-h", target.host] : []),
      ...(target.port ? ["-p", String(target.port)] : []),
      ...(target.user ? ["-U", target.user] : []),
      dbName,
    ],
    {
      encoding: "utf8",
      env: baseEnv(),
    },
  );
  if (result.status === 0) {
    console.log(`✓ database "${dbName}" created`);
    return true;
  }
  if (/already exists/.test(result.stderr ?? "")) {
    console.log(`✓ database "${dbName}" present`);
    return true;
  }
  // spawnSync sets `error` (not stderr) when the binary itself is missing —
  // printing the empty stderr there produced a failure message with no cause.
  if (result.error?.code === "ENOENT") {
    console.log(
      `✗ ${bin} not found on PATH — the Postgres client tools are installed but not linked.\n` +
        `  On macOS: echo 'export PATH="$(brew --prefix postgresql@17)/bin:$PATH"' >> ~/.zshrc`,
    );
    return false;
  }
  console.log(
    `✗ createdb ${dbName} failed: ${(result.stderr ?? "").trim() || (result.error?.message ?? "unknown error")}`,
  );
  return false;
}

/** Prerequisites (with consented installs) → env file → createdb → migrate.
 *  Shared by `setup` and `init`; exits on any hard failure. One run, no
 *  hand-editing — every generated key is computed here. */
async function provision({ assumeYes, nonInteractive, rerunCommand }) {
  // The env file may not exist yet on a first run — `readEnvFile` answers with
  // an empty map and the agent row falls back to the auto default, which is
  // exactly what a fresh install should be told to install.
  const prereqs = await ensurePrerequisites({
    assumeYes,
    nonInteractive,
    envMap: readEnvFile(ENV_FILE),
  });
  if (!prereqs.ok) {
    console.error(`\nfix the ✗ items above, then re-run \`${rerunCommand}\`.`);
    process.exit(1);
  }
  // The env file is written against the server the check above actually found,
  // so a first run on a machine whose Postgres is not on the default port is
  // provisioned rather than left to fail mid-migration.
  const { env, added } = await ensureLocalEnv(ENV_FILE, {
    assumeYes,
    postgres: prereqs.postgres,
  });
  console.log(
    added.length > 0
      ? `✓ ${ENV_FILE}: added ${added.join(", ")}`
      : `✓ ${ENV_FILE} present`,
  );
  if (!createDatabase(env)) process.exit(1);
  console.log("→ migrating the local database…");
  if (!migrateSync().ok) {
    console.error(`✗ database migration failed — fix the error above and re-run \`${rerunCommand}\`.`);
    process.exit(1);
  }
  return env;
}

async function setup({ assumeYes, nonInteractive }) {
  await provision({ assumeYes, nonInteractive, rerunCommand: "engager setup" });
  console.log("✓ setup complete — `engager init` also creates the org, installs skills, and registers MCP.");
}

/** Migration that returns instead of replacing the process — init continues
 *  after it. `quiet` captures the child's output instead of inheriting the
 *  terminal, for `preflight --json`; the captured text is what a failure
 *  row shows. */
function migrateSync({ quiet = false } = {}) {
  const [command, args] = CHECKOUT
    ? ["npm", ["run", "--silent", "pg:migrate"]]
    : entry("migrate");
  const result = spawnSync(command, args, {
    cwd: childCwd(),
    env: baseEnv(),
    stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** The skills tree shipped with this install: repo skills/ in checkout mode,
 *  the packaged copy (kept current by scripts/sync-skills.mjs) otherwise —
 *  unless `ENGAGER_SKILLS_DIR` names one, the same key the registry serves
 *  from, so what `init` installs and what MCP serves are one tree. */
function skillsSourceDir() {
  return baseEnv().ENGAGER_SKILLS_DIR
    ?? (CHECKOUT ? path.join(CHECKOUT_ROOT, "skills") : path.join(PKG, "skills"));
}

/** Install every skill into the roots the clients actually read, in the
 *  journalled custody `legacySkills.mjs` documents — no network needed, and
 *  no file the owner wrote is replaced or removed. */
function installSkills() {
  return installLegacySkills({
    root: HOME_DIR,
    home: os.homedir(),
    source: skillsSourceDir(),
    codexHome: process.env.CODEX_HOME,
  });
}

function registerMcp() {
  const invocation = mcpInvocation({
    inBundle: IN_APP_BUNDLE,
    shimPath: SHIM_PATH,
    nodeBin: process.execPath,
    engagerMjs: path.join(BIN_DIR, "engager.mjs"),
  });
  const hasClaude =
    spawnSync("claude", ["--version"], { encoding: "utf8" }).status === 0;
  if (hasClaude) {
    // Idempotent re-register: remove any stale user-scope entry first.
    spawnSync("claude", ["mcp", "remove", "-s", "user", "engager-local"], {
      encoding: "utf8",
    });
    const added = spawnSync("claude", claudeMcpAddArgs(invocation), { encoding: "utf8" });
    if (added.status === 0) {
      console.log("✓ MCP server registered with Claude Code (user scope: engager-local)");
    } else {
      console.log(`✗ claude mcp add failed: ${(added.stderr || "").trim()}`);
    }
  } else {
    console.log("→ Claude Code not found on PATH; register the MCP server yourself:");
    console.log(`    claude mcp add -s user engager-local -- ${invocation.join(" ")}`);
  }
  registerCodexMcp(invocation);
}

/** Write the shared ChatGPT desktop/Codex CLI host configuration, including
 *  before the client is installed. Idempotent by REPAIR: an older entry
 *  may point at a command this install no longer provides, so
 *  leaving it alone left Codex permanently broken with a reassuring
 *  "already present" line. */
function registerCodexMcp(invocation) {
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  try {
    const { configPath, state } = writeCodexMcp({ codexHome, invocation });
    console.log(`✓ ChatGPT desktop / Codex CLI MCP ${state} (${configPath})`);
  } catch {
    // A client config we cannot safely write must not strand Mac setup after
    // its database is ready. The client can register its own entry instead.
    console.log("✗ ChatGPT desktop / Codex CLI MCP could not be registered; your configuration was preserved.");
    console.log(`→ Add a stdio MCP server named engager-local in the client: ${invocation.join(" ")}`);
  }
}

/** Run the org-bootstrap entry and return its parsed JSON result, or null. */
function bootstrapOrg() {
  const [command, args] = entry("bootstrap");
  const result = spawnSync(command, args, {
    cwd: childCwd(),
    env: baseEnv(),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    console.error((result.stderr || result.stdout || "").trim());
    return null;
  }
  for (const line of (result.stdout ?? "").trim().split("\n").reverse()) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed.organizationId === "string") return parsed;
    } catch {
      // Non-JSON stdout noise (startup logs) is expected.
    }
  }
  console.error("✗ org bootstrap printed no JSON result");
  return null;
}

async function init({ assumeYes, nonInteractive }) {
  console.log(`engager init — prerequisites, environment, database, organization, skills, MCP (${CHECKOUT ? "checkout" : "packaged"} mode)\n`);
  await provision({ assumeYes, nonInteractive, rerunCommand: "engager init" });
  console.log("→ creating the local organization…");
  const boot = bootstrapOrg();
  if (!boot) {
    console.error("✗ org bootstrap failed — fix the error above and re-run `engager init`.");
    process.exit(1);
  }
  const envMap = readEnvFile(ENV_FILE);
  if (envMap.get("ENGAGER_ORG_ID") !== boot.organizationId) {
    setEnvKey(ENV_FILE, "ENGAGER_ORG_ID", boot.organizationId);
  }
  console.log(`✓ organization ready (ENGAGER_ORG_ID=${boot.organizationId})`);
  installSkills();
  if (IN_APP_BUNDLE) {
    writeShim({ homeDir: os.homedir(), nodeBin: process.execPath, engagerMjs: path.join(BIN_DIR, "engager.mjs") });
    console.log(`✓ engager shim written (${SHIM_PATH})`);
  }
  registerMcp();
  if (NPX_CACHE_INSTALL) {
    console.log(`
! This ran from npx's temporary cache. Your database, env, skills, and org are
  permanent, but the \`engager\` command and the MCP registration point into a
  directory npm can evict. Make it durable:
      npm install -g engager && engager init`);
  }
  console.log("Verify this install with the get_status MCP tool.");
  console.log(CHECKOUT ? "  npm run --silent engager -- call get_status" : "  engager call get_status");
}

/**
 * Where the Brain's markdown notes live and how many there are — informational,
 * never a ✗: an empty vault is what a first run is supposed to have, and a
 * full one is the owner's own knowledge surviving whatever happened to the
 * database. Mirrors `config.brainDir` (packages/core/config.ts) the same way
 * `agentCliPrereq` mirrors agent selection: plain JS cannot import TS core.
 * Returns the printed line so `doctor()` can also record it.
 */
function reportBrainVault(envMap, say) {
  const raw = envMap.get("ENGAGER_BRAIN_DIR");
  const dir = raw
    ? path.resolve(raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw)
    : path.join(os.homedir(), ".engager", "brain");
  const notes = countMarkdown(dir);
  const line =
    notes === 0
      ? `· Brain vault empty (${dir})`
      : `· Brain vault: ${notes} note${notes === 1 ? "" : "s"} (${dir}) — knowledge outlives the database`;
  say(line);
  return line;
}

/** Markdown files under `dir`, recursively; 0 when it does not exist. */
function countMarkdown(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) total += countMarkdown(path.join(dir, entry.name));
    else if (entry.name.endsWith(".md")) total += 1;
  }
  return total;
}

/** Remove every skill `installSkills` put in place — what this install's
 *  journal names, plus the unmodified copies of what this release ships that
 *  the shell installer or an older run left, in the current roots and in the
 *  retired `~/.codex/skills` one. A skill an older install shipped and this
 *  one has since retired is not on the list and survives. */
function uninstallSkills() {
  uninstallLegacySkills({
    root: HOME_DIR,
    home: os.homedir(),
    source: skillsSourceDir(),
    codexHome: process.env.CODEX_HOME,
  });
}

/** Claude Desktop's entry, when this installation has one. No route here
 *  writes it — `engager client setup --client claude-desktop` does, and it
 *  journals exactly what it wrote — but the journal is about to be deleted by
 *  the purge below, and a journal removed before the entry it accounts for
 *  leaves that entry orphaned in the owner's config with nothing left to
 *  identify it as ours. A file the owner has since edited is reported and
 *  kept, as everywhere else in this custody. */
function removeDesktopMcp() {
  const client = "claude-desktop";
  if (!existsSync(path.join(HOME_DIR, `client-${client}.json`))) return;
  try {
    const removed = setupClient({ root: HOME_DIR, home: os.homedir(), client, source: skillsSourceDir(), invocation: [], platform: desktopPlatform(process.env), remove: true });
    console.log(
      removed.conflicts.length > 0
        ? `→ kept your own engager-local entry (${removed.paths.config})`
        : `✓ MCP registration removed from Claude Desktop (${removed.paths.config})`,
    );
  } catch (error) {
    console.log(`✗ Claude Desktop MCP entry not removed: ${error.message}`);
  }
}

/** Everything these routes write under `~/.engager`, by name, and the whole
 *  of what `uninstall --purge` deletes. A list rather than the directory
 *  because the directory is the OWNER's: anything else that lives there was
 *  put there by hand and is not this command's to remove — and whatever is
 *  missing from the list is REPORTED as the owner's, so an entry this install
 *  wrote and left off would be named back to them as theirs. `init`'s client
 *  journals and the agent selections a run stores are on it for that reason.
 *  An independently installed free core's own `installation.json`, payloads
 *  and receipts deliberately are not: that core is not this route's to
 *  remove, and its own `uninstall` refuses to purge at all. */
const OWNED_HOME_ENTRIES = [
  ".env",
  "pgdata",
  "bin",
  "venv",
  "brain",
  "browser",
  "browser-profile",
  "browser-bridge.json",
  "mac-setup.json",
  "browser-check.json",
  "browser-use-journal.json",
  "client-claude.json",
  "client-claude-desktop.json",
  "client-codex.json",
  "local-agents",
  "install-id",
  "license.json",
  "authority.json",
];

/** The reverse of `init`, minus the data. Every registration init made in
 *  OTHER programs' homes goes — Claude Code's user-scope MCP entry, the
 *  Codex table, the skills in both agents' skill directories — and so does
 *  the shim, because a deleted app leaves each of those pointing at a path
 *  that is gone, which every client reports as ENOENT and none can explain.
 *  `~/.engager` (env, the bundled cluster's data, the Brain vault, the
 *  cached license) is the owner's data and stays unless `--purge`; the flag
 *  is the consent, so there is no prompt to decline. Order: registrations
 *  first, shim last among them, so an interruption leaves nothing pointing
 *  at a shim that has already gone. */
function uninstall({ purge }) {
  const hasClaude = spawnSync("claude", ["--version"], { encoding: "utf8" }).status === 0;
  if (hasClaude) {
    const removed = spawnSync("claude", ["mcp", "remove", "-s", "user", "engager-local"], {
      encoding: "utf8",
    });
    console.log(
      removed.status === 0
        ? "✓ MCP registration removed from Claude Code (user scope: engager-local)"
        : "→ no Claude Code MCP registration to remove",
    );
  } else {
    console.log("→ Claude Code not found on PATH; no MCP registration to remove");
  }
  const codexConfig = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "config.toml");
  if (existsSync(codexConfig)) {
    const current = readFileSync(codexConfig, "utf8");
    const next = removeCodexMcpBlock(current);
    if (next === current) {
      console.log("→ no Codex MCP entry to remove");
    } else {
      writeFileSync(codexConfig, next);
      console.log(`✓ Codex MCP entry removed (${codexConfig})`);
    }
  }
  removeDesktopMcp();
  uninstallSkills();
  if (existsSync(SHIM_PATH)) {
    rmSync(SHIM_PATH);
    console.log(`✓ engager shim removed (${SHIM_PATH})`);
  }
  if (!purge) {
    console.log(`→ ${HOME_DIR} kept (env, database, Brain, license); add --purge to delete what Engager wrote there`);
    return;
  }
  // The bundled cluster runs out of the directory about to go; a data
  // directory deleted under a live postmaster is a crash, not a removal. A
  // brew-managed server (no ENGAGER_PGDATA) is not ours to stop.
  const stopArgs = pgCtlStopArgs();
  if (stopArgs && existsSync(path.join(process.env.ENGAGER_PGDATA, "postmaster.pid"))) {
    const stopped = spawnSync(resolveBin("pg_ctl"), stopArgs, { encoding: "utf8" });
    if (stopped.status !== 0) {
      console.error(`✗ could not stop the bundled Postgres: ${(stopped.stderr || stopped.stdout || "").trim()}`);
      console.error(`  ${HOME_DIR} kept — stop it yourself, then re-run \`engager uninstall --purge\`.`);
      process.exit(1);
    }
    console.log("✓ bundled Postgres stopped");
  }
  for (const entry of OWNED_HOME_ENTRIES) rmSync(path.join(HOME_DIR, entry), { recursive: true, force: true });
  const foreign = existsSync(HOME_DIR) ? readdirSync(HOME_DIR) : [];
  if (foreign.length === 0) {
    rmSync(HOME_DIR, { recursive: true, force: true });
    console.log(`✓ ${HOME_DIR} removed`);
  } else {
    console.log(`✓ ${HOME_DIR} purged; kept what Engager did not write: ${foreign.join(", ")}`);
  }
}

/** Read-only health check: no installs, no writes, exit code reflects health.
 *  `json` prints one machine-readable report instead of the human lines below
 *  — the SAME checks, in the SAME order, with the SAME verdict; see
 *  doctorReport.mjs for why the report is shaped as an accumulator. */
function doctor({ json }) {
  const report = doctorReport(CHECKOUT ? "checkout" : "packaged");
  const say = (line) => { if (!json) console.log(line); };
  say(`engager doctor (${CHECKOUT ? "checkout" : "packaged"} mode)\n`);
  // Read before the checks: the agent prereq row probes whichever binary the
  // pin in here names, rather than the literal `claude` it used to assume.
  const envMap = readEnvFile(ENV_FILE);
  // One row per prerequisite, the same rows `preflight` emits and the
  // first-run window renders. The sign-in probe runs here whether or not an
  // env file exists yet: a fresh machine is exactly the one that has never
  // signed in, and it must read that before provision, not after.
  const prereqs = prerequisiteReport(envMap);
  for (const line of prerequisiteLines(prereqs.rows)) say(line);
  for (const row of prereqs.rows) report.recordRow(row);
  let ok = prereqs.ok;
  if (prereqs.claude) report.setClaude(prereqs.claude);
  if (envMap.size === 0) {
    const line = `✗ ${ENV_FILE} missing — run \`engager init\``;
    say(line);
    if (!report.record("env-file", "fail", line)) ok = false;
  } else {
    report.record("env-file", "ok");
    for (const key of [
      "ENGAGER_DEPLOYMENT_ENV",
      "DATABASE_URL",
      "ENGAGER_MIGRATE_DATABASE_URL",
      "ENGAGER_MASTER_KEY",
      "ENGAGER_DRIVER",
      "ENGAGER_ORG_ID",
    ]) {
      const present = Boolean(envMap.get(key));
      const line = `${present ? "✓" : "✗"} ${key} set`;
      say(line);
      if (!report.record(`env:${key}`, present ? "ok" : "fail", line)) ok = false;
    }
    const backend = envMap.get("ENGAGER_LLM_BACKEND") ?? "agent-cli";
    if (backend === "api") {
      const keyed = Boolean(envMap.get("ANTHROPIC_API_KEY"));
      const line = `${keyed ? "✓" : "✗"} ENGAGER_LLM_BACKEND=api — ANTHROPIC_API_KEY ${keyed ? "set" : "MISSING (every model call will fail)"}`;
      say(line);
      if (!report.record("llm-backend", keyed ? "ok" : "fail", line)) ok = false;
    } else {
      // Conditional on the probe the prereq row already ran. An unconditional
      // ✓ here said "your agent CLI serves every model call" in the same
      // breath as a ✗ saying that binary is not on the machine. `ok` is not
      // touched — the prereq row owns that verdict.
      // The sign-in state is the `prereq:agent-signin` row above; this row
      // says only which backend serves the calls.
      const agent = agentCliPrereq(envMap);
      const line = agent.present
        ? `✓ model calls run on your own agent CLI (${agent.agent}) — no provider API key needed`
        : `✗ model calls run on your own agent CLI (${agent.agent}), but \`${agent.bin}\` is not on PATH — every model call will fail`;
      say(line);
      report.record("llm-backend", agent.present ? "ok" : "warn", line);
    }
  }
  // The env var write authority retired: the runtime reads the channel row's
  // `writes_enabled` (the dashboard's write switch) and never consults
  // this key. A leftover export is misdirection — the owner believes writes
  // are on while the gate answers off — so say so. "warn", never "fail": a
  // stale line in a text file does not make the install unhealthy.
  if (envMap.get("ENGAGER_BROWSER_WRITES")) {
    const line =
      "✗ ENGAGER_BROWSER_WRITES is set but no longer consulted — write authority is the Channel page's switch; remove the stale line";
    say(line);
    report.record("env:ENGAGER_BROWSER_WRITES", "warn", line);
  }
  // The agent, database and browser run on this machine.
  const modeLine = deploymentModeLine();
  say(modeLine);
  report.record("deployment-mode", "info", modeLine);
  // The sidecar hides its Chrome via System Events, which needs the one-time
  // macOS worker permission; denied, the hide fails SILENTLY and the
  // browser window sits on the owner's screen. Probe with the same no-op
  // Apple event the hide path uses. "warn", never "fail": a visible window
  // is an annoyance, not an unhealthy install — the CDP off-screen fallback
  // covers most of it. The `osascript` spawn and
  // row together: this machine opens no browser, so there is nothing
  // truthful to say about hiding one.
  if (process.platform === "darwin") {
    const probe = spawnSync(
      "osascript",
      ["-e", 'tell application "System Events" to count processes'],
      { encoding: "utf8", timeout: 10_000 },
    );
    const granted = probe.status === 0;
    const line = granted
      ? "✓ macOS Automation permission granted — the browser window hides"
      : "✗ macOS Automation (System Events) denied — the browser window may stay visible; allow Engager under System Settings → Privacy & Security → Automation";
    say(line);
    report.record("browser-hide", granted ? "ok" : "warn", line);
  }
  // The Brain vault is FILES, deliberately outside the database (INV-14) and
  // therefore outside everything a dropped database takes with it. Say where
  // it is and how much is in it: a fresh organization reading a vault the last
  // one filled otherwise reports its Brain step already satisfied, with no row
  // in the database to explain it.
  report.record("brain-vault", "info", reportBrainVault(envMap, say));
  // Display only (INV-17): what this machine's cached license says, decoded
  // but not verified -- see licenseStatus.mjs's module doc for why doctor
  // does not check the signature. Never a ✗/✓: an absent license on a
  // checkout is healthy, and the gate flag lives in the packaged dist/*.mjs
  // bundles, not here, so doctor cannot know whether THIS build is gated.
  const licenseLine = licenseStatusLine(new Date());
  say(licenseLine);
  report.record("license", "info", licenseLine);
  // Display only, the same reason as the license line above: what this
  // machine's cached authority lease says, read without touching the
  // database or the network. Never a ✗/✓ -- an absent lease on a checkout
  // is healthy, and doctor cannot know whether THIS build is gated.
  const authorityLine = authorityStatusLine(new Date());
  say(authorityLine);
  report.record("authority", "info", authorityLine);
  const skillsInstalled = existsSync(
    path.join(os.homedir(), ".claude", "skills", "engager-setup"),
  );
  const skillsLine = `${skillsInstalled ? "✓" : "✗"} skills installed (~/.claude/skills)`;
  say(skillsLine);
  if (!report.record("skills", skillsInstalled ? "ok" : "fail", skillsLine)) ok = false;
  // Bundle installs only: elsewhere the registrations name node and
  // engager.mjs directly and there is no shim to check. Before the MCP row
  // because it is that row's explanation — `claude mcp list` says "Failed
  // to connect" on a shim that is gone, and this row says which path is.
  if (IN_APP_BUNDLE) {
    const status = shimStatus(SHIM_PATH);
    const line = shimStatusLine(status, SHIM_PATH);
    say(line);
    if (!report.record("shim", status.state === "ok" ? "ok" : "fail", line)) ok = false;
  }
  const mcpList = spawnSync("claude", ["mcp", "list"], { encoding: "utf8" });
  if (mcpList.status === 0) {
    // `claude mcp list` health-checks every server: "name: cmd - ✔ Connected"
    // or "… - ✘ Failed to connect — <reason>". A registration that EXISTS but
    // cannot start is the exact failure a bare-command entry produces, so
    // matching the name alone would report a green doctor on a dead server.
    const mcpEntry = (mcpList.stdout ?? "")
      .split("\n")
      .find((entry) => entry.includes("engager-local"));
    const healthy = Boolean(mcpEntry) && !/✘|Failed to connect/.test(mcpEntry ?? "");
    const mcpLines = [`${healthy ? "✓" : "✗"} MCP server registered with Claude Code (engager-local)`];
    say(mcpLines[0]);
    if (!healthy) {
      const detailLine = mcpEntry
        ? `  ${mcpEntry.trim()}\n  → re-run \`engager init\` to rewrite the registration with this install's absolute path.`
        : "  → not registered; run `engager init`.";
      say(detailLine);
      mcpLines.push(detailLine);
    }
    if (!report.record("mcp-registration", healthy ? "ok" : "fail", mcpLines.join("\n"))) ok = false;
  } else {
    const line = "→ claude CLI unavailable — skipping MCP registration check";
    say(line);
    report.record("mcp-registration", "info", line);
  }
  if (ok) {
    say("→ probing the stack (get_status round-trip)…");
    const probe = spawnSync(
      process.execPath,
      [path.join(BIN_DIR, "engager.mjs"), "call", "get_status", "{}"],
      { encoding: "utf8" },
    );
    const probeOk = probe.status === 0;
    const roundTripLine = `${probeOk ? "✓" : "✗"} database + org + MCP server round-trip`;
    say(roundTripLine);
    if (!report.record("round-trip", probeOk ? "ok" : "fail", roundTripLine)) ok = false;
    if (!probeOk) {
      console.error(
        (probe.stderr || probe.stdout || "")
          .trim()
          .split("\n")
          .slice(-5)
          .join("\n"),
      );
    } else {
      const backgroundInferenceLines = [];
      const backgroundInferenceStatus = reportBackgroundInference(
        probe.stdout,
        (line) => {
          backgroundInferenceLines.push(line);
          say(line);
        },
        { independent: false },
      );
      if (
        !report.record(
          "background-inference",
          backgroundInferenceStatus,
          backgroundInferenceLines.join("\n"),
        )
      ) {
        ok = false;
      }
    }
  } else {
    const line = "→ skipping the live round-trip until the ✗ items are fixed";
    say(line);
    report.record("round-trip", "info", line);
  }
  say(ok ? "\ndoctor: all good" : "\ndoctor: problems found — `engager init` repairs most of them");
  const finished = report.finish(ok);
  if (json) console.log(renderDoctorJson(finished));
  process.exit(doctorExitCode(finished));
}

/** Bring up what is installed, then report the machine -- what the app runs
 *  at every launch and what the first-run window polls. Not doctor plus a
 *  flag: doctor is read-only by contract, and this starts things. Postgres
 *  first (`bringUpPostgres`: a bundled cluster is initialised on its first
 *  run, a stopped one started), then the migration whenever an env file
 *  already names a database (the relaunch-after-update gap -- no other arm
 *  migrates at launch, so two processes never race the migrator), then the
 *  same `prereq:*` rows doctor records, with a start that already failed
 *  written onto the server row instead of an `auto` fix that would spin. No
 *  skills / MCP / round-trip rows: those spawn `claude mcp list` and a live
 *  MCP call, seconds each, and this command is polled. */
function macMaintenance(operation, input) {
  const [executable, args] = entry("core-command");
  const result = spawnSync(executable, [...args, "maintenance", operation], {
    cwd: childCwd(), env: baseEnv(), input: JSON.stringify(input), encoding: "utf8",
    timeout: 15000, maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) throw new Error("maintenance_unavailable");
  return JSON.parse(result.stdout);
}
function macSchemaHash() {
  return migrationFingerprint(macMigrations());
}
function macMigrations() { return CHECKOUT ? path.join(CHECKOUT_ROOT, "packages/database/migrations") : path.join(PKG, "dist/migrations"); }
function macBundle() {
  if (!IN_APP_BUNDLE) throw new Error("mac_bundle_required");
  return path.resolve(PKG, "../../..");
}
/** The `SUPublicEDKey` this bundle's Sparkle verifies every DMG with -- the
 *  one key a signed schema path is checked against. None means no path holds. */
function macReleaseKey() {
  const result = spawnSync("/usr/bin/plutil", ["-extract", "SUPublicEDKey", "raw", "-o", "-",
    path.join(macBundle(), "Contents/Info.plist")], { encoding: "utf8", timeout: 5000 });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}
async function prepareMac(targetVersion, targetSchemaHash, schemaPaths) {
  return prepareMacUpdate({ root: HOME_DIR, env: baseEnv(), version: packageVersion(), schemaHash: macSchemaHash(),
    targetVersion, targetSchemaHash, bundle: macBundle(), maintenance: macMaintenance,
    schemaPath: macSchemaPath({ directory: macMigrations(), schemaPaths, trustedPublicKey: schemaPaths ? macReleaseKey() : null }) });
}
/** `scripts/dev/app.mjs install` runs this from the incoming Dev bundle, over
 *  the installed one, before it swaps them (`prepareDevelopmentMacUpdate`). */
async function prepareDevelopmentMac(installed) {
  return prepareDevelopmentMacUpdate({ development: developmentActivated(), root: HOME_DIR, env: baseEnv(),
    version: packageVersion(), schemaHash: macSchemaHash(), bundle: installed, maintenance: macMaintenance,
    schemaPath: macSchemaPath({ directory: macMigrations(), schemaPaths: null, trustedPublicKey: null }),
    ready: () => {
      requireMacRecoveryStopped([macBundle(), installed]);
      if (!bringUpPostgres(readEnvFile(ENV_FILE), { quiet: true }).ok) throw new Error("mac_local_database_required");
    },
    // The database must hold exactly the installed build's history, and the
    // incoming build's must extend it: the same check its launch repeats.
    verifyHistory: async (migrations) => {
      const at = await verifyMacMigrationHistory({ directory: migrations, env: baseEnv(), maintenance: macMaintenance });
      if (at.pending) throw new Error("development_update_history_behind_installed");
      await verifyMacMigrationHistory({ directory: macMigrations(), env: baseEnv(), maintenance: macMaintenance });
    } });
}
async function finishMac({ recover = false, quiet = true } = {}) {
  return withLifecycleLock(HOME_DIR, async () => {
    // The history check runs on EVERY launch; it is what catches a database
    // restored behind the app's back. It also reports whether the packaged
    // migrator has anything to apply, which decides whether this launch needs
    // a fresh full snapshot before it is allowed to touch the schema.
    const history = await verifyMacMigrationHistory({ directory: macMigrations(), env: baseEnv(), maintenance: macMaintenance });
    return finishMacUpdate({ root: HOME_DIR, version: packageVersion(), schemaHash: macSchemaHash(),
      env: baseEnv(), recover, migrate: () => migrateSync({ quiet }), maintenance: macMaintenance,
      pendingMigrations: history?.pending });
  });
}
function requireMacRecoveryStopped(bundles = [macBundle()]) {
  // Recovery is an offline, owner-invoked operation. Refuse both an open Mac
  // app and identifiable packaged writers left behind by an interrupted app.
  const listing = spawnSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8", timeout: 5000, env: { ...process.env, LC_ALL: "C" } });
  if (listing.status !== 0 || lifecycleStatus(HOME_DIR).state !== "stopped") throw new Error("mac_recovery_requires_quit");
  const writer = /(?:\/Contents\/MacOS\/EngagerMenubar(?:\s|$)|\/Contents\/Resources\/cli\/(?:dist\/(?:agent|mcp|scheduler|worker|dashboard)|bin\/engager\.mjs\s+(?:agent|dashboard|dev|mcp)))/;
  if (listing.stdout.split("\n").some((line) =>
    (process.env.ENGAGER_DEV_APP !== "1" || bundles.some((bundle) => line.includes(bundle + "/Contents/"))) &&
    writer.test(line.trim().replace(/^\d+\s+/, "")))) throw new Error("mac_recovery_requires_quit");
}
/** A leftover cloud-client `.env` must not start a local runtime and migrate a
 *  tenant database: the Mac is the only placement. */
function refuseCloudEnvironment() {
  if (baseEnv().ENGAGER_DEPLOYMENT_ENV !== "cloud") return;
  console.error("ENGAGER_DEPLOYMENT_ENV=cloud: this install runs only on this Mac. Remove it from the environment or the env file, then run again.");
  process.exit(1);
}
async function preflight({ json }) {
  refuseCloudEnvironment();
  const report = doctorReport(CHECKOUT ? "checkout" : "packaged");
  const say = (line) => { if (!json) console.log(line); };
  say(`engager preflight (${CHECKOUT ? "checkout" : "packaged"} mode)\n`);
  const envMap = readEnvFile(ENV_FILE);
  const postgres = bringUpPostgres(envMap, { quiet: json });
  let ok = true;
  let migration = null;
  if (envMap.size > 0 && postgres.ok) {
    say("→ migrating the local database…");
    let result;
    try {
      if (IN_APP_BUNDLE) {
        // Also cover the first launch from a legacy app with no update ticket.
        // Backup failure must stop migration, including outside Sparkle.
        if (!macUpdateTicket(HOME_DIR)) await prepareMac(packageVersion(), macSchemaHash());
        result = await finishMac({ quiet: json });
      } else result = migrateSync({ quiet: json });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "";
      result = { ok: false, output: /^snapshot_/.test(detail)
        ? `${detail}\nEngager did not start a migration. Clear that cause before running mac-update recover: recovery takes the same snapshot and fails the same way.`
        : "update_recovery_required: quit Engager and run mac-update recover with the prepared candidate" };
    }
    migration = {
      name: "database-migration",
      status: result.ok ? "ok" : "fail",
      title: "Database schema",
      detail: result.ok ? undefined : result.output.trim().split("\n").slice(-5).join("\n"),
    };
    say(result.ok ? "✓ database schema current" : `✗ database migration failed\n  ${migration.detail}`);
  }
  const prereqs = prerequisiteReport(envMap, { postgresStartFailure: postgres.failure });
  for (const line of prerequisiteLines(prereqs.rows)) say(line);
  for (const row of prereqs.rows) report.recordRow(row);
  if (!prereqs.ok) ok = false;
  if (migration && !report.recordRow(migration)) ok = false;
  if (prereqs.claude) report.setClaude(prereqs.claude);
  say(ok ? "\npreflight: ready" : "\npreflight: fix the ✗ rows above");
  const finished = report.finish(ok);
  if (json) console.log(renderDoctorJson(finished));
  process.exit(doctorExitCode(finished));
}

/** One-shot JSON-RPC round trip to the stdio MCP server: spawn, initialize,
 *  call, print, EXIT — no idle timers, and no truncation: a tool's text result
 *  is the largest thing this binary prints, and `call … | jq` is how the
 *  Skills read it, so every exit here drains the streams first. */
async function call(tool, jsonArgs) {
  let args;
  try {
    args = jsonArgs ? JSON.parse(jsonArgs) : {};
  } catch (e) {
    console.error(`engager call: arguments are not valid JSON: ${e.message}`);
    await exitFlushed(2);
  }
  const [serverCommand, serverArgs] = entry("mcp");
  const child = spawn(serverCommand, serverArgs, {
    cwd: childCwd(),
    env: baseEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderrTail = [];
  child.stderr.on("data", (c) => {
    stderrTail.push(String(c));
    if (stderrTail.length > 20) stderrTail.shift();
  });
  let buffer = "";
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && pending.has(msg.id)) pending.get(msg.id)(msg);
      } catch {
        // Non-protocol stdout noise is ignored by design.
      }
    }
  });
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
  const request = (id, method, params) =>
    new Promise((resolve) => {
      pending.set(id, resolve);
      send({ jsonrpc: "2.0", id, method, params });
    });
  const timer = setTimeout(async () => {
    console.error("engager call: timed out after 180s");
    console.error(stderrTail.join(""));
    child.kill("SIGKILL");
    await exitFlushed(1);
  }, 180_000);

  await request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "engager-cli", version: packageVersion() },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const response = await request(2, "tools/call", { name: tool, arguments: args });
  clearTimeout(timer);
  child.kill("SIGTERM");
  if (response.error) {
    console.error(JSON.stringify(response.error, null, 2));
    await exitFlushed(1);
  }
  const content = response.result?.content ?? [];
  for (const part of content) {
    if (part.type === "text") console.log(part.text);
  }
  await exitFlushed(response.result?.isError ? 1 : 0);
}

/** `process.exit` discards whatever the standard streams still hold, and on a
 *  PIPE they hold plenty — a large `agent discover --json` reached its reader
 *  truncated mid-object. Wait for the drain first; an `EPIPE` from a reader
 *  that already left is not a reason to stay. */
async function exitFlushed(code) {
  await Promise.all([process.stdout, process.stderr].map((stream) => new Promise((resolve) => stream.write("", resolve))));
  process.exit(code);
}

if (["install", "update", "migrate"].includes(process.argv[2])) {
  try {
    await runInstaller({ argv: process.argv.slice(2), root: HOME_DIR, pkg: PKG, env: baseEnv() });
    await exitFlushed(process.exitCode ?? 0);
  } catch (error) {
    console.error(installerFailure(error));
    await exitFlushed(1);
  }
}
const command = process.argv[2];
switch (command) {
  case "dev-open-url":
    openDevelopmentBrowser(process.argv[3]);
    break;
  case "dev-open-agent-auth-url":
    openDevelopmentAgentBrowser(process.argv[3]);
    break;
  case "dev-codex-login": {
    if (process.env.ENGAGER_DEV_APP !== "1") throw new Error("development_app_required");
    openDevelopmentAgentBrowser("https://auth.openai.com/codex/device");
    const result = spawnSync("codex", ["-c", 'cli_auth_credentials_store="file"', "login", "--device-auth"],
      { env: process.env, stdio: "inherit" });
    await exitFlushed(result.status ?? 1);
    break;
  }
  case "dev-database-stop": {
    if (process.env.ENGAGER_DEV_APP !== "1") throw new Error("development_app_required");
    // The artifact bootstrap has just checked every state path and proved
    // ownership of any listener. Never stop from a cached native path alone.
    if (!verifyDevelopmentDatabase(process.env)) await exitFlushed(0);
    const args = pgCtlStopArgs(process.env);
    if (!args) throw new Error("development_database_required");
    const result = spawnSync(resolveBin("pg_ctl", process.env), args, { env: process.env, encoding: "utf8" });
    await exitFlushed(result.status ?? 1);
    break;
  }
  case "up":
    refuseCloudEnvironment();
    if (!ensureBundledPostgresRunning()) process.exit(1);
    runEntry("agent");
    break;
  case "agent": {
    // `runEntry` forwards no argv, so reject a subcommand instead of silently
    // starting the scheduler.
    const verb = process.argv[3];
    if (verb) {
      console.error(
        `engager agent takes no subcommand here (got \`${verb}\`). Choose the background agent on Settings › Agent in the dashboard.`,
      );
      process.exit(2);
    }
    // The serving arms bring their own database up -- a bundled cluster
    // stopped since the last reboot is otherwise a scheduler that fails
    // every tick until someone re-runs init by hand.
    if (!ensureBundledPostgresRunning()) process.exit(1);
    runEntry(command);
    break;
  }
  case "worker":
  case "scheduler":
  case "mcp":
    runEntry(command);
    break;
  case "dashboard":
    console.error("The dashboard is available in the Engager Mac app at https://getengager.com.");
    process.exit(1);
  case "call": {
    const tool = process.argv[3];
    if (!tool) {
      console.error("usage: engager call <tool> ['<json-args>']");
      process.exit(2);
    }
    await call(tool, process.argv[4]);
    break;
  }
  case "export":
  case "restore": {
    const args = process.argv.slice(3);
    const value = (flag) => {
      const index = args.indexOf(flag);
      return index >= 0 && index === args.lastIndexOf(flag) && args[index + 1] && !args[index + 1].startsWith("--")
        ? args[index + 1] : null;
    };
    const file = command === "export" ? value("--output") : args[0];
    const passphrase = value("--passphrase-file");
    if (!file || file.startsWith("--") || !passphrase || (command === "export" && !args.includes("--portable"))) {
      console.error("usage: engager export --portable --output <file> --passphrase-file <file> | engager restore <file> --passphrase-file <file>");
      process.exit(2);
    }
    if (lifecycleStatus(HOME_DIR).state !== "stopped") {
      console.error(command === "export" ? "snapshot_requires_stopped_core" : "restore_requires_stopped_core");
      process.exit(1);
    }
    // A payload install proves the cluster answering is its own before a
    // data-replacing restore (or an export) touches it; other shapes bring
    // their bundled cluster up as before.
    if (existsSync(path.join(HOME_DIR, "installation.json"))) {
      try {
        ensureOwnDatabase(HOME_DIR, installerEnvironment(HOME_DIR, PKG, baseEnv()), false);
      } catch (error) {
        console.error(error instanceof Error ? error.message : "database_unavailable");
        process.exit(1);
      }
    } else if (!ensureBundledPostgresRunning()) process.exit(1);
    process.exit(await runEntryToCompletion("core-command", [command === "export" ? "export-portable" : "restore-portable", path.resolve(file), path.resolve(passphrase)]));
  }
  case "setup":
    await setup({
      assumeYes: process.argv.includes("--yes") || process.argv.includes("-y"),
      nonInteractive: process.argv.includes("--non-interactive"),
    });
    break;
  case "init":
    await init({
      assumeYes: process.argv.includes("--yes") || process.argv.includes("-y"),
      nonInteractive: process.argv.includes("--non-interactive"),
    });
    break;
  case "login": {
    const code = await licenseLogin({
      baseUrl: loopbackBaseUrl(DASHBOARD_PORT),
      sleep: (ms) => delay(ms),
    });
    process.exit(code);
    break;
  }
  case "logout":
    // The ONE deletion of a cached license this phase allows (INV-16), and
    // it is an explicit owner act -- never call this from a refresh-failure
    // path. `licenseLogout` (packages/cli/bin/lib/licenseLogin.mjs) is the
    // whole implementation; this arm only supplies HOME_DIR.
    await licenseLogout({ homeDir: HOME_DIR });
    break;
  case "uninstall":
    uninstall({ purge: process.argv.includes("--purge") });
    break;
  case "doctor":
    doctor({ json: process.argv.includes("--json") });
    break;
  case "mac-update": {
    const operation = process.argv[3];
    try {
      macBundle();
      let result;
      if (operation === "prepare") result = await prepareMac(process.argv[4], process.argv[5], process.argv[6]);
      else if (operation === "prepare-development") result = await prepareDevelopmentMac(process.argv[4]);
      else if (operation === "cancel") result = await cancelMacUpdate({ root: HOME_DIR, version: packageVersion(), schemaHash: macSchemaHash(), maintenance: macMaintenance });
      else if (operation === "recover") {
        requireMacRecoveryStopped();
        recoverLifecycleLock(HOME_DIR);
        const settings = readEnvFile(ENV_FILE);
        if (!bringUpPostgres(settings, { quiet: true }).ok) throw new Error("mac_local_database_required");
        result = await finishMac({ recover: true });
        if (!result.ok) throw new Error(result.output || "update_recovery_required");
      } else throw new Error("maintenance_operation_unknown");
      console.log(JSON.stringify(result));
    } catch (error) {
      // A failure whose cause recovery itself cannot clear must say so: telling
      // an owner to rerun the command that just failed for that reason is an
      // endless loop, not a next step.
      const detail = error instanceof Error ? error.message : "";
      console.error(operation === "prepare-development" || /^(snapshot_|update_requires_)/.test(detail)
        ? detail
        : "update_recovery_required: quit Engager and run mac-update recover using the exact prepared candidate; retained data and snapshots must not be deleted");
      await exitFlushed(1);
    }
    break;
  }
  case "supervision": {
    const [executable, args] = entry("core-command");
    const result = spawnSync(executable, [...args, "supervision", ...process.argv.slice(3)], {
      cwd: childCwd(), env: baseEnv(), encoding: "utf8", timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    if (result.status === 0) console.log(result.stdout.trim());
    else console.error("supervision_unavailable");
    await exitFlushed(result.status === 0 ? 0 : 1);
    break;
  }
  case "agent-setup": {
    // The Agent step's verbs (US-ONE-01/US-ONE-02/US-ONE-04): the scan,
    // the installer run, the sign-in probe and the login itself are
    // core's, over the same core-command child supervision uses, and this
    // arm only forwards them — Swift decodes the JSON and decides nothing
    // from the filesystem itself (INV-20). The scan and probe are bounded
    // in core; the timeout here is the ceiling on the child, not a second
    // bound on them. Async spawn, not spawnSync: the window's Cancel
    // terminates THIS process, and a blocked event loop could never
    // forward that signal — the core-command child (and its probes, or the
    // installer's process group) would outlive the cancel.
    // `install` differs from the reads only in plumbing: its NDJSON events
    // stream straight to stdout instead of buffering (the window renders
    // phases as they land), and its ceiling is the installer's own
    // ten-minute bound plus the version check, not the scan's minute. A
    // `login` waits on the OWNER in their browser, so its ceiling is
    // minutes too — killing it at a minute would close a sign-in the
    // owner was still finishing.
    const streaming = process.argv[3] === "install";
    const [executable, args] = entry("core-command");
    const result = await new Promise((resolve) => {
      const child = spawn(executable, [...args, "agent-setup", ...process.argv.slice(3)], {
        cwd: childCwd(), env: baseEnv(),
      });
      let stdout = "";
      let overflow = false;
      const ceilingMs = streaming
        ? 660_000
        : process.argv[3] === "login"
          ? 15 * 60_000
          : process.argv[3] === "connect"
            // The scan, catalog read and the one bounded test request:
            // the scan's minute could kill an answer seconds away.
            ? 5 * 60_000
            : 60_000;
      const timer = setTimeout(() => child.kill("SIGKILL"), ceilingMs);
      const forward = (signal) => () => child.kill(signal);
      const onTerm = forward("SIGTERM"), onInt = forward("SIGINT");
      process.once("SIGTERM", onTerm);
      process.once("SIGINT", onInt);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        if (streaming) { process.stdout.write(chunk); return; }
        stdout += chunk;
        if (stdout.length > 1024 * 1024 && !overflow) { overflow = true; child.kill("SIGKILL"); }
      });
      child.on("error", () => resolve({ status: 1, stdout: "" }));
      child.on("close", (status) => {
        clearTimeout(timer);
        process.off("SIGTERM", onTerm);
        process.off("SIGINT", onInt);
        resolve({ status: overflow ? 1 : status, stdout });
      });
    });
    if (!streaming) {
      if (result.status === 0) console.log(result.stdout.trim());
      else console.error("agent_setup_unavailable");
    } else if (result.status !== 0) console.error("agent_setup_unavailable");
    await exitFlushed(result.status === 0 ? 0 : 1);
    break;
  }
  case "mac-setup": {
    // The first-run window's one setup surface (US-OND-01): Swift decodes
    // `status --json` and runs `run database` for the Database row, and
    // decides nothing from the filesystem itself (INV-20). `run database`
    // is today's preflight bring-up + init behind one idempotent step:
    // status already done answers at once, so a finished migration or org
    // bootstrap never restarts; anything less re-enters init, which is
    // safe to run again over a half-finished install.
    const json = process.argv.includes("--json");
    const emitStatus = () => {
      const status = macSetupStatus({ homeDir: HOME_DIR, envFile: ENV_FILE });
      if (json) console.log(JSON.stringify(status));
      else for (const line of macSetupStatusLines(status)) console.log(line);
      return status;
    };
    if (process.argv[3] === "status") {
      emitStatus();
    } else if (process.argv[3] === "mark") {
      // The window says which stage of setup it reached, for usage data.
      // Nothing waits on the answer and no failure here is setup's: a Mac
      // that was set up before this launch is told apart by its database.
      const priorUse = macSetupStatus({ homeDir: HOME_DIR, envFile: ENV_FILE }).database.done;
      const [executable, args] = entry("core-command");
      spawnSync(executable, [...args, "setup-stage", process.argv[4] ?? "", ...(priorUse ? ["--prior-use"] : [])], {
        cwd: childCwd(), env: baseEnv(), stdio: "ignore", timeout: 15000,
      });
    } else if (process.argv[3] === "run" && process.argv[4] === "database") {
      const before = macSetupStatus({ homeDir: HOME_DIR, envFile: ENV_FILE });
      // The window never reaches this with a question still open; a stray
      // caller does not get to `init` over an old install, a cluster of
      // another major, or a port somebody else holds.
      if (before.environment.blocking) {
        console.error(`✗ Setup is waiting on this Mac (${before.environment.blocking}) — resolve it in the Set up Engager window first.`);
        process.exit(1);
      }
      if (!before.database.done) {
        await init({
          assumeYes: process.argv.includes("--yes") || process.argv.includes("-y"),
          nonInteractive: process.argv.includes("--non-interactive"),
        });
      } else if (!json) {
        console.log("✓ Database ready — already set up, nothing to run.");
      }
      if (!emitStatus().database.done) process.exit(1);
      // What is in this directory is now this setup's own: quitting here and
      // reopening must not read the org it made as an old install's.
      if (!existsSync(path.join(HOME_DIR, "mac-setup.json"))) writeSetupMarker(HOME_DIR, "setup");
    } else if (process.argv[3] === "run" && process.argv[4] === "browser") {
      // The LinkedIn browser row (US-OND-07 then US-OND-04): phase one
      // builds the browser tools (an indeterminate progress event, no
      // byte count), then one pinned download with Range resume. --json
      // streams NDJSON progress events (the window's bar reads them);
      // the terminal failed event carries the reason code and its words,
      // never a raw error. Already installed answers at once, like
      // run database.
      try {
        await runMacBrowserSetup({
          homeDir: HOME_DIR,
          pkg: PKG,
          env: process.env,
          onEvent: (event) => {
            if (json) console.log(JSON.stringify(event));
            else if (event.type === "progress" && event.phase === "tools") {
              console.log("Installing browser tools…");
            } else if (event.type === "progress") {
              console.log(
                `Downloading Chromium · ${event.downloadedMB} of ${event.totalMB} MB` +
                  (event.etaMinutes ? ` · about ${event.etaMinutes} min left` : ""),
              );
            } else if (event.type === "done") {
              console.log(event.alreadyInstalled ? "✓ LinkedIn browser ready — already downloaded." : "✓ LinkedIn browser ready");
            }
          },
        });
      } catch (error) {
        if (error instanceof BrowserToolsError) {
          if (!json) console.error(`✗ Installing the browser tools stopped: ${error.words}.`);
          process.exit(1);
        }
        if (error instanceof BrowserInstallError) {
          if (!json) {
            console.error(
              `✗ The download stopped at ${Math.round(error.keptBytes / 1_000_000)} of ${Math.round(error.totalBytes / 1_000_000)} MB: ${error.message}.`,
            );
          }
          process.exit(1);
        }
        throw error;
      }
      if (!macSetupStatus({ homeDir: HOME_DIR, envFile: ENV_FILE }).browser.done) process.exit(1);
    } else if (process.argv[3] === "run" && process.argv[4] === "browser-check") {
      // The Browser check row (US-OND-05): the pinned browser started,
      // a test cookie kept across a restart, closed (US-OND-09). --json
      // streams NDJSON events (a progress event when the start begins, then
      // one done or failed with a reason code and its words); already
      // checked for this browser answers at once.
      try {
        await runBrowserCheck({
          homeDir: HOME_DIR,
          pkg: PKG,
          env: process.env,
          onEvent: (event) => {
            if (json) console.log(JSON.stringify(event));
            else if (event.type === "progress") console.log("Starting the browser to check it starts and keeps a sign-in…");
            else if (event.type === "done") {
              console.log(event.alreadyChecked ? "✓ Browser check passed — already checked." : "✓ Browser starts and keeps a sign-in");
            }
          },
        });
      } catch (error) {
        if (error instanceof BrowserCheckError) {
          if (!json) console.error(`✗ The browser check stopped: ${error.words}.`);
          process.exit(1);
        }
        throw error;
      }
    } else if (process.argv[3] === "run" && process.argv[4] === "space") {
      // The Space row's measurement (US-OND-02): one object, the free
      // figures beside the measured size of exactly what clear-caches
      // would remove. Measuring walks every preserved app copy, so the
      // window asks once per low-space stop, not on its 5 s re-check.
      const clearable = measureClearable({ homeDir: HOME_DIR });
      const { space } = macSetupStatus({ homeDir: HOME_DIR, envFile: ENV_FILE });
      if (json) console.log(JSON.stringify({ type: "space", space, clearable }));
      else {
        console.log(`${space.enough ? "✓" : "✗"} ${space.freeGB} GB free · needs ${space.requiredGB} GB`);
        console.log(clearable.count === 0 ? "Nothing of Engager's to clear" : `${clearable.gb} GB of Engager's own files can be cleared`);
      }
    } else if (process.argv[3] === "keep-data") {
      keepData({ homeDir: HOME_DIR });
      if (json) console.log(JSON.stringify({ type: "done", kept: true }));
      else console.log("✓ Keeping what is in ~/.engager, untouched.");
    } else if (process.argv[3] === "run" && process.argv[4] === "start-fresh") {
      const fresh = startFresh({ homeDir: HOME_DIR, env: process.env });
      if (json) console.log(JSON.stringify({ type: fresh.moved ? "done" : "failed", ...fresh }));
      else if (fresh.moved) console.log(`✓ Your old data is kept at ${fresh.backup}.`);
      else console.error(`✗ Could not start fresh (${fresh.reason}); nothing was changed.`);
      if (!fresh.moved) process.exit(1);
    } else if (process.argv[3] === "run" && process.argv[4] === "stop-port") {
      const stopped = stopPortHolder({ env: process.env });
      if (json) console.log(JSON.stringify({ type: stopped.stopped ? "done" : "failed", ...stopped }));
      else if (stopped.stopped) console.log("✓ The other database is stopped.");
      else console.error(`✗ Could not stop it (${stopped.reason}).`);
      if (!stopped.stopped) process.exit(1);
    } else if (process.argv[3] === "clear-caches") {
      const cleared = clearCaches({ homeDir: HOME_DIR, env: process.env });
      if (json) console.log(JSON.stringify({ type: "done", ...cleared }));
      else console.log(`✓ Cleared ${cleared.removed} item${cleared.removed === 1 ? "" : "s"}`);
    } else {
      console.error("usage: engager mac-setup status [--json] | engager mac-setup run database|browser|browser-check|space|start-fresh|stop-port [--json] | engager mac-setup keep-data|clear-caches [--json]");
      process.exit(2);
    }
    break;
  }
  case "preflight":
    await preflight({ json: process.argv.includes("--json") });
    break;
  case "--version":
  case "-v":
  case "version":
    console.log(packageVersion());
    break;
  case undefined:
  case "--help":
  case "-h":
  case "help":
    console.log(HELP);
    break;
  default:
    console.error(`engager: unknown command "${command}"\n`);
    console.log(HELP);
    process.exit(1);
}
