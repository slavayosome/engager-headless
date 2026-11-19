import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import { spawnSync } from "node:child_process";
import { classifyPostgresHolder } from "./macEnvironment.mjs";

export function developmentEnvironment(profile, ownerHome, resources, inherited = {}) {
  if (profile.version !== 1 || profile.bundleIdentifier !== "com.engager.menubar.dev" ||
      profile.rootName !== ".engager-dev" || profile.urlScheme !== "engager-dev" ||
      profile.cloudOrigin !== "https://engager-cloud-dev.vercel.app") throw new Error("invalid_development_profile");
  const env = Object.fromEntries(Object.entries(profile.environment).map(([key, value]) =>
    [key, value.replaceAll("{root}", path.join(ownerHome, profile.rootName)).replaceAll("{resources}", resources)]));
  // Only per-launch loopback authentication crosses the boundary. Paths,
  // database authority and persisted settings come from the artifact/Dev file.
  for (const key of ["ENGAGER_BRIDGE_TOKEN", "ENGAGER_MCP_TOKEN"]) {
    if (inherited[key]) env[key] = inherited[key];
  }
  return env;
}

export function prepareDevelopmentDirectory(directory, ownerHome) {
  const root = path.join(ownerHome, ".engager-dev");
  if (directory !== root && !directory.startsWith(root + path.sep)) throw new Error("development_path_escape");
  let current = ownerHome;
  for (const part of path.relative(ownerHome, directory).split(path.sep)) {
    current = path.join(current, part);
    try {
      if (!lstatSync(current).isDirectory()) throw new Error("development_path_not_directory");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      mkdirSync(current, { mode: 0o700 });
    }
  }
}

export function validateDevelopmentPaths(profile, env, ownerHome) {
  prepareDevelopmentDirectory(env.ENGAGER_HOME, ownerHome);
  prepareDevelopmentDirectory(env.TMPDIR, ownerHome);
  for (const key of profile.privateDirectories) prepareDevelopmentDirectory(env[key], ownerHome);
  for (const template of profile.privateFiles) {
    const file = template.replaceAll("{root}", path.join(ownerHome, profile.rootName));
    try { if (!lstatSync(file).isFile()) throw new Error("development_file_is_link_or_directory"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

let activated = false;
/** True only in a process the Dev artifact's own bootstrap isolated: an
 *  inherited `ENGAGER_DEV_APP` never sets it, so a production binary cannot. */
export const developmentActivated = () => activated;

export function activateDevelopmentEnvironment(resources) {
  const profile = JSON.parse(readFileSync(path.join(resources, "development-profile.json"), "utf8"));
  const ownerHome = userInfo().homedir;
  const env = developmentEnvironment(profile, ownerHome, resources, process.env);
  validateDevelopmentPaths(profile, env, ownerHome);
  // These operations administer other placements/processes and are not part
  // of a local onboarding rehearsal. Never fall through to production defaults.
  // Of `mac-update`, Dev keeps `recover`, and `prepare-development`, which only
  // `scripts/dev/app.mjs install` runs, from the incoming bundle, while Dev is
  // quit: it stands in for the old app preparing a schema-changing update.
  if ((process.argv[2] === "mac-update" && !["recover", "prepare-development"].includes(process.argv[3])) ||
      (process.argv[2] === "mac-setup" && process.argv.includes("stop-port"))) {
    throw new Error("operation_unavailable_in_development_app");
  }
  Object.assign(env, validateDevelopmentSettings(env.ENGAGER_ENV_FILE, env));
  verifyDevelopmentDatabase(env);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  process.chdir(env.ENGAGER_HOME);
  activated = true;
}

export function validateDevelopmentSettings(file, env) {
  let content;
  try {
    if (!lstatSync(file).isFile()) throw new Error("development_settings_not_file");
    content = readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
  const settings = parseEnv(content);
  const allowed = new Set(["DATABASE_URL", "ENGAGER_MIGRATE_DATABASE_URL", "ENGAGER_MASTER_KEY", "ENGAGER_ORG_ID",
    "ENGAGER_DRIVER", "ENGAGER_PAYWALL_ENABLED", "ENGAGER_AGENT_CLI", "ENGAGER_LLM_BACKEND", "ANTHROPIC_API_KEY",
    "ENGAGER_MODEL_DEFAULT", "ENGAGER_MODEL_SCOUT", "ENGAGER_MODEL_RESPONDER", "ENGAGER_MODEL_WRITER"]);
  for (const [key, value] of Object.entries(settings)) {
    if (!(key in env) && !allowed.has(key)) throw new Error("development_setting_unsupported:" + key);
    if (["DATABASE_URL", "ENGAGER_MIGRATE_DATABASE_URL"].includes(key)) {
      let url;
      try { url = new URL(value); } catch { throw new Error("development_database_invalid"); }
      if (!["postgres:", "postgresql:"].includes(url.protocol) ||
          !["localhost", "127.0.0.1"].includes(url.hostname) || url.port !== env.ENGAGER_PG_PORT ||
          url.search || url.hash || url.pathname !== "/engager") throw new Error("development_database_escape");
    }
    if (key in env && value !== env[key]) throw new Error("development_setting_conflict:" + key);
    if (key === "ENGAGER_DEPLOYMENT_ENV" && value !== "local") throw new Error("development_placement_escape");
  }
  return settings;
}

/** Inspect every listener, including IPv6, without adopting a foreign process. */
export function developmentPortHolder({ port, ownPgdata, run = spawnSync }) {
  const result = run("/usr/sbin/lsof", ["-nP", `-tiTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  if (result.error || ![0, 1].includes(result.status)) throw new Error("development_port_inspection_failed");
  const pids = [...new Set(String(result.stdout ?? "").split("\n").filter(line => /^\d+$/.test(line)).map(Number))];
  if (!pids.length) return { kind: "none" };
  if (pids.length !== 1) return { kind: "foreign" };
  const ps = run("/bin/ps", ["-ww", "-o", "command=", "-p", String(pids[0])], { encoding: "utf8" });
  if (ps.error || ps.status !== 0) throw new Error("development_process_inspection_failed");
  return { pid: pids[0], ...classifyPostgresHolder({ command: ps.stdout, ownPgdata }) };
}

/** A compatible PostgreSQL listener is not necessarily this installation's.
 * Verify its actual process/data directory before any runtime can adopt it. */
export function verifyDevelopmentDatabase(env, run = spawnSync, holder = developmentPortHolder) {
  const ready = run(path.join(env.ENGAGER_PG_BIN_DIR, "pg_isready"),
    ["-h", "127.0.0.1", "-p", env.ENGAGER_PG_PORT, "-d", "postgres", "-t", "2"],
    { env, encoding: "utf8", timeout: 5000 });
  if (![0, 1, 2].includes(ready.status)) throw new Error("development_database_probe_failed");
  const owner = holder({ port: env.ENGAGER_PG_PORT, ownPgdata: env.ENGAGER_PGDATA, run });
  if (ready.status === 2 && owner.kind === "none") return false;
  if (owner.kind !== "ours") throw new Error("development_database_not_owned");
  const pidFile = path.join(env.ENGAGER_PGDATA, "postmaster.pid");
  if (!lstatSync(pidFile).isFile()) throw new Error("development_database_pid_invalid");
  const fields = readFileSync(pidFile, "utf8").split("\n");
  if (Number(fields[0]) !== owner.pid || path.resolve(fields[1] ?? "") !== path.resolve(env.ENGAGER_PGDATA) ||
      fields[3] !== env.ENGAGER_PG_PORT) throw new Error("development_database_pid_mismatch");
  return true;
}
