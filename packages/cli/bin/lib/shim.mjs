// The `~/.engager/bin/engager` shim: one stable address for BOTH MCP
// registrations to point at, so an app-bundle update -- which replaces
// `Contents/Resources` wholesale -- does not orphan `~/.claude.json` and
// `~/.codex/config.toml`. Beside prereqs.mjs and localEnv.mjs: pure,
// dependency-free plain JS, everything injected, nothing spawned.
//
// The honest residual: the shim's own target is an absolute path inside the
// current bundle, so an app MOVED to a different location (rather than
// updated in place) leaves the shim pointing at nothing until the next
// `engager init` rewrites it. That is deliberate and it is the cheap
// failure -- one file to repair, versus two client configs in two formats
// this module cannot safely rewrite.
import path from "node:path";
import {
  chmodSync as fsChmodSync,
  existsSync as fsExistsSync,
  mkdirSync as fsMkdirSync,
  readFileSync as fsReadFileSync,
  writeFileSync as fsWriteFileSync,
} from "node:fs";

/** True only inside a macOS `.app` bundle, where `Contents/Resources` is the
 *  directory an app update replaces wholesale. The trailing slash makes a
 *  `pkgDir` that IS the Resources directory match too; the separator-bounded
 *  needle keeps a directory merely NAMED "Resources" from matching. No
 *  platform check: an `.app` bundle exists nowhere else. */
export function inAppBundle(pkgDir) {
  return `${pkgDir}/`.includes("/Contents/Resources/");
}

/** Where the shim lives. `homeDir` is the USER's home (`os.homedir()`) --
 *  NOT `engager.mjs`'s `HOME_DIR`, which is already `~/.engager`. */
export function shimPath(homeDir) {
  return path.join(homeDir, ".engager", "bin", "engager");
}

/** `sh` double-quote escaping: backslash, double quote, `$`, and backtick
 *  each get a preceding backslash -- an app bundle can sit under a path a
 *  user named, and an unescaped `$` in it would expand at run time into a
 *  broken command. */
