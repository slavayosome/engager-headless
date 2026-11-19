import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentFailure } from "./state";
import { agentExecutablePath } from "./authStore";
import type { AgentConnectionStatus } from "./types";

/**
 * Whether the owner's agent CLI is signed in to ITS OWN account, and the
 * one door to its own sign-in (US-ONE-04). Engager never handles a
 * password, opens a sign-in page, or receives a token: the probe asks the
 * CLI a yes/no question its maker already exposes, and the login runs the
 * CLI's own fixed-argv login, which opens the vendor's page itself.
 *
 * The probe reads no secret (§5 rule 13): never
 * `security find-generic-password -w`, never a credential file's contents.
 * The one account string it can return is the email Claude's own status
 * prints; the caller keeps it in memory only — never disk, telemetry or
 * logs — and every other byte a probe or login prints is discarded.
 */
export type SignInProbe = {
  signedIn: true | false | "unknown";
  /** The email the CLI itself prints (Claude only). In memory only. */
  account?: string | undefined;
};

/** The least an installation must carry for a probe or login: which agent
 *  it is, and the exact executable discovery returned. A page can only
 *  ever name a candidate id; the server resolves it to this shape. */
export type SignInInstallation = {
  adapterId: string;
  absoluteExecutable: string;
};

export type SignInProbeOptions = {
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  /** Test seams for the older-Claude fallback only — production reads the
   *  real home directory, platform and keychain presence. */
  home?: string | undefined;
  platform?: NodeJS.Platform | undefined;
  credentialPresent?: (() => Promise<boolean>) | undefined;
};

const PROBE_TIMEOUT_MS = 5_000;
const MAX_PROBE_BYTES = 256 * 1024;

/** The fixed argv each supported CLI answers sign-in state with. An
 *  adapter with no entry has no probe: its answer is "unknown", which the
 *  setup flow treats as "run the test request" (US-ONE-05), never as
 *  signed out. */
const STATUS_ARGV: Record<string, readonly string[]> = {
  claude: ["auth", "status", "--json"],
  codex: ["login", "status"],
};

/** The fixed argv each supported CLI opens its own sign-in with. Claude
 *  is pinned to `--claudeai` (never `--console`, the API-billing route)
 *  and Codex to plain `login` (never `--with-api-key`): the accounts
 *  setup offers are the owner's own subscriptions, nothing else. */
const LOGIN_ARGV: Record<string, readonly string[]> = {
  claude: ["auth", "login", "--claudeai"],
  codex: ["login"],
};

/** The child's environment, `agentChildEnvironment`'s shape without a
 *  selection: the REAL home (the credential the question is about lives
 *  there — discovery's empty-HOME inspection would answer about a
 *  different, empty account), a fixed PATH, and no provider key, so the
 *  answer is about native sign-in rather than an ambient API key. */
function signInChildEnvironment(home: string): NodeJS.ProcessEnv {
  const env: Record<string, string> = {
    HOME: home,
    PATH: agentExecutablePath(),
    TERM: "dumb",
  };
  if (process.env.USER) env.USER = process.env.USER;
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  if (process.env.ENGAGER_DEV_APP === "1") {
    // The probe and login must use the same private auth stores as inference.
    env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    env.CODEX_HOME = join(home, ".codex");
    env.DISABLE_AUTOUPDATER = "1";
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    if (process.env.ENGAGER_DEV_BROWSER_OPENER)
      env.BROWSER = process.env.ENGAGER_DEV_BROWSER_OPENER;
  }
  return env as NodeJS.ProcessEnv;
}

type ProbeRun = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnFailed: boolean;
};

/** One bounded fixed-argv run whose output is only ever parsed, never
 *  retained past the parse or written anywhere. The stderr half exists
 *  so "this older CLI has no such command" can be told apart from an
 *  answer — it is matched against a fixed pattern and discarded. */
