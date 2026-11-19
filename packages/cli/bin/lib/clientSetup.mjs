import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, rmdirSync } from "node:fs";
import path from "node:path";
import { atomicWrite, hash, inventory, noSymlinks, readJson } from "./ownedFiles.mjs";
import { codexMcpBlock } from "./shim.mjs";

export const CLIENTS = ["claude", "claude-desktop", "codex", "manual"];
/** What each client's Skills arrive by when no directory it reads is ours to
 *  write. Printed by `client setup` and reported by `status`, because for
 *  Claude Desktop this IS the whole answer and a silent absence would read as
 *  an install that half-worked. */
const MCP_SKILLS_ROUTE = "not_loaded_from_disk; retrieve over MCP with list_skills then get_skill_file";

/** Where each client READS — never where an installer finds it convenient to
 *  write. Claude Code takes its user-scope MCP entry from `~/.claude.json` and
 *  its Skills from `~/.claude/skills`; Codex takes a TOML table (`CODEX_HOME`
 *  selects that configuration directory alone) and reads `~/.agents/skills`.
 *
 *  Claude Desktop — and the Cowork mode built on it — reads
 *  `claude_desktop_config.json` under its own application-support directory
 *  and loads NO skill from any path this install could write: a session's
 *  `.claude` is a per-session directory the app creates, its
 *  `CLAUDE_CONFIG_DIR` points there rather than at the home one, and the
 *  skills it does mount come from the account and from app-managed plugin
 *  storage (docs/free-core.md records the evidence). So its `skills` is null
 *  and the MCP entry is the entire registration. macOS only: the free core is
 *  an Apple Silicon profile, and the directory this file sits in is the one
 *  piece of primary evidence there is — the Windows and Linux spellings are
 *  refused rather than guessed. `platform` is that decision's only input and
 *  defaults to the host's; it selects a SPELLING and can name no second
 *  supported location, because `darwin` is the only spelling there is. */
export function clientPaths(home, client, codexHome = path.join(home, ".codex"), platform = process.platform) {
  if (!CLIENTS.includes(client)) throw new Error("client_unsupported");
  if (client === "manual") return null;
  if (client === "claude-desktop") {
    if (platform !== "darwin") throw new Error("client_desktop_platform_unsupported");
    return { skills: null, config: path.join(home, "Library/Application Support/Claude/claude_desktop_config.json") };
  }
  return {
    skills: path.join(home, client === "codex" ? ".agents" : ".claude", "skills"),
    config: client === "codex" ? path.join(codexHome, "config.toml") : path.join(home, ".claude.json"),
  };
}
/** The platform a COMMAND resolves Claude Desktop's location for: the host's,
 *  unless `ENGAGER_TEST_CLIENT_DESKTOP_PLATFORM` names another.
 *
 *  That variable is test-only and spells so in its own name. The custody this
 *  file keeps around `claude_desktop_config.json` — one owned entry, every
 *  other key preserved, an owner's own entry left alone, the entry taken back
 *  on uninstall — is macOS-shaped, and the suite that proves it runs on Linux
 *  too; without a seam those rules would be unproven on the platform CI
 *  actually uses, and the repository admits no skip to hide that. It selects
 *  among the spellings `clientPaths` knows, so an unknown value still refuses;
 *  it reaches the `claude-desktop` branch alone; and it is advertised in no
 *  help text and no document, because it is not part of the owner's contract. */
export function desktopPlatform(env) {
  return env.ENGAGER_TEST_CLIENT_DESKTOP_PLATFORM ?? process.platform;
}
const JSON_CONFIG = ["claude", "claude-desktop"];
const blockPattern = /^\[mcp_servers\.(?:engager-local|"engager-local"|'engager-local')\][^]*?(?=^\[|$(?![^]))/gm;
function configEntry(text, client) {
  if (JSON_CONFIG.includes(client)) {
    if (duplicateJsonKey(text)) throw new Error("client_duplicate_configuration");
    return JSON.stringify(JSON.parse(text || "{}").mcpServers?.["engager-local"] ?? null);
  }
  const blocks = [...text.matchAll(blockPattern)];
  if (blocks.length > 1) throw new Error("client_duplicate_configuration");
  return blocks[0]?.[0] ?? "";
}

/** The first key this document names twice, or null. `JSON.parse` keeps the
 *  LAST of two same-named keys, so a config carrying any is one this routine
 *  cannot rewrite without silently dropping the owner's other copy — the same
 *  loss the duplicate Codex table refuses, in JSON's spelling. Scanned rather
 *  than parsed because a parser has already thrown the evidence away. */
function duplicateJsonKey(text) {
  const objects = [];
  let expectKey = false;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (char === "{") { objects.push(new Set()); expectKey = true; }
    else if (char === "[") { objects.push(null); expectKey = false; }
    else if (char === "}" || char === "]") { objects.pop(); expectKey = false; }
    else if (char === ",") expectKey = objects.at(-1) instanceof Set;
    else if (char === ":") expectKey = false;
    else if (char === '"') {
      const opened = at;
      while (++at < text.length && text[at] !== '"') if (text[at] === "\\") at += 1;
      if (!expectKey) continue;
      // The parsed name, so a key written twice in two escape spellings
      // counts as the duplicate it is. A key too malformed to parse is
      // compared as written: `configEntry`'s own parse refuses that file.
      const raw = text.slice(opened, at + 1);
      let name = raw;
      try { name = JSON.parse(raw); } catch { /* compared as written */ }
      if (objects.at(-1).has(name)) return name;
      objects.at(-1).add(name);
    }
  }
  return null;
}

