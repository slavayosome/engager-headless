import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  CODEX_DISABLED_FEATURES,
  CODEX_JUDGMENT_PROFILE,
  codexPermissionArgs,
  type CodexPermissionProfile,
} from "./codex";
import { agentFailure, agentStateDirectory } from "./state";
import type { CodexSelfTestCheck } from "./types";

/**
 * THE CODEX SANDBOX SELF-TEST: does this binary's sandbox enforce Engager's
 * judgment profile on this Mac? Answered with no model call, by running
 * ordinary commands under `codex sandbox` and looking at what they managed to
 * do.
 *
 * `codex sandbox` resolves its configuration through the same builder and `-c`
 * overrides `codex exec` does and emits the same seatbelt policy for a tool
 * process (`create_seatbelt_command_args`, read at Codex 0.153.4). Two of its
 * defaults differ from `exec`, and both are pinned here: the profile is named
 * with `-c default_permissions`, never `-P` (which drops managed
 * requirements), and `CODEX_HOME` is an empty directory, because `sandbox`
 * has no `--ignore-user-config`.
 *
 * The judgment profile itself starts nothing: without `:minimal` macOS denies
 * the system libraries a process loads, so every command dies at launch, and
 * "everything failed" proves nothing on its own. So the test runs twice:
 *
 * - under a PROBE profile — the judgment profile's own entries plus
 *   `:minimal` — a read inside the workspace must succeed, and reads out of it
 *   (directly, through a symlink, through `../`), writes anywhere and network
 *   must not. A loopback server, reached once with network allowed, proves
 *   the network check can fail;
 * - under the judgment profile itself, nothing may read, write or connect.
 *   That nothing even launches there today is how the profile works, not what
 *   is asked: a Codex that started granting `:minimal` itself would still
 *   hold every rule that matters.
 *
 * Every check is judged by its EFFECT — the canary's bytes in the output, a
 * file on disk, a request at the server — never by an exit code alone. The
 * run lives under the agent state directory, not the system temp directory:
 * `:minimal` opens the temp directories, and a canary there would read as a
 * leak. A state directory configured under them fails the test, closed.
 */
export const CODEX_SELF_TEST_VERSION = 1;

export type CodexSelfTestResult =
  | { ok: true; checks: CodexSelfTestCheck[]; enabledFeatures: string[] }
  | { ok: false; failedCheck: CodexSelfTestCheck };

/** Disabled features Codex will not let a user turn off, each with the
 *  disabled feature that removes its tools anyway. Codex re-enables
 *  `unified_exec` unless managed requirements pin it (`normalize_candidate`),
 *  and registers its exec tools only while `shell_tool` is on (`spec_plan`);
 *  both read at 0.153.4 and observed through 0.161.0. */
const FEATURES_GATED_BY: Readonly<Record<string, string>> = {
  unified_exec: "shell_tool",
};

/** Each command's bound. A sandboxed `cat` answers in well under a second; the
 *  caller's signal bounds the whole run. */
const COMMAND_TIMEOUT_MS = 5_000;

function probeProfile(network: boolean): CodexPermissionProfile {
  return {
    name: "engager_probe",
    filesystem: { ...CODEX_JUDGMENT_PROFILE.filesystem, ":minimal": "read" },
    network,
  };
}

type Ran = { code: number | null; output: string };

/** One bounded child, stdout and stderr together. A timeout or a cap is a kill
 *  and a null code — no effect observed, which each check then judges; only
 *  the caller's cancellation is an error. */
function runBounded(
  file: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal | undefined;
  },
): Promise<Ran> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(agentFailure("agent_canceled"));
      return;
    }
    const child = spawn(file, [...args], {
      cwd: options.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env,
    });
    let output = "";
    let killed = false;
    const stop = () => {
      killed = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
    };
    const onAbort = () => stop();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(stop, COMMAND_TIMEOUT_MS);
    const collect = (part: Buffer) => {
      if (output.length + part.length > 64 * 1024) stop();
      else output += part.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", () => {});
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (options.signal?.aborted) reject(agentFailure("agent_canceled"));
      else resolve({ code: killed ? null : code, output });
    });
  });
}

