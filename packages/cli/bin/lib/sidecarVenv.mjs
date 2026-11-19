// The browser sidecar's Python environment: the one `uv sync` that builds
// it and the one check that says whether it is usable. Shared by the free
// CLI's `init`, which warms it there, and Mac setup's LinkedIn browser row
// (US-OND-07), which builds it as that row's first phase -- one spelling,
// so every caller puts the venv exactly where the runtime looks for it.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveBin } from "./prereqs.mjs";

/** What the finished environment measures on disk (the owner's Mac:
 *  venv 4 MB since the sidecar drives Chromium over `cdp-use` alone; it
 *  was 228 MB under Browser Use, US-OND-07/O-9). The LinkedIn browser row's "about [X MB]"
 *  is this plus the Chromium download in `browserManifest.mjs` -- the
 *  measured figure, never the design boards' placeholder. */
export const BROWSER_TOOLS_MEASURED_BYTES = 4_000_000;
// The lock this environment was synchronized against.
const VENV_MARKER = ".engager-lock-1f7ac20debe90c98add757121358416d5bea72dcbb34ef56cc8579433ee5ba23";
export function browserVenvMarker(root) { return path.join(root, "venv", VENV_MARKER); }

/** A token a shell will read back as itself, so a `repair` line pastes from an
 *  install whose HOME carries a space. */
function shellQuote(value) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}
/** What `uv` may see. The keys are `CHILD_ENV_ALLOWLIST` in
 *  `packages/core/linkedin/browser-use/subprocessTransport.ts` — the list
 *  that already decides what the sidecar itself inherits — plus
 *  `UV_PYTHON_INSTALL_DIR`, which `freeEnvironment` sets and the sidecar has
 *  no use for.
 *
 *  `init`'s own environment is NOT that list: by this point it carries the
 *  install's master key, both database URLs and whatever provider keys the
 *  ambient shell had, and a package index resolver is not a process any of
 *  that belongs to. */
const UV_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "UV_CACHE_DIR",
  "UV_PROJECT_ENVIRONMENT",
  "UV_PYTHON_INSTALL_DIR",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
];
/** The one `uv sync` that builds the browser sidecar's Python environment.
 *
 *  `browser-use/subprocessTransport.ts` spawns `uv run --project
 *  <pkg>/dist/python --locked` and forwards `UV_PROJECT_ENVIRONMENT` and
 *  `UV_CACHE_DIR` from the child-env allowlist, so the same project and the
 *  same two keys — the ones `freeEnvironment` already points at
 *  `<root>/venv` and `<root>/cache/uv` — are what puts the venv exactly
 *  where the runtime will look for it. A different spelling here would build
 *  a second environment nothing reads.
 *
 *  The three directories come from `root` AFTER the allowlist, so they
 *  always win over any ambient value: the free CLI's environment names
 *  exactly these, but Mac setup runs with the app's plain environment,
 *  and an inherited `UV_*` would otherwise sync outside `~/.engager`
 *  while the ready checks still look at `<root>/venv` -- Engager's folders
 *  are what "Clear caches" (US-OND-02) and uninstall can see, so the
 *  tools must land in them (US-OND-07).
 *
 *  `resolveBin` prefers the bundled binary through `ENGAGER_UV_BIN`, which
 *  `freeEnvironment` sets only when the bundle actually carries one, so the
 *  fall through to PATH here is reachable rather than decorative.
 *
 *  `PYTHONDONTWRITEBYTECODE` travels as a STATED entry beside the allowlist,
 *  the way `browserMediaChildEnv` states its switch: `uv sync` builds an
 *  editable project rooted at the sealed bundle's `dist/python`, so the
 *  resolver's own Python imports would otherwise write `__pycache__` inside
 *  the signature. The same policy is forced in the sidecar's own child env
 *  (`browser-use/subprocessTransport.ts`); this half covers the install that
 *  any sidecar exists. */
export function sidecarVenv(root, pkg, env) {
  const uv = resolveBin("uv", env);
  const project = path.join(pkg, "dist/python");
  const venv = path.join(root, "venv");
  return {
    uv,
    project,
    venv,
    args: ["sync", "--project", project, "--locked"],
    repair: `${shellQuote(uv)} sync --project ${shellQuote(project)} --locked && touch ${shellQuote(browserVenvMarker(root))}`,
    env: {
      ...Object.fromEntries(UV_ENV_ALLOWLIST.flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]]]))),
      UV_PROJECT_ENVIRONMENT: venv,
      UV_CACHE_DIR: path.join(root, "cache/uv"),
      UV_PYTHON_INSTALL_DIR: path.join(root, "python"),
      PYTHONDONTWRITEBYTECODE: "1",
    },
  };
}
/** Whether that environment is USABLE, in the two words `init` and `doctor`
 *  both report.
 *
 *  The lock-specific marker is written only after a successful sync. The
 *  package check also rejects a removed or incomplete environment.
 *
 *  Never a probe: a venv is a directory, and answering this must not cost the
 *  two minutes building one does. */
export function browserVenvState(root, pkg, env) {
  const venv = sidecarVenv(root, pkg, env);
  return browserVenvReady(root) ? { venv: "ready" } : { venv: "not_ready", repair: venv.repair };
}
/** The ready half alone, for a caller that has the install root and nothing
 *  else (Mac setup's status): the sidecar package is in `<root>/venv` under
 *  the interpreter that venv actually runs. */
export function browserVenvReady(root, fileExists = existsSync) {
  const venv = path.join(root, "venv");
  return fileExists(browserVenvMarker(root)) && venvLibraryDirs(venv).some((version) => fileExists(path.join(venv, "lib", version, "site-packages/cdp_use/__init__.py")));
}
/** The `lib/python3.x` directory THIS venv's interpreter imports from.
 *
 *  `pyvenv.cfg` carries the exact version the environment was built against
 *  (`version_info = 3.12.12`), and it is the only thing on disk that says
 *  which of several directories is live. A venv rebuilt on a newer
 *  interpreter keeps the old one beside the new — `python3.12` full of
 *  packages, `python3.13` empty — and answering from whichever holds the
 *  marker would call a fresh, empty environment ready.
 *
 *  The scan is the fallback for a venv with no readable `pyvenv.cfg`, which
 *  is a venv this could say nothing at all about otherwise. */
function venvLibraryDirs(venvDir) {
  try {
    const version = /^\s*version_info\s*=\s*(\d+\.\d+)/m.exec(readFileSync(path.join(venvDir, "pyvenv.cfg"), "utf8"));
    if (version) return [`python${version[1]}`];
  } catch { /* no readable cfg: fall back to what is on disk */ }
  try { return readdirSync(path.join(venvDir, "lib")).filter((name) => /^python3\.\d+$/.test(name)); }
  catch { return []; }
}
