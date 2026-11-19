import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * THE IN-SESSION DRAIN, run where the queue already runs.
 *
 * `drainQueue` claims and executes every job type, so importing it reaches the
 * posting handlers, and through them the commercial projection. The free
 * interactive bundle may not carry that: `build.e2e.test.ts` asserts a
 * licence-free `dist/mcp.mjs`, and an interactive surface that can evaluate a
 * licence is exactly what that invariant exists to prevent. So the drain runs
 * in the core-command child the self-managed CLI already spawns for
 * `engager run --once` — one implementation, one set of bounds, and the
 * boundary intact.
 *
 * `ENGAGER_CLI_ROOT`, which the launcher sets for every server it starts,
 * names the install: the built command under its `dist/`, or a checkout's own
 * script two levels up. Otherwise the entry is found from this module, which
 * is inlined into whichever bundle imports it, so `import.meta.url` is that
 * bundle's own location: beside a packaged `dist/mcp.mjs` the sibling is the
 * built command, and from source it is the repository's own script.
 *
 * The dashboard imports this module through the MCP tool registry, and webpack
 * replaces `import.meta.url` there with the BUILD machine's path — so inside
 * the Next server only the named root counts. `NEXT_RUNTIME` is a build-time
 * constant in that bundle, which drops the branch and the literal with it.
 *
 * Each candidate is JOINED onto a directory rather than written as a
 * `new URL("./…", import.meta.url)`: webpack resolves that form at BUILD time
 * as a module asset — a file that exists only in a packaged layout then fails
 * `next build` outright rather than simply being absent at run time.
 */
function entryCandidates(env) {
  const root = env.ENGAGER_CLI_ROOT;
  if (root) {
    return [
      { entry: path.join(root, "dist/core-command.mjs"), tsx: false },
      { entry: path.join(root, "../../scripts/core-command.ts"), tsx: true },
    ];
  }
  if (!process.env.NEXT_RUNTIME) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return [
      { entry: path.join(here, "core-command.mjs"), tsx: false },
      { entry: path.join(here, "../../dist/core-command.mjs"), tsx: false },
      { entry: path.join(here, "../../../../scripts/core-command.ts"), tsx: true },
    ];
  }
  return [];
}

function resolveEntry(env) {
  return entryCandidates(env).find(({ entry }) => existsSync(entry)) ?? null;
}

/** A child's own last line when it is one of the codes this runtime raises,
 *  and otherwise nothing: an arbitrary line of a child's stderr can carry a
 *  connection string, so only a known-safe shape is repeated. */
function childCode(result) {
  const last = (result.stderr ?? "").trim().split("\n").at(-1) ?? "";
  if (/^[a-z][a-z0-9_:.-]+$/.test(last)) return last;
  if (result.error) return String(result.error.code ?? "spawn_failed").toLowerCase();
  return "drain_unavailable";
}

/**
 * Run already-due work for the organization named by the caller's environment.
 *
 * Returns the child's own `{ processed }`. Throws `drain_entry_missing` when
 * this installation ships no command to run — which is a real answer on a
 * surface built without one, not a failure to paper over — and the child's own
 * refusal code for anything it declined, so `drain_bounds_invalid` and
 * `organization_required` reach the caller unchanged.
 */
const active = new Set();
let stopping = false;

/** Stop session-owned drain groups before the MCP holder closes its browser. */
export async function stopDrainChildren() {
  stopping = true;
  await Promise.all([...active].map(({ stop, done }) => {
    stop("drain_canceled");
    return done;
  }));
}

export async function drainDueWork({ maxJobs, maxMs, env = process.env, signal } = {}) {
  if (stopping || signal?.aborted) throw new Error("drain_canceled");
  const resolved = resolveEntry(env);
  if (!resolved) throw new Error("drain_entry_missing");
  const args = resolved.tsx
    ? ["--import", "tsx", resolved.entry, "run", String(maxJobs), String(maxMs)]
    : [resolved.entry, "run", String(maxJobs), String(maxMs)];
  const child = spawn(process.execPath, args, {
    // The entry loads `.env` from its working directory, the way every other
    // core-command child reaches this installation's own configuration.
    cwd: env.ENGAGER_HOME ?? process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  // Async by necessity: the child's browser requests are served by this
  // parent's event loop. spawnSync starves even the discovery health probe.
  let stdout = "", stderr = "", bytes = 0, refusal, error, killTimer;
  const kill = (sig) => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch { /* Already reaped. */ }
  };
  const stop = (code) => {
    if (refusal) return;
    refusal = code;
    kill("SIGTERM");
    killTimer = setTimeout(() => kill("SIGKILL"), 5_000);
  };
  const onAbort = () => stop("drain_canceled");
  const timer = setTimeout(() => stop("drain_timeout"), (Number(maxMs) || 25_000) + 20_000);
  child.stdout.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) stop("drain_output_limit");
    else stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) stop("drain_output_limit");
    else stderr += chunk;
  });
  child.on("error", (cause) => { error = cause; });
  const done = new Promise((resolve) => child.once("close", (status) => {
    clearTimeout(timer);
    clearTimeout(killTimer);
    signal?.removeEventListener("abort", onAbort);
    active.delete(handle);
    resolve({ status, stdout, stderr, error });
  }));
  const handle = { stop, done };
  active.add(handle);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const result = await done;
  if (refusal) throw new Error(refusal);
  if (result.status !== 0) throw new Error(childCode(result));
  try {
    const { processed } = JSON.parse(result.stdout);
    return { processed: Number.isSafeInteger(processed) ? processed : 0 };
  } catch {
    throw new Error("drain_result_unreadable");
  }
}