export async function runCodexSandboxSelfTest(
  executable: string,
  options: { signal?: AbortSignal | undefined } = {},
): Promise<CodexSelfTestResult> {
  const parent = join(agentStateDirectory(), "codex-self-test");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(parent, "run-"));
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.end("ok");
  });
  try {
    const workspace = join(root, "workspace");
    const codexHome = join(root, "codex-home");
    await mkdir(workspace);
    await mkdir(codexHome);
    const control = `engager-control-${randomBytes(8).toString("hex")}`;
    const canary = `engager-canary-${randomBytes(8).toString("hex")}`;
    const canaryFile = join(root, "canary.txt");
    await writeFile(join(workspace, "inside.txt"), control);
    await writeFile(canaryFile, canary);
    await symlink(join("..", "canary.txt"), join(workspace, "link"));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const env: NodeJS.ProcessEnv = {
      HOME: root,
      CODEX_HOME: codexHome,
      PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
      TERM: "dumb",
      NODE_ENV: "production",
    };
    const context = { cwd: workspace, env, signal: options.signal };
    const run = (profile: CodexPermissionProfile, command: string[]) =>
      runBounded(
        executable,
        ["sandbox", ...codexPermissionArgs(profile), "--", ...command],
        context,
      );
    const curl = ["/usr/bin/curl", "-sS", "-m", "3", "-o", "/dev/null", url];
    const readBlocked = async (
      profile: CodexPermissionProfile,
      path: string,
    ) => {
      const ran = await run(profile, ["/bin/cat", path]);
      return ran.code !== 0 && !ran.output.includes(canary);
    };
    const writeBlocked = async (
      profile: CodexPermissionProfile,
      path: string,
    ) => {
      const ran = await run(profile, ["/usr/bin/touch", path]);
      return ran.code !== 0 && !existsSync(path);
    };
    const networkBlocked = async (profile: CodexPermissionProfile) => {
      const before = requests;
      const ran = await run(profile, curl);
      return ran.code !== 0 && requests === before;
    };
    const probe = probeProfile(false);
    const checks: [CodexSelfTestCheck, () => Promise<boolean>][] = [
      [
        "control",
        async () => {
          const ran = await run(probe, ["/bin/cat", "inside.txt"]);
          return ran.code === 0 && ran.output.includes(control);
        },
      ],
      ["read_outside", () => readBlocked(probe, canaryFile)],
      ["symlink_out", () => readBlocked(probe, "link")],
      ["traversal", () => readBlocked(probe, join("..", "canary.txt"))],
      ["write_workspace", () => writeBlocked(probe, join(workspace, "written"))],
      ["write_outside", () => writeBlocked(probe, join(root, "written"))],
      ["network", () => networkBlocked(probe)],
      [
        "network_control",
        async () => {
          const before = requests;
          const ran = await run(probeProfile(true), curl);
          return ran.code === 0 && requests > before;
        },
      ],
      [
        "judgment_profile",
        async () =>
          (await readBlocked(CODEX_JUDGMENT_PROFILE, canaryFile)) &&
          (await writeBlocked(CODEX_JUDGMENT_PROFILE, join(root, "written"))) &&
          (await networkBlocked(CODEX_JUDGMENT_PROFILE)),
      ],
    ];
    const passed: CodexSelfTestCheck[] = [];
    for (const [name, holds] of checks) {
      if (!(await holds())) return { ok: false, failedCheck: name };
      passed.push(name);
    }
    // The feature table `exec` will run with: every feature Engager disables
    // must read disabled under the same `--disable` flags, or be one Codex
    // keeps on whose tools a disabled feature gates.
    const features = await runBounded(
      executable,
      [
        "features",
        "list",
        ...CODEX_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
      ],
      context,
    );
    // A table this cannot read is a failure, not an empty one: every feature
    // Engager disables must be on a row that says `true` or `false`.
    const table = new Map<string, boolean>();
    for (const line of features.output.split("\n")) {
      const columns = line.trim().split(/\s+/);
      const state = columns.at(-1);
      if (columns.length > 1 && (state === "true" || state === "false"))
        table.set(columns[0]!, state === "true");
    }
    const stillOn = (feature: string) => {
      const gate = FEATURES_GATED_BY[feature];
      return (
        table.get(feature) !== false &&
        (gate === undefined || table.get(gate) !== false)
      );
    };
    if (features.code !== 0 || CODEX_DISABLED_FEATURES.some(stillOn))
      return { ok: false, failedCheck: "features" };
    const enabledFeatures = [...table]
      .filter(([, on]) => on)
      .map(([name]) => name);
    return { ok: true, checks: [...passed, "features"], enabledFeatures };
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
}
