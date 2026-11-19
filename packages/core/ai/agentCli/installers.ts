import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { observedExecutableVersion } from "./discovery";

/**
 * The ONE table of vendor installers setup may run (US-ONE-02). Every
 * surface that names an install command reads it from here — the adapters'
 * `install.command` (so the dashboard's empty state), this module's runner
 * (so the first-run window's button), and, by a sync test rather than an
 * import plain JS cannot make, `engager doctor`'s prerequisite fix — so the
 * three can no longer disagree, the way the npm commands, Anthropic's curl
 * and Codex's silence used to.
 *
 * The command run is a fixed entry of this table, chosen by the id alone:
 * nothing from the page, the environment or a file becomes part of it, and
 * each entry's host is on the allow-list below, pinned by a test. The
 * bundled Node carries no npm, which is why both entries are the vendors'
 * own shell installers rather than `npm install -g`.
 */
export type AgentInstaller = {
  id: "claude" | "codex";
  /** The setup board's name for the agent ("Claude Code", "Codex"). */
  name: string;
  /** The vendor's one official command, run and shown verbatim. */
  command: string;
  /** The host `command` downloads from — allow-listed below. */
  host: string;
  /** The vendor's setup page, for surfaces that open a page instead. */
  url: string;
  /** The executable the installer leaves behind. */
  binary: string;
  /** Where the installer puts it, home-relative, first hit wins. The
   *  "Check it runs" step runs THIS file, never whatever is on PATH. */
  binaryDirectories: readonly string[];
  /** The board's words: the none-found row and the installing card. */
  words: {
    rowBlurb: string;
    installButton: string;
    recommended: boolean;
    installingTitle: string;
    installingSubtitle: string;
    installRowDetail: string;
    thenSignIn: string;
  };
};

export const AGENT_INSTALLERS: Readonly<Record<"claude" | "codex", AgentInstaller>> = {
  claude: {
    id: "claude",
    name: "Claude Code",
    command: "curl -fsSL https://claude.ai/install.sh | bash",
    host: "claude.ai",
    url: "https://code.claude.com/docs/en/setup",
    binary: "claude",
    // The native installer's landing spot is `~/.local/bin`; older native
    // installs keep the binary under `~/.claude/local`.
    binaryDirectories: [".local/bin", ".claude/local"],
    words: {
      rowBlurb: "Anthropic's official installer. Then you sign in with your Claude account.",
      installButton: "Install Claude Code for me",
      recommended: true,
      installingTitle: "Installing Claude Code",
      installingSubtitle: "The official installer from Anthropic. This usually takes a minute or two.",
      installRowDetail: "Putting Claude Code on this Mac for your user.",
      thenSignIn: "Then you sign in to Claude.",
    },
  },
  codex: {
    id: "codex",
    name: "Codex",
    command: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
    host: "chatgpt.com",
    url: "https://developers.openai.com/codex/cli/",
    binary: "codex",
    // OpenAI's standalone installer links the binary into `~/.local/bin`,
    // which Codex's discovery directories already name.
    binaryDirectories: [".local/bin"],
    words: {
      rowBlurb: "OpenAI's official installer. Then you sign in with your ChatGPT account.",
      installButton: "Install Codex",
      recommended: false,
      installingTitle: "Installing Codex",
      installingSubtitle: "The official installer from OpenAI.",
      installRowDetail: "Putting Codex on this Mac for your user.",
      thenSignIn: "Then you sign in to Codex.",
    },
  },
};

/** The only hosts an installer command may download from. A table entry
 *  pointing anywhere else fails `agentInstaller` — and the test that walks
 *  the table — rather than running. */
export const INSTALLER_HOSTS: ReadonlySet<string> = new Set([
  "claude.ai",
  "chatgpt.com",
]);

/** The installer for an id the page or Swift sent, or `undefined` for
 *  anything else: only `claude` and `codex` exist, and an unknown id is a
 *  refusal at the verb, never a guessed command. */
export function agentInstaller(id: string): AgentInstaller | undefined {
  const entry = (AGENT_INSTALLERS as Record<string, AgentInstaller>)[id];
  if (!entry || !INSTALLER_HOSTS.has(entry.host)) return undefined;
  return entry;
}

/** One streamed line of `agent-setup install <id> --json`. Phases are the
 *  board's three steps (1 Download, 2 Install, 3 Check it runs) because
 *  the native installers print no byte progress to fill a bar with. The
 *  phase-1 event also carries the table command, so a stream that ends
 *  without its terminal `failed` event (a killed child, a truncated pipe)
 *  still leaves the window the command its fallback card offers to copy —
 *  Swift holds no copy of the string to fall back on. */
export type AgentInstallEvent =
  | { event: "phase"; step: 1 | 2 | 3; command?: string }
  | { event: "log"; line: string }
  | { event: "done"; version?: string; sizeMB?: number }
  | { event: "failed"; reason: string; command: string };

/** How the installer's process ended, as the runner seam reports it. */
export type InstallerRunResult = {
  exitCode: number | null;
  /** The run was stopped by the caller's signal (Cancel, window close). */
  canceled: boolean;
  /** The process could not be started at all. */
  spawnFailed?: boolean;
};

