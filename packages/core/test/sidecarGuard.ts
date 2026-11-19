import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

/**
 * NO TEST LAUNCHES THE REAL BROWSER USE SIDECAR, AND NONE REACHES THE OWNER'S
 * PROFILE.
 *
 * A vitest case that built a driver from the module defaults once spawned
 * `uv run python bridge.py` for real while the owner's agent held
 * `~/.engager/browser-profile`: the sidecar started a Chromium on the live
 * profile, which is the one thing the gate must never do. The transports take
 * a `spawnImpl` and the suites hand them a fake, so the failure mode is a test
 * that forgot to — and a forgotten fake looks exactly like a passing test.
 *
 * `vitest.sidecar-guard.ts` installs this over `node:child_process` for every
 * test file. A spawn whose argv names the sidecar's entry script (`bridge.py`)
 * throws, naming what it was given, unless the test opted in: an explicit `--profile-dir` that is a directory of the
 * test's own under the system temp root. The default profile, the owner's, and
 * a missing `--profile-dir` (which the sidecar fills in from its environment)
 * are never an opt-in.
 */

/** The sidecar is the process that runs `bridge.py`. A python that only imports
 *  the `engager_browser_use` package (a journal probe, a bytecode check) opens
 *  no browser and is not it. */
const SIDECAR = /(^|[\\/\s])bridge\.py(\s|$)/;
/** The owner's profile as an argv spells it: `~/`, the real home, or the
 *  throwaway HOME the suite swaps in all end this way. */
const OWNER_PROFILE = /[\\/]\.engager[\\/]browser-profile/;

/** The functions whose argv is `(file, args?)`. `exec`/`execSync` take a shell
 *  string instead, which has no `--profile-dir` to opt in with. */
const ARGV_CALLS = ["spawn", "spawnSync", "execFile", "execFileSync", "fork"] as const;
const SHELL_CALLS = ["exec", "execSync"] as const;

type Callable = (...args: unknown[]) => unknown;
type Patchable = Record<string | symbol, unknown>;

/** Why this argv may not start the sidecar; null when it is not the sidecar or
 *  has opted in with a profile of its own. */
export function sidecarSpawnRefusal(argv: readonly string[]): string | null {
  if (!argv.some((arg) => SIDECAR.test(arg))) return null;
  const owner = argv.find((arg) => OWNER_PROFILE.test(arg));
  if (owner !== undefined) {
    return `its argv names the owner's browser profile (${owner})`;
  }
  const at = argv.indexOf("--profile-dir");
  const profile = at === -1 ? undefined : argv[at + 1];
  if (profile === undefined) {
    return "it has no --profile-dir, so the sidecar would fall back to the profile in its environment";
  }
  if (!underTempRoot(profile)) {
    return `--profile-dir ${profile} is not a directory under the system temp root`;
  }
  return null;
}

function underTempRoot(profile: string): boolean {
  const path = resolve(profile);
  return [tmpdir(), realpathSync(tmpdir())].some((root) => {
    const inside = relative(root, path);
    return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside);
  });
}

function argvOf(args: readonly unknown[]): string[] {
  const [file, rest] = args;
  return [String(file), ...(Array.isArray(rest) ? rest.map(String) : [])];
}

const GUARDED = Symbol.for("engager.sidecarSpawnGuard");

/**
 * Wrap the spawning functions of `target` (the real `child_process` in a test
 * run; a stand-in in the guard's own suite). Idempotent: setup files run once
 * per test file and must not stack wrappers.
 */
export function installSidecarSpawnGuard(target: Patchable): void {
  if (target[GUARDED] === true) return;
  for (const call of [...ARGV_CALLS, ...SHELL_CALLS]) {
    const real = target[call];
    if (typeof real !== "function") continue;
    const shell = (SHELL_CALLS as readonly string[]).includes(call);
    const check = (args: readonly unknown[]): void => {
      const why = shell
        ? SIDECAR.test(String(args[0]))
          ? "a shell command line cannot opt in"
          : null
        : sidecarSpawnRefusal(argvOf(args));
      if (why === null) return;
      throw new Error(
        `A test called child_process.${call} on the real Browser Use sidecar, and ${why}. ` +
          "Hand the transport a fake spawnImpl, " +
          "or opt in with a SubprocessBrowserUseTransport profileDir that is a temp directory of the test's own.",
      );
    };
    const guarded: Callable = function (this: unknown, ...args: unknown[]) {
      check(args);
      return (real as Callable).apply(this, args);
    };
    // `promisify(execFile)` reads this instead of the function it was handed,
    // so a wrapper without it would be walked around.
    const custom = (real as unknown as Record<symbol, unknown>)[promisify.custom];
    if (typeof custom === "function") {
      Object.defineProperty(guarded, promisify.custom, {
        value: function (this: unknown, ...args: unknown[]) {
          check(args);
          return (custom as Callable).apply(this, args);
        },
      });
    }
    target[call] = guarded;
  }
  target[GUARDED] = true;
}