function runProbe(
  bin: string,
  args: readonly string[],
  home: string,
  options: { signal?: AbortSignal | undefined; timeoutMs?: number | undefined },
): Promise<ProbeRun> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let timedOut = false;
    let spawnFailed = false;
    let settled = false;
    const child = spawn(bin, [...args], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: signInChildEnvironment(home),
    });
    const killGroup = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
    };
    const onAbort = () => killGroup();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) killGroup();
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    const collect = (into: "stdout" | "stderr") => (part: Buffer) => {
      bytes += part.length;
      if (bytes > MAX_PROBE_BYTES) {
        killGroup();
        return;
      }
      if (into === "stdout") stdout += part.toString();
      else stderr += part.toString();
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, timedOut, spawnFailed });
    };
    child.on("error", () => {
      spawnFailed = true;
      // A spawn that never started may never emit `close`.
      finish(null);
    });
    child.on("close", finish);
  });
}

/** "This CLI version has no such command" — the one failure that is about
 *  the CLI's age rather than the account, and the only one Claude's
 *  credential-presence fallback may answer for. */
function commandAbsent(run: ProbeRun): boolean {
  return /unknown command|no such command|invalid (?:sub)?command|unrecognized command|unknown (?:option|flag|argument)/i.test(
    `${run.stderr}\n${run.stdout}`,
  );
}

/** The older-Claude fallback: credential PRESENCE, the `prereqs.mjs`
 *  heuristic without its file read. On macOS the login-keychain item is
 *  asked for by name with no `-w` (its existence, never its secret);
 *  everywhere, including a macOS install that keeps the file instead,
 *  the credentials file's existence is the other half. Contents are
 *  never opened. */
async function claudeCredentialPresent(
  home: string,
  platform: NodeJS.Platform,
  options: { signal?: AbortSignal | undefined; timeoutMs?: number | undefined },
): Promise<boolean> {
  if (platform === "darwin" && process.env.ENGAGER_DEV_APP !== "1") {
    const keychain = await runProbe(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials"],
      home,
      options,
    );
    if (keychain.code === 0) return true;
  }
  try {
    await access(join(home, ".claude", ".credentials.json"));
    return true;
  } catch {
    return false;
  }
}

/** Only an email-shaped string the CLI printed is kept as the account:
 *  anything else in that field is the CLI's own business and is dropped
 *  with the rest of its output. */
function printedEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ? email
    : undefined;
}

/**
 * Ask one found installation whether it is signed in. Claude answers
 * from `claude auth status --json` (`loggedIn`; `email` as the account);
 * Codex from `codex login status` (exit 0 and "Logged in" is signed in;
 * the text after it is not kept). Where the command is missing on an
 * older supported version Claude falls back to credential presence and
 * Codex answers "unknown". Garbage, a timeout and a canceled probe are
 * "unknown" too — never signed out, because a probe that could not ask
 * has no verdict about the account.
 */
export async function probeSignIn(
  installation: SignInInstallation,
  options: SignInProbeOptions = {},
): Promise<SignInProbe> {
  const argv = STATUS_ARGV[installation.adapterId];
  if (!argv) return { signedIn: "unknown" };
  const home = options.home ?? process.env.HOME ?? homedir();
  const runOptions = {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
  };
  const run = await runProbe(
    installation.absoluteExecutable,
    argv,
    home,
    runOptions,
  );
  if (run.timedOut || run.spawnFailed || options.signal?.aborted)
    return { signedIn: "unknown" };

  if (installation.adapterId === "claude") {
    // The printed JSON is the verdict, whatever the exit beside it: a
    // signed-out CLI may exit non-zero while still printing
    // `{"loggedIn": false}`, and either half alone would misread it.
    let parsed: unknown;
    try {
      parsed = JSON.parse(run.stdout);
    } catch {
      parsed = undefined;
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { loggedIn?: unknown }).loggedIn === "boolean"
    ) {
      const status = parsed as { loggedIn: boolean; email?: unknown };
      if (!status.loggedIn) return { signedIn: false };
      const account = printedEmail(status.email);
      return { signedIn: true, ...(account ? { account } : {}) };
    }
    if (run.code === 0) return { signedIn: "unknown" };
    if (!commandAbsent(run)) return { signedIn: "unknown" };
    const present = options.credentialPresent
      ? await options.credentialPresent()
      : await claudeCredentialPresent(
          home,
          options.platform ?? process.platform,
          runOptions,
        );
    return { signedIn: present };
  }

  // Codex. "Not logged in" is checked first because it contains the
  // signed-in phrase; a bare non-zero exit or unrecognized output says
  // nothing the flow may act on, so it stays "unknown".
  const text = `${run.stdout}\n${run.stderr}`;
  if (/not logged in/i.test(text)) return { signedIn: false };
  if (run.code === 0 && /logged in/i.test(text)) return { signedIn: true };
  return { signedIn: "unknown" };
}

