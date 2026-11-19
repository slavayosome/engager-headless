import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { agentFailure } from "./state";

/**
 * One bounded metadata invocation. It is deliberately NOT `inspectExecutable`:
 * that probe runs with an empty `HOME` and answers a question about the BINARY
 * (does this version implement the flags Engager's argv needs), while a model
 * list answers a question about the INSTALLATION — which needs a real config
 * root and, on some routes, the network. Keeping them separate is what lets
 * §5 keep the version probe hermetic without making the catalog lie about
 * account-specific availability.
 *
 * What this profile does NOT do, and must never grow into: inherit the
 * caller's environment, read an auth file, load project configuration, or
 * accept an argv fragment from its caller. The caller is an adapter, and the
 * argv is an argument array this module itself never interprets.
 */
export type MetadataProbeOptions = {
  args: readonly string[];
  /** Metadata protocol messages only, never a user prompt. */
  input?: string;
  /** A protocol that initializes before listing can send the next message or
   * close stdin when its final response arrives. */
  onLine?: (line: string) => { input?: string; closeInput?: boolean } | undefined;
  /** Extra environment for the child, merged over the private baseline. A
   *  PARTIAL map on purpose: this is a set of additions, not a whole
   *  environment, and `ProcessEnv`'s required `NODE_ENV` would make every
   *  caller restate a baseline it does not own. */
  env?: Readonly<Record<string, string>>;
  timeoutMs: number;
  signal: AbortSignal;
  /** Bytes of stdout retained. Past this the probe is cut off and reported as
   *  partial rather than parsed from a truncated document. */
  maxBytes?: number;
};

export type MetadataProbeResult = {
  stdout: string;
  /** The probe exceeded its bound, or its output exceeded `maxBytes`. */
  truncated: boolean;
};

const DEFAULT_MAX_BYTES = 256 * 1024;

/**
 * A private working directory and HOME for one metadata probe, so an agent
 * cannot read the owner's project configuration merely because Engager asked
 * it a question. Callers that genuinely need the owner's own config root pass
 * it explicitly in `env`.
 */
export async function metadataHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "engager-metadata-"));
}

export async function removeMetadataHome(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

/**
 * Run one bounded metadata command to completion. A non-zero exit is the
 * caller's to interpret — several agents exit non-zero for an empty list — so
 * this returns the code rather than throwing, and only a spawn failure or a
 * canceled/deadline-expired probe is an error.
 */
export async function runMetadataProbe(
  bin: string,
  options: MetadataProbeOptions,
): Promise<MetadataProbeResult & { code: number | null }> {
  const cwd = await metadataHome();
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(bin, [...options.args], {
        cwd,
        // Its own session, so a probe that spawns a helper is torn down with
        // it rather than outliving the request that asked the question.
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          HOME: cwd,
          PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
          TERM: "dumb",
          NODE_ENV: "production",
          ...options.env,
        },
      });
      const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
      let stdout = "";
      let bytes = 0;
      let truncated = false;
      let settled = false;
      let pendingLine = "";
      const killGroup = (signal: NodeJS.Signals) => {
        if (child.pid) {
          try {
            process.kill(-child.pid, signal);
          } catch {}
        }
      };
      const finish = (result: MetadataProbeResult, code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal.removeEventListener("abort", onAbort);
        resolve({ ...result, code });
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal.removeEventListener("abort", onAbort);
        reject(error);
      };
      const onAbort = () => {
        killGroup("SIGKILL");
        // The group is reaped on the same bounded wait the deadline path uses
        // before the cancellation is reported, so a canceled probe cannot leave
        // a helper behind.
        void boundedTeardown(child.pid).finally(() =>
          fail(agentFailure("agent_canceled")),
        );
      };
      const timer = setTimeout(() => {
        truncated = true;
        // The deadline is a normal answer for a metadata probe: the caller
        // reports what it managed to read rather than withholding the screen.
        // It still waits for the group, so a probe cannot outlive the scan.
        killGroup("SIGKILL");
        void boundedTeardown(child.pid).then(() => finish({ stdout, truncated }, null));
      }, options.timeoutMs);
      options.signal.addEventListener("abort", onAbort, { once: true });
      if (options.signal.aborted) onAbort();
      child.stdin.on("error", () => {}); // Early exit is reported by close.
      if (options.onLine) {
        if (options.input) child.stdin.write(options.input);
      } else child.stdin.end(options.input);
      child.stdout.on("data", (part: Buffer) => {
        bytes += part.length;
        if (bytes > maxBytes) {
          truncated = true;
          killGroup("SIGKILL");
        } else {
          stdout += part.toString();
          if (options.onLine) {
            pendingLine += part.toString();
            let newline;
            while ((newline = pendingLine.indexOf("\n")) >= 0) {
              const line = pendingLine.slice(0, newline);
              pendingLine = pendingLine.slice(newline + 1);
              try {
                const next = options.onLine(line);
                if (next?.input) child.stdin.write(next.input);
                if (next?.closeInput) child.stdin.end();
              } catch {
                killGroup("SIGKILL");
                fail(agentFailure("agent_metadata_invalid"));
                break;
              }
            }
          }
        }
      });
      // stderr can echo credentials or config. Count it against the SAME byte
      // bound as stdout and never retain it: a probe that floods stderr is a
      // probe this read refuses to keep waiting for.
      child.stderr.on("data", (part: Buffer) => {
        bytes += part.length;
        if (bytes > maxBytes) {
          truncated = true;
          killGroup("SIGKILL");
        }
      });
      child.on("error", () => fail(agentFailure("agent_spawn_failed")));
      child.on("close", (code) => finish({ stdout, truncated }, code));
    });
  } finally {
    await removeMetadataHome(cwd);
  }
}