function escapeForDoubleQuotes(value) {
  return value.replace(/[\\"$`]/g, "\\$&");
}

/** The shim's full text. `exec` rather than a plain call so the shim leaves
 *  no process between the client and the MCP server, and signals reach the
 *  server directly; `"$@"` is quoted so an argument containing a space is
 *  not resplit. */
export function shimScript({ nodeBin, engagerMjs }) {
  return `#!/bin/sh\nexec "${escapeForDoubleQuotes(nodeBin)}" "${escapeForDoubleQuotes(engagerMjs)}" "$@"\n`;
}

const defaultFsLike = {
  existsSync: fsExistsSync,
  readFileSync: fsReadFileSync,
  mkdirSync: fsMkdirSync,
  writeFileSync: fsWriteFileSync,
  chmodSync: fsChmodSync,
};

/** Write the shim. Idempotent by REWRITE, never by presence -- an old shim
 *  points at a bundle this update replaced, so "already exists" is exactly
 *  the reassuring no-op that leaves the install broken (`registerCodexMcp`'s
 *  recorded precedent: "Idempotent by REPAIR, not by presence").
 *
 *  The explicit `chmodSync` is not belt-and-braces: `writeFileSync`'s `mode`
 *  applies only when the file is CREATED, so a rewritten shim would silently
 *  keep whatever mode the previous write left. */
export function writeShim({ homeDir, nodeBin, engagerMjs, fsLike = defaultFsLike }) {
  const file = shimPath(homeDir);
  fsLike.mkdirSync(path.dirname(file), { recursive: true });
  fsLike.writeFileSync(file, shimScript({ nodeBin, engagerMjs }), { mode: 0o755 });
  fsLike.chmodSync(file, 0o755);
  return file;
}

/** The inverse of `shimScript`: the two paths a shim on disk names, or null
 *  for a file this module did not write. */
export function shimTarget(text) {
  const match = /^exec "((?:\\.|[^"\\])*)" "((?:\\.|[^"\\])*)" "\$@"$/m.exec(text);
  if (!match) return null;
  const unescape = (value) => value.replace(/\\(.)/g, "$1");
  return { nodeBin: unescape(match[1]), engagerMjs: unescape(match[2]) };
}

/** What `engager doctor` can say about the shim without spawning it. Both
 *  registrations name this one path on a bundle install, so a missing or
 *  dangling shim is the ENOENT every client reports and none can explain;
 *  `claude mcp list` says only "Failed to connect". The states, in the order
 *  they are checked: `missing` (no file), `unreadable` (a file this module
 *  did not write), `dangling` (the file is ours but a path it names is gone
 *  -- the app was moved, or the bundle it named was deleted; `missingPath`
 *  says which), and `ok`. */
export function shimStatus(file, fsLike = defaultFsLike) {
  if (!fsLike.existsSync(file)) return { state: "missing" };
  const target = shimTarget(fsLike.readFileSync(file, "utf8"));
  if (!target) return { state: "unreadable" };
  const missingPath = [target.nodeBin, target.engagerMjs].find((candidate) => !fsLike.existsSync(candidate));
  return missingPath ? { state: "dangling", target, missingPath } : { state: "ok", target };
}

/** The doctor row for `shimStatus`: ✓ only for `ok`, and every ✗ ends in
 *  the one repair there is, since `engager init` rewrites the shim
 *  unconditionally (`writeShim`: idempotent by rewrite). */
export function shimStatusLine(status, file) {
  switch (status.state) {
    case "ok":
      return `✓ engager shim (${file}) runs ${status.target.engagerMjs}`;
    case "missing":
      return `✗ engager shim missing (${file}) — both MCP registrations point at it; re-run \`engager init\``;
    case "unreadable":
      return `✗ engager shim (${file}) is not one \`engager init\` wrote; re-run \`engager init\``;
    case "dangling":
      return `✗ engager shim (${file}) runs ${status.missingPath}, which does not exist — was the app moved?; re-run \`engager init\``;
  }
}

/** How any process (Claude Code's MCP client included) should launch the
 *  stdio server: this CLI's own `mcp` subcommand, which loads the right env
 *  file and cwd for its mode.
 *
 *  ALWAYS an absolute path. A bare `engager` resolves only for a GLOBAL
 *  install, and the documented first run is `npx engager init` -- after
 *  which nothing named `engager` is on PATH and every client that reads this
 *  registration dies with `ENOENT: Executable not found in $PATH:
 *  "engager"`.
 *
 *  Inside an `.app` bundle that reasoning holds and the *answer* stops
 *  working: `engagerMjs` points into `Contents/Resources`, which the next
 *  app update replaces wholesale, and the registrations in `~/.claude.json`
 *  and `~/.codex/config.toml` are not rewritten when it does. The fix is one
 *  more indirection -- register a path the app never owns: the shim's,
 *  rather than the bundle's. The bundle path changes on every app update
 *  while the registration does not, and repairing one shim fixes every
 *  registered client at once without editing any client's config. */
export function mcpInvocation({ inBundle, shimPath: shim, nodeBin, engagerMjs }) {
  return inBundle ? [shim, "mcp"] : [nodeBin, engagerMjs, "mcp"];
}

export function claudeMcpAddArgs(invocation) {
  return ["mcp", "add", "-s", "user", "engager-local", "--", ...invocation];
}

export function codexMcpBlock(invocation) {
  return `[mcp_servers.engager-local]\ncommand = "${invocation[0]}"\nargs = ${JSON.stringify(invocation.slice(1))}\n`;
}

/** Where the engager-local table sits in a config.toml, or null. The table
 *  runs from its header to the next line that OPENS with `[` -- a boundary
 *  on line start, never on any `[`. The block's own `args = ["mcp"]` line
 *  contains one, and the first writer's `[^\[]*` stopped there: each re-run
 *  replaced `args = ` and left the old `["mcp"]` behind as a line of its
 *  own, which TOML reads as a table named `mcp`, and the second such line is
 *  a duplicate key that makes Codex refuse the whole file. Those orphans --
 *  any line that is a string array ending in `"mcp"`, the checkout shape
 *  `["…/engager.mjs","mcp"]` included -- are part of the table here, so one
 *  re-run repairs an install the old writer broke, and an uninstall takes
 *  them too. A blank line ends the table, so the separator before the next
 *  one survives either rewrite. */
const CODEX_MCP_TABLE = /^\[mcp_servers\.engager-local\](?:\n(?![\[\n])[^\n]*|\n\[(?:"[^"\n]*",)*"mcp"\](?=\n|$))*\n?/m;

/** The next `~/.codex/config.toml`: the engager-local table replaced where
 *  one exists, appended where none does. Returns `current` itself when the
 *  file already says exactly this, so the caller can tell "repaired" from
 *  "already current" by identity. */
export function upsertCodexMcpBlock(current, invocation) {
  const block = codexMcpBlock(invocation);
  if (CODEX_MCP_TABLE.test(current)) {
    // A function replacer: a `$` in a bundle path must land verbatim, not be
    // read as a replacement pattern.
    const next = current.replace(CODEX_MCP_TABLE, () => block);
    return next === current ? current : next;
  }
  const glue = current === "" || current.endsWith("\n") ? "" : "\n";
  return `${current}${glue}\n${block}`;
}

/** The next `~/.codex/config.toml` without the engager-local table; `current`
 *  itself when there is none. Only the seam is tidied -- the blank line
 *  `upsertCodexMcpBlock` put before the table goes with it, and a table that
 *  opened the file does not leave a blank first line -- so the rest of the
 *  owner's file is byte-for-byte what it was. */
export function removeCodexMcpBlock(current) {
  const match = CODEX_MCP_TABLE.exec(current);
  if (!match) return current;
  let prefix = current.slice(0, match.index);
  let suffix = current.slice(match.index + match[0].length);
  if (/^\n*$/.test(prefix)) prefix = "";
  else if (prefix.endsWith("\n\n") && (suffix === "" || suffix.startsWith("\n"))) prefix = prefix.slice(0, -1);
  if (prefix === "") suffix = suffix.replace(/^\n+/, "");
  return `${prefix}${suffix}`;
}