/** The probe's answer as the inventory's `authStatus` word. */
export function authStatusForProbe(probe: SignInProbe): AgentConnectionStatus {
  if (probe.signedIn === true) return "signed_in";
  if (probe.signedIn === false) return "signed_out";
  return "unknown";
}

export type StartedLogin = {
  /** The login launcher’s exit code once it ends (null when it was
   *  killed or could not spawn). On macOS, script also returns a nonzero
   *  code if it cannot launch Codex. The setup window polls the probe beside
   *  this; the exit only decides whether its button comes back. */
  exit: Promise<number | null>;
};

/**
 * Run the chosen CLI's own login, fixed argv, nothing from a page. The
 * CLI opens the vendor's sign-in page in the default browser itself;
 * Engager discards everything it prints (a sign-in URL can carry a
 * code) and never sees a password or a token. Only the agent the
 * owner chose can be named: the installation is the one discovery
 * returned for their candidate id, resolved by the caller.
 */
export function startLogin(
  installation: SignInInstallation,
  options: { signal?: AbortSignal | undefined } = {},
): StartedLogin {
  const argv = LOGIN_ARGV[installation.adapterId];
  if (!argv) throw agentFailure("agent_adapter_unsupported");
  // Dev agent sign-in may use the owner's default browser, by explicit
  // choice. Its token store remains private and Codex must use file storage.
  const loginArgv = process.env.ENGAGER_DEV_APP === "1" && installation.adapterId === "codex"
    ? ["-c", 'cli_auth_credentials_store="file"', ...argv] : [...argv];
  if (process.env.ENGAGER_DEV_APP === "1" && !process.env.ENGAGER_DEV_BROWSER_OPENER)
    throw agentFailure("agent_signin_dev_browser_required");
  const home = process.env.HOME ?? homedir();
  // macOS Codex suppresses automatic browser launch when its output is a
  // pipe. Give its own login a terminal without opening Terminal.app or
  // retaining a transcript. script forwards the command's exit status.
  // This applies to ordinary installs as well as isolated Dev installs.
  const terminalLogin = process.platform === "darwin" && installation.adapterId === "codex";
  const child = spawn(terminalLogin ? "/usr/bin/script" : installation.absoluteExecutable,
    terminalLogin ? ["-q", "/dev/null", installation.absoluteExecutable, ...loginArgv] : loginArgv, {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: signInChildEnvironment(home),
  });
  // Output is consumed so the child never blocks on a full pipe, and
  // dropped byte for byte: nothing a login prints is Engager's to keep.
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  const killGroup = () => {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
  };
  if (options.signal?.aborted) killGroup();
  else
    options.signal?.addEventListener("abort", killGroup, { once: true });
  const exit = new Promise<number | null>((resolve) => {
    let spawnFailed = false;
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", killGroup);
      resolve(spawnFailed ? null : code);
    };
    child.on("error", () => {
      spawnFailed = true;
      // A spawn that never started may never emit `close`.
      finish(null);
    });
    child.on("close", finish);
  });
  return { exit };
}