/** The Skills half of `setupClient`, separately callable because the legacy
 * `engager init`/`uninstall` routes own the same client files with none of
 * this journal's MCP entry: their registrations are the native `claude mcp`
 * command and their own Codex table. `files` is the inventory to install,
 * so a caller whose source tree holds more than skills (a checkout's
 * `skills/`, which also carries the lint test) hands in only its own. */
/** The directories an uninstall just emptied. Deleting the files this install
 *  owned left `engager-setup/`, its `references/` and its `sections/` standing
 *  empty — directories the owner never made and would have to find and remove
 *  by hand to be rid of us.
 *
 *  Only directories this manifest wrote into are considered, deepest first so
 *  a parent is judged after its children, and each is removed only while it
 *  holds NOTHING: `rmdirSync` refuses a directory with anything in it, which
 *  is the guard itself. A skill the owner edited, or one they wrote beside
 *  ours, keeps its directory and every directory above it. */
function pruneEmptiedDirectories(skills, owned) {
  const directories = new Set();
  for (const name of owned) {
    for (let dir = path.dirname(name); dir !== "."; dir = path.dirname(dir)) directories.add(dir);
  }
  for (const dir of [...directories].sort((a, b) => b.split("/").length - a.split("/").length)) {
    try { rmdirSync(path.join(skills, dir)); } catch { /* still holds something, or was never written */ }
  }
}

const RETIRED_SKILLS = ["engager-scout", "engager-commenter", "engager-strategy", "engager-channel", "engager-brain", "engager-voice", "engager-ambassador"];

export function syncClientSkills({ root, home, client, source, files, codexHome, platform, remove = false }) {
  const paths = clientPaths(home, client, codexHome, platform);
  if (!paths) return null;
  const manifestPath = path.join(root, `client-${client}.json`);
  const manifest = readJson(manifestPath, { version: 1, client, files: {}, config: null });
  if (manifest.version !== 1 || manifest.client !== client) throw new Error("client_manifest_invalid");
  const conflicts = [];
  const save = () => atomicWrite(manifestPath, JSON.stringify(manifest, null, 2));
  // A client that reads no skills directory gets no skills directory. The
  // journal is still opened and returned unwritten: the MCP entry it records
  // is this client's whole ownership, and `setupClient` saves it there — so a
  // refused config leaves no journal claiming an install that did not happen.
  if (!paths.skills) return { client, paths, manifest, save, conflicts, installed: 0, removed: 0 };
  noSymlinks(paths.skills);
  const wanted = remove ? [] : (files ?? inventory(source));
  if (!remove) {
    for (const skill of RETIRED_SKILLS) {
      if (wanted.some((file) => file.path.startsWith(`${skill}/`)) || Object.keys(manifest.files).some((name) => name.startsWith(`${skill}/`))) continue;
      const directory = path.join(paths.skills, skill);
      const stat = lstatSync(directory, { throwIfNoEntry: false });
      if (!stat) continue;
      if (stat.isSymbolicLink()) { conflicts.push(`${skill}/`); continue; }
      rmSync(directory, { recursive: true });
    }
  }
  const names = new Set([...Object.keys(manifest.files), ...wanted.map((f) => f.path)]);
  let installed = 0, removed = 0;
  for (const name of names) {
    if (path.isAbsolute(name) || name.split("/").includes("..")) throw new Error("client_manifest_invalid");
    const dest = path.join(paths.skills, name);
    noSymlinks(dest);
    const old = manifest.files[name];
    const next = wanted.find((file) => file.path === name);
    const current = existsSync(dest) ? hash(readFileSync(dest)) : null;
    // Bytes that are EXACTLY what this release ships are this install's
    // whatever the journal says — the copy the shell installer or a run older
    // than the journal left is adopted rather than reported as an edit the
    // owner never made, which would leave the file unowned and never
    // refreshed. It is the same "ours" `uninstallLegacySkills` removes by.
    if (current && current === next?.sha256) {
      manifest.files[name] = { installed: current }; save();
      installed += 1; continue;
    }
    if (current && current !== old?.installed && current !== old?.pending) {
      conflicts.push(name); continue;
    }
    if (!next) {
      if (current) { rmSync(dest); removed += 1; }
      delete manifest.files[name]; save(); continue;
    }
    manifest.files[name] = { installed: old?.installed, pending: next.sha256 }; save();
    atomicWrite(dest, readFileSync(path.join(source, name)), next.mode);
    manifest.files[name] = { installed: next.sha256 }; save();
    installed += 1;
  }
  pruneEmptiedDirectories(paths.skills, remove ? names : [...names].filter((name) => !wanted.some((file) => file.path === name)));
  if (!remove) {
    for (const skill of RETIRED_SKILLS) {
      if (wanted.some((file) => file.path.startsWith(`${skill}/`))) continue;
      const left = path.join(paths.skills, skill);
      if (existsSync(left) && !lstatSync(left).isSymbolicLink() && !conflicts.some((name) => name.startsWith(`${skill}/`))) conflicts.push(`${skill}/`);
    }
  }
  return { client, paths, manifest, save, conflicts, installed, removed };
}