/**
 * After a deadline kill, the group may still be tearing down. Wait boundedly
 * so a catalog read cannot leave a probe running behind it.
 */
async function boundedTeardown(pid: number | undefined): Promise<void> {
  if (!pid) return;
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0);
    } catch {
      return;
    }
    await delay(25);
  }
}

/** What an id read out of an agent's own configuration may look like. The same
 *  alphabet the selection request accepts: a model id, never a command. */
const CONFIGURED_MODEL_ID = /^(?=.{1,200}$)[\w.:@+/-]+(?:\[1m\])?$/;

/** A settings file is small; anything larger is not the document this reader
 *  understands, and the bound is checked BEFORE any of it is read. */
const CONFIGURED_FILE_MAX_BYTES = 1024 * 1024;

/** The caller's cancellation, and how much of a settings file may be read. */
export type ConfiguredReadOptions = {
  signal?: AbortSignal | undefined;
  maxBytes?: number | undefined;
};

/**
 * One configured-model file, read under a bound.
 *
 * The whole file used to be read and THEN size-checked, and a FIFO at that
 * path held every reader that touched it: this opens with `O_NONBLOCK` so a
 * non-regular file cannot block the open, refuses anything that is not a
 * regular file of a known size, and reads at most `maxBytes`. A canceled read
 * returns before it opens and after every chunk.
 */
export async function readConfiguredBounded(
  file: string,
  options: ConfiguredReadOptions,
): Promise<string | undefined> {
  if (options.signal?.aborted) return undefined;
  const maxBytes = options.maxBytes ?? CONFIGURED_FILE_MAX_BYTES;
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    const details = await handle.stat();
    if (!details.isFile() || details.size > maxBytes) return undefined;
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < maxBytes) {
      if (options.signal?.aborted) return undefined;
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * One narrowly parsed, non-secret configured model out of an agent's OWN
 * settings file — §6's step two, for an agent with no list protocol.
 *
 * The file is read as DATA and never as configuration to execute: `pick`
 * receives the parsed document and returns one field, so no hook, plugin,
 * project or remote setting is loaded, and nothing but the model id is
 * retained. A file that is missing, oversized, malformed, non-regular or
 * shaped differently is `undefined` — the honest fallback is the manual id
 * entry, not a guess.
 */
export async function readConfiguredModelFile(
  file: string,
  pick: (parsed: unknown) => unknown,
  options: ConfiguredReadOptions = {},
): Promise<string | undefined> {
  try {
    const text = await readConfiguredBounded(file, options);
    if (text === undefined) return undefined;
    const value = pick(JSON.parse(text));
    if (typeof value !== "string") return undefined;
    const id = value.trim();
    return CONFIGURED_MODEL_ID.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The same read for a TOML `key = "value"` pair, bounded to the TOP-LEVEL
 * table: scanning stops at the first `[table]` header, so a profile- or
 * project-scoped model can never be mistaken for the configured default. No
 * TOML parser is grown for one field, and no other key is retained.
 */
export async function readConfiguredTomlValue(
  file: string,
  key: string,
  options: ConfiguredReadOptions = {},
): Promise<string | undefined> {
  try {
    const text = await readConfiguredBounded(file, options);
    if (text === undefined) return undefined;
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
      `^\\s*${escaped}\\s*=\\s*(?:"([^"\\n]*)"|'([^'\\n]*)')\\s*(?:#.*)?$`,
    );
    for (const line of text.split("\n")) {
      if (/^\s*\[/.test(line)) return undefined;
      const match = pattern.exec(line);
      const value = (match?.[1] ?? match?.[2])?.trim();
      if (value !== undefined)
        return CONFIGURED_MODEL_ID.test(value) ? value : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** One key off a parsed document, for the readers above: a missing key and a
 *  document that is not an object are the same answer. */
export function configuredField(parsed: unknown, key: string): unknown {
  return typeof parsed === "object" && parsed !== null
    ? (parsed as Record<string, unknown>)[key]
    : undefined;
}