/** Runs ONE fixed table command, streaming its output lines. The command
 *  arrives whole from the table; a runner cannot be handed anything else
 *  because `runAgentInstall` is the only caller and it passes the entry's
 *  own string. Tests substitute a fake that prints canned lines — no test
 *  runs an installer or opens the network. */
export type InstallerRunner = (
  command: string,
  options: { signal?: AbortSignal | undefined; onLine: (line: string) => void },
) => Promise<InstallerRunResult>;

const INSTALL_TIMEOUT_MS = 600_000;

/**
 * The real runner: the table command under `/bin/sh`, in its own process
 * group so Cancel stops the whole group (the shell, curl and whatever the
 * vendor script spawned), with stdin closed and no terminal — Engager
 * never prompts for an administrator password and never uses sudo, so a
 * script that asks for one gets EOF and fails into the copy-the-command
 * fallback instead of a password dialog. The environment is the caller's
 * own; nothing in it can reach the command string.
 */
export const spawnInstaller: InstallerRunner = (command, { signal, onLine }) =>
  new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    let canceled = false;
    const stopGroup = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch { /* already gone */ }
      }
    };
    const onAbort = () => {
      canceled = true;
      stopGroup();
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(stopGroup, INSTALL_TIMEOUT_MS);
    timer.unref?.();
    const lines = (stream: NodeJS.ReadableStream | null) => {
      if (!stream) return;
      let pending = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        pending += chunk;
        const parts = pending.split("\n");
        pending = parts.pop() ?? "";
        for (const part of parts) onLine(part);
      });
      stream.on("end", () => {
        if (pending) onLine(pending);
      });
    };
    lines(child.stdout);
    lines(child.stderr);
    const settle = (result: InstallerRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    child.on("error", () => settle({ exitCode: null, canceled, spawnFailed: true }));
    child.on("close", (code) => settle({ exitCode: code, canceled }));
  });

/** The installed file for an entry, first existing candidate under home. */
async function installedBinary(
  entry: AgentInstaller,
  home: string,
): Promise<{ path: string; sizeMB: number } | undefined> {
  for (const directory of entry.binaryDirectories) {
    const candidate = join(home, directory, entry.binary);
    try {
      const info = await stat(candidate);
      if (info.isFile())
        return { path: candidate, sizeMB: Math.round(info.size / 1_000_000) };
    } catch { /* not there — the next directory, or a failed install */ }
  }
  return undefined;
}

/**
 * Runs one agent's installer end to end, emitting the streamed events:
 * phase 1 while the vendor script downloads, phase 2 from its first
 * output (the script arrived and is installing), phase 3 for "Check it
 * runs" — `<binary> --version` on the installed file itself. A failure
 * (non-zero exit, no network, no disk, a refusal, a binary that never
 * lands) ends in `failed` carrying the reason in words and the same table
 * command, which is what the fallback card offers to copy. Cancel stops
 * the process group through the signal and reports `canceled`, which the
 * window renders as a return to the none-found card, not a failure.
 *
 * Started only by the owner's button press through the `agent-setup
 * install` verb — never by detection, `engager init` or a background job.
 */
export async function runAgentInstall(
  entry: AgentInstaller,
  options: {
    emit: (event: AgentInstallEvent) => void;
    signal?: AbortSignal | undefined;
    runner?: InstallerRunner | undefined;
    home?: string | undefined;
    /** Test seam for phase 3; defaults to the real `--version` probe. */
    versionOf?: ((file: string) => Promise<string | undefined>) | undefined;
    findBinary?:
      | ((entry: AgentInstaller, home: string) => Promise<{ path: string; sizeMB: number } | undefined>)
      | undefined;
  },
): Promise<{ ok: boolean; canceled: boolean }> {
  const { emit } = options;
  const runner = options.runner ?? spawnInstaller;
  const home = options.home ?? homedir();
  emit({ event: "phase", step: 1, command: entry.command });
  let installing = false;
  const result = await runner(entry.command, {
    ...(options.signal ? { signal: options.signal } : {}),
    onLine: (line) => {
      if (!installing) {
        installing = true;
        emit({ event: "phase", step: 2 });
      }
      emit({ event: "log", line });
    },
  });
  if (result.canceled || options.signal?.aborted) {
    emit({ event: "failed", reason: "Install canceled.", command: entry.command });
    return { ok: false, canceled: true };
  }
  if (result.spawnFailed || result.exitCode !== 0) {
    emit({
      event: "failed",
      reason: result.spawnFailed
        ? "it could not start on this Mac"
        : `it stopped before it finished (exit ${result.exitCode ?? "unknown"})`,
      command: entry.command,
    });
    return { ok: false, canceled: false };
  }
  emit({ event: "phase", step: 3 });
  const found = await (options.findBinary ?? installedBinary)(entry, home);
  if (!found) {
    emit({
      event: "failed",
      reason: `it finished, but no ${entry.binary} was left where Engager looks`,
      command: entry.command,
    });
    return { ok: false, canceled: false };
  }
  const version = await (options.versionOf ?? observedExecutableVersion)(found.path);
  if (!version) {
    emit({
      event: "failed",
      reason: `the installed ${entry.binary} did not answer when Engager checked it runs`,
      command: entry.command,
    });
    return { ok: false, canceled: false };
  }
  emit({ event: "done", version, sizeMB: found.sizeMB });
  return { ok: true, canceled: false };
}