/** Only a hash-matching file or our exact MCP entry can be replaced. The
 * journal is written before each mutation, making interruption repairable. */
export function setupClient({ root, home, client, source, invocation, codexHome, platform, remove = false }) {
  const paths = clientPaths(home, client, codexHome, platform);
  if (!paths) return { client, state: "manual", invocation, recovery: "Configure a stdio MCP server using this command and arguments; retrieve Skills with list_skills/get_skill_file. Shell and browser capabilities are separate." };
  noSymlinks(paths.config);
  const { manifest, save, conflicts } = syncClientSkills({ root, home, client, source, codexHome, platform, remove });
  const text = existsSync(paths.config) ? readFileSync(paths.config, "utf8") : "";
  const current = configEntry(text, client);
  const json = JSON_CONFIG.includes(client);
  const absent = json ? "null" : "";
  const owned = manifest.config;
  if (current !== absent && current !== owned?.installed && current !== owned?.pending) {
    conflicts.push("mcp:engager-local");
  } else {
    // Claude Desktop's loader takes `command`, `args`, `env` and
    // `extensionId`, and skips an entry — with a dialog naming the file —
    // that does not parse as one; Claude Code's own `type` discriminator is
    // not part of that shape, so it is not written here.
    const desired = remove ? absent : client === "claude"
      ? JSON.stringify({ type: "stdio", command: invocation[0], args: invocation.slice(1) })
      : client === "claude-desktop"
        ? JSON.stringify({ command: invocation[0], args: invocation.slice(1) })
        : codexMcpBlock(invocation);
    manifest.config = { installed: owned?.installed, pending: desired }; save();
    let next;
    if (json) {
      const parsed = JSON.parse(text || "{}");
      parsed.mcpServers ??= {};
      if (remove) delete parsed.mcpServers["engager-local"];
      else parsed.mcpServers["engager-local"] = JSON.parse(desired);
      next = JSON.stringify(parsed, null, 2) + "\n";
    } else next = current ? text.replace(current, () => desired) : text + (text && !text.endsWith("\n") ? "\n" : "") + desired;
    if (next !== text) atomicWrite(paths.config, next);
    manifest.config = remove ? null : { installed: desired }; save();
  }
  const state = conflicts.length ? "user_edits_preserved" : remove ? "removed" : "configured";
  return paths.skills ? { client, state, conflicts, paths } : { client, state, conflicts, paths, skills: MCP_SKILLS_ROUTE };
}

export function clientStatus({ root, home, client, codexHome, platform }) {
  let paths;
  try {
    paths = clientPaths(home, client, codexHome, platform);
  } catch (error) {
    // A client this host has no configuration location for is REPORTED here,
    // never thrown: `status`, `doctor` and `uninstall` read this for every
    // journal the installation carries, and a Desktop registration written on
    // a Mac must not take the whole report down on another machine.
    if (error.message !== "client_desktop_platform_unsupported") throw error;
    return { client, state: "platform_unsupported", platform: platform ?? process.platform };
  }
  if (!paths) return { client, state: "manual", nativeDiscovery: false };
  try {
    const manifest = readJson(path.join(root, `client-${client}.json`), null);
    if (!manifest) return { client, state: "setup_required" };
    const changed = paths.skills ? Object.entries(manifest.files).filter(([name, row]) => {
      const file = path.join(paths.skills, name); noSymlinks(file);
      return !existsSync(file) || hash(readFileSync(file)) !== row.installed;
    }).map(([name]) => name) : [];
    noSymlinks(paths.config);
    const registered = existsSync(paths.config) && configEntry(readFileSync(paths.config, "utf8"), client) === manifest.config?.installed;
    return { client, state: registered && !changed.length ? "configured" : "repair_required", registered, changed, files: Object.keys(manifest.files).length, skills: paths.skills ?? MCP_SKILLS_ROUTE, nativeDiscovery: "pending_real_client_validation" };
  } catch { return { client, state: "configuration_invalid" }; }
}
