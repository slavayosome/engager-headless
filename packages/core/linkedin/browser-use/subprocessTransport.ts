import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BROWSER_USE_PROTOCOL_VERSION,
  BrowserUseReadyEventSchema,
  BrowserUseRequestSchema,
  BrowserUseResponseSchema,
  type BrowserUseOperation,
  type BrowserUseRequest,
  type BrowserUseResponse,
} from "./protocol";
import {
  BrowserUseProfileInUseError,
  BrowserUseTimeoutError,
  BrowserUseTransportError,
  DEFAULT_TIMEOUT_MS,
  type BrowserUseRequestOptions,
  type BrowserUseTransport,
} from "./client";

/**
 * The subprocess half of the browser-use transport: a long-lived NDJSON sidecar
 * over `uv run python bridge.py`.
 *
 * Split from `./client.ts`, which keeps the transport-independent protocol
 * client and its error taxonomy, because this module alone resolves the
 * `python/` project directory from `import.meta.url` and spawns a process.
 * `apps/dashboard/next.config.mjs` therefore keeps it webpack-ignored while the
 * bridge path beside it bundles: a Next server must never evaluate a holder's
 * lifecycle, and every process that MAY hold the sidecar (the agent, a
 * standalone MCP session, the worker's fallback, the spikes) imports this file
 * directly.
 */

const DEFAULT_MAX_FRAME_BYTES = 2 * 1024 * 1024;
const DEFAULT_SHUTDOWN_GRACE_MS = 3_000;
/**
 * Default: 0 — hold the profile for the life of the process.
 *
 * A profile can only be held by ONE process (the python journal takes a
 * non-blocking flock), and the two that want it want opposite things. A
 * background sweep is browser → model → browser with minutes of inference
 * between the halves, so releasing on idle tears Chrome down MID-RUN and the
 * next step meets a cold start the sidecar's own 30s BrowserStartEvent budget
 * will not wait for. The interactive server has the opposite problem: it
 * probes once and then idles for as long as the dashboard is open, which is
 * how a queued Brain seed found the profile busy forever.
 *
 * So yielding is opt-in, per process, by whoever should yield:
 * `ENGAGER_BROWSER_IDLE_RELEASE_MS` (config.browserUse.idleReleaseMs). The
 * dashboard sets it for its chat MCP child; the job worker leaves it unset.
 */
const DEFAULT_IDLE_RELEASE_MS = 0;
/**
 * Budget for the sidecar to close its BROWSER — Chrome's own close, not a
 * message round trip. Spent two ways: waiting for the `shutdown` an idle
 * release asks for, and holding off the reap's first signal after an EOF,
 * which is how an orderly exit reaches a sidecar nobody asked first.
 *
 * It must EXCEED the sidecar's own `BROWSER_SHUTDOWN_BUDGET_S` (25s, in
 * `backend.py`), which bounds asking Chromium politely and then forcing it. A
 * budget below that signals a sidecar mid-teardown — the interruption the whole
 * graceful close exists to end — and, because a group SIGTERM reaches the
 * sidecar too, would land it while its own close is still running.
 */
const DEFAULT_IDLE_SHUTDOWN_MS = 30_000;
/** How long a start waits for another process to give the profile back before
 *  refusing. It must outlast the other side's idle release (the interactive
 *  server's is a minute) plus whatever it is finishing, so a background sweep
 *  waits the handover out instead of refusing a run the owner just pressed.
 *  Bounded so a truly stuck holder still surfaces as a readable refusal. */
const DEFAULT_PROFILE_WAIT_MS = 180_000;
/** Enough of a startup failure to classify and to show a human; a sidecar that
 *  dies mid-traceback must not be able to hold a megabyte of it per generation. */
const MAX_STARTUP_STDERR_CHARS = 8_192;

export type BrowserUseSubprocessOptions = {
  /** Defaults to `ENGAGER_UV_BIN`, then `uv`; passed directly to spawn with
   *  shell:false. */
  uvCommand?: string;
  /** Defaults to the sibling `python/` directory. */
  pythonProjectDir?: string;
  /** Defaults to `<pythonProjectDir>/bridge.py`. */
  bridgePath?: string;
  /** Dedicated Browser Use profile; never a cookie/storage-state payload. */
  profileDir?: string;
  /** "true"/"false" forwarded as `--browser-hidden`; unset leaves the
   *  sidecar's own default (hidden) in charge. */
  browserHidden?: "true" | "false";
  /** Engager's own downloaded Chromium (US-OND-04), forwarded as
   *  `--browser-executable` — a stated entry, like the profile dir,
   *  never ambient env. Unset leaves the sidecar to find the installed
   *  build under `~/.engager/browser` itself; either way it runs
   *  exactly that one or refuses. */
  browserExecutable?: string;
  defaultTimeoutMs?: number;
  maxFrameBytes?: number;
  shutdownGraceMs?: number;
  /** Idle time before the sidecar exits and releases the browser profile;
   *  0 (or a non-finite value) keeps it for the life of the process. */
  idleReleaseMs?: number;
  /** How long a release waits for the browser to close before reaping. */
  idleShutdownMs?: number;
  /** Called as an idle release starts handing the profile back, for an owner
   *  that keeps its own record of whether a browser is open. */
  onIdleRelease?: () => void;
  coordinateIdleRelease?: (release: () => Promise<void>) => Promise<void>;
  /** How long a start waits out a profile another process holds; 0 refuses
   *  immediately, as it did before waiting existed. */
  profileWaitMs?: number;
  /** Explicit additions only. The process does not inherit arbitrary secrets. */
  env?: Readonly<Record<string, string | undefined>>;
  onStderr?: (chunk: string) => void;
  /** Test seam for process lifecycle tests. */
  spawnImpl?: typeof spawn;
};

type PendingRequest = {
  generation: number;
  op: BrowserUseOperation;
  resolve: (response: BrowserUseResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  signal?: AbortSignal;
  onAbort?: () => void;
};

type ReadyWaiter = {
  generation: number;
  child: ChildProcessWithoutNullStreams;
  resolve: (child: ChildProcessWithoutNullStreams) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type LaunchWaiter = {
  generation: number;
  child: ChildProcessWithoutNullStreams;
  reject: (error: Error) => void;
};

type ReapingGeneration = {
  generation: number;
  child: ChildProcessWithoutNullStreams;
  promise: Promise<void>;
};

const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "UV_CACHE_DIR",
  // Read-only installs (npm global, brew Cellar): the sidecar venv must land
  // OUTSIDE the package dir; the CLI sets this in packaged mode.
  "UV_PROJECT_ENVIRONMENT",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
] as const;

/**
 * Browser Use must not receive the Engager server's database, billing, provider,
 * or API credentials by ambient process inheritance. Model keys, if a future
 * read-side recovery path needs one, must be passed explicitly in `extra`.
 */
export function browserUseChildEnv(
  extra: Readonly<Record<string, string | undefined>> = {},
): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV ?? "development",
  };
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) safe[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) safe[key] = value;
  }
  // These safety settings always win over ambient or explicit additions.
  safe.ANONYMIZED_TELEMETRY = "false";
  safe.PYTHONUNBUFFERED = "1";
  // The sidecar's project dir lives INSIDE the signed app bundle in the
  // packaged app, and CPython writes `__pycache__/*.pyc` beside every imported
  // module by default — the exact post-launch signature break the native
  // acceptance reproduced (`Resources/cli/dist/python/engager_browser_use/
  // __pycache__`). A forced entry, not an allowlist key, so the policy reaches
  // Python through `uv` whatever the ambient environment says; the sidecar is
  // long-lived, so the one-time compile cost is not on a hot path.
  safe.PYTHONDONTWRITEBYTECODE = "1";
  return safe;
}

function abortError(): Error {
  const error = new Error("Browser Use request was aborted");
  error.name = "AbortError";
  return error;
}

/** How a locked profile identifies itself on the only wire it has — the
 *  message half of `SidecarError("JOURNAL_LOCKED", "journal is already in use:
 *  <path>")`, printed by bridge.py's startup guard. */
const PROFILE_LOCKED_STDERR = /journal is already in use/;

/** Long-lived, private NDJSON transport over a directly-spawned uv process. */
export class SubprocessBrowserUseTransport implements BrowserUseTransport {
  private readonly uvCommand: string;
  private readonly pythonProjectDir: string;
  private readonly bridgePath: string;
  private readonly profileDir?: string;
  private readonly browserHidden?: "true" | "false";
  private readonly browserExecutable?: string;
  private readonly defaultTimeoutMs: number;
  private readonly maxFrameBytes: number;
  private readonly shutdownGraceMs: number;
  private readonly idleReleaseMs: number;
  private readonly idleShutdownMs: number;
  private readonly onIdleRelease?: () => void;
  private readonly coordinateIdleRelease?: (release: () => Promise<void>) => Promise<void>;
  private readonly profileWaitMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly onStderr: (chunk: string) => void;
  private readonly spawnImpl: typeof spawn;

  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<ChildProcessWithoutNullStreams> | null = null;
  private startingGeneration: number | null = null;
  private activeGeneration: number | null = null;
  private nextGeneration = 0;
  private launchWaiter: LaunchWaiter | null = null;
  private readyWaiter: ReadyWaiter | null = null;
  private reaping: ReapingGeneration | null = null;
  private lifecycleFailure: BrowserUseTransportError | null = null;
  private readonly stdoutBuffers = new Map<number, Buffer>();
  private readonly startupStderr = new Map<number, string>();
  private readonly pending = new Map<string, PendingRequest>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private releasing: Promise<void> | null = null;
  /** True between the first refused start and the one that succeeds — the seam
   *  that keeps a wait to one log line and silences the child's repeat. */
  private waitingForProfile = false;
  private closing = false;

  constructor(options: BrowserUseSubprocessOptions = {}) {
    const defaultProjectDir = fileURLToPath(
      new URL("./python/", import.meta.url),
    );
    this.uvCommand = options.uvCommand ?? process.env.ENGAGER_UV_BIN ?? "uv";
    this.pythonProjectDir = options.pythonProjectDir ?? defaultProjectDir;
    this.bridgePath =
      options.bridgePath ?? resolvePath(this.pythonProjectDir, "bridge.py");
    this.profileDir = options.profileDir;
    this.browserHidden = options.browserHidden;
    this.browserExecutable = options.browserExecutable;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.shutdownGraceMs =
      options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    this.idleReleaseMs = options.idleReleaseMs ?? DEFAULT_IDLE_RELEASE_MS;
    // How long the handover waits for the browser to actually close. Generous
    // on purpose: hurrying it is what orphaned a Chrome onto the profile.
    this.idleShutdownMs = options.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS;
    this.onIdleRelease = options.onIdleRelease;
    this.coordinateIdleRelease = options.coordinateIdleRelease;
    this.profileWaitMs = options.profileWaitMs ?? DEFAULT_PROFILE_WAIT_MS;
    this.env = browserUseChildEnv(options.env);
    this.onStderr =
      options.onStderr ??
      ((chunk) => {
        // A wait already said so once; every retry's copy of the same line is
        // noise that hid the real failures in the same log.
        if (this.waitingForProfile && PROFILE_LOCKED_STDERR.test(chunk)) return;
        process.stderr.write(`[browser-use] ${chunk}`);
      });
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  async send(
    rawRequest: BrowserUseRequest,
    options: BrowserUseRequestOptions = {},
  ): Promise<BrowserUseResponse> {
    if (this.closing) {
      throw new BrowserUseTransportError("Browser Use transport is closing");
    }
    // A request in flight must never meet an idle release halfway, and one that
    // arrives DURING a release waits for the browser to be down before it
    // starts a replacement — two Chromes on one profile is the deadlock this
    // whole mechanism exists to avoid.
    this.disarmIdleRelease();
    if (this.releasing) await this.releasing;
    const request = BrowserUseRequestSchema.parse(rawRequest);
    if (this.pending.has(request.id)) {
      throw new BrowserUseTransportError(
        `Duplicate Browser Use request id: ${request.id}`,
      );
    }
    if (options.signal?.aborted) throw abortError();

    const child = await this.ensureStarted();
    const generation = this.activeGeneration;
    if (
      this.closing ||
      generation === null ||
      this.child !== child
    ) {
      throw new BrowserUseTransportError("Browser Use transport is closing");
    }
    if (options.signal?.aborted) throw abortError();
    const encoded = Buffer.from(`${JSON.stringify(request)}\n`, "utf8");
    if (encoded.byteLength > this.maxFrameBytes) {
      throw new BrowserUseTransportError(
        `Browser Use request frame exceeds ${this.maxFrameBytes} bytes`,
      );
    }
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new BrowserUseTransportError("Browser Use timeout must be positive");
    }

    return new Promise<BrowserUseResponse>((resolve, reject) => {
      const pending: PendingRequest = {
        generation,
        op: request.op,
        resolve,
        reject,
        timer: null,
        signal: options.signal,
      };
      const failAmbiguousRequest = (error: Error) => {
        if (!this.pending.has(request.id)) return;
        // The child may still finish an action and emit a late response. Tear the
        // session down so a caller must restart and reconcile instead of treating
        // the next frame as authoritative for a new request.
        this.failProcess(error, child, generation);
      };
      pending.timer = setTimeout(
        () => failAmbiguousRequest(new BrowserUseTimeoutError(timeoutMs)),
        timeoutMs,
      );
      pending.timer.unref?.();
      if (options.signal) {
        pending.onAbort = () => failAmbiguousRequest(abortError());
        options.signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.pending.set(request.id, pending);

      child.stdin.write(encoded, (error) => {
        if (error) {
          failAmbiguousRequest(
            new BrowserUseTransportError(
              "Failed to write to Browser Use subprocess",
              { cause: error },
            ),
          );
        }
      });
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    this.disarmIdleRelease();
    const launch = this.launchWaiter;
    const closeError = new BrowserUseTransportError(
      "Browser Use transport closed during startup",
    );
    if (launch) launch.reject(closeError);
    const child = this.child ?? launch?.child ?? null;
    const generation =
      this.child === child ? this.activeGeneration : launch?.generation ?? null;
    const closed = new BrowserUseTransportError(
      "Browser Use transport closed",
    );
    this.rejectAll(closed);

    if (child && generation !== null) {
      if (this.child === child && this.activeGeneration === generation) {
        this.child = null;
        this.activeGeneration = null;
      }
      if (
        this.launchWaiter?.child === child &&
        this.launchWaiter.generation === generation
      ) {
        this.launchWaiter = null;
      }
      this.stdoutBuffers.delete(generation);
      this.rejectReady(closed, child, generation);

      // A ChildProcess that never reached `spawn` has no OS generation to reap.
      // Cancel it and return; a spawned child must cross the full exit barrier.
      if (child.pid == null) {
        child.kill("SIGTERM");
      } else {
        this.beginReap(child, generation, "eof");
      }
    }

    const reap = this.reaping;
    if (reap) await reap.promise;
  }

  /**
   * Start the sidecar, WAITING OUT a profile another process still holds.
   *
   * One machine has one browser profile and several honest claimants: the job
   * worker mid-sweep, the interactive server answering the owner. The journal's
   * flock makes the loser fail instantly, which turned an ordinary overlap of a
   * few seconds into `Could not — profile_in_use` on a run the owner had just
   * pressed. Waiting is what a single shared resource deserves: hold-ups are
   * short (a holder releases at the end of its job), and a wait that outlives
   * the budget still ends in the same honest refusal.
   */
  private async ensureStarted(): Promise<ChildProcessWithoutNullStreams> {
    if (this.lifecycleFailure) throw this.lifecycleFailure;
    if (this.starting) return this.starting;
    if (this.child) return this.child;
    if (this.profileWaitMs <= 0) return this.startOnce();
    const startedWaiting = Date.now();
    const deadline = startedWaiting + this.profileWaitMs;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const child = await this.startOnce();
        if (this.waitingForProfile) {
          this.waitingForProfile = false;
          const waited = Math.round((Date.now() - startedWaiting) / 1000);
          process.stderr.write(
            `[browser-use] browser profile acquired after ${waited}s\n`,
          );
        }
        return child;
      } catch (error) {
        const remaining = deadline - Date.now();
        if (!(error instanceof BrowserUseProfileInUseError) || remaining <= 0) {
          this.waitingForProfile = false;
          throw error;
        }
        // ONE line per wait, not one per attempt: the child announces the
        // locked journal on its own stderr every time it dies, and a 90s wait
        // printed it often enough to bury the errors that mattered.
        if (!this.waitingForProfile) {
          this.waitingForProfile = true;
          process.stderr.write(
            "[browser-use] browser profile is held by another process — waiting\n",
          );
        }
        // Backs off to a second, because the thing being waited for is another
        // process finishing a browser step, not a network blip.
        const wait = Math.min(250 * 2 ** attempt, 1_000, remaining);
        await new Promise((resolve) => setTimeout(resolve, wait));
        if (this.closing) {
          throw new BrowserUseTransportError("Browser Use transport is closing");
        }
      }
    }
  }

  private async startOnce(): Promise<ChildProcessWithoutNullStreams> {
    if (this.lifecycleFailure) throw this.lifecycleFailure;
    if (this.starting) return this.starting;
    if (this.child) return this.child;

    // A failed child may still own Chrome and the local journal. Never overlap
    // generations: wait until `exit`, or fail this transport permanently if the
    // child survives bounded SIGTERM -> SIGKILL escalation.
    const reap = this.reaping;
    if (reap) {
      await reap.promise;
      if (this.lifecycleFailure) throw this.lifecycleFailure;
      if (this.closing) {
        throw new BrowserUseTransportError("Browser Use transport is closing");
      }
      return this.startOnce();
    }
    if (this.closing) {
      throw new BrowserUseTransportError("Browser Use transport is closing");
    }

    const generation = ++this.nextGeneration;
    this.startingGeneration = generation;
    this.starting = new Promise<ChildProcessWithoutNullStreams>(
      (resolve, reject) => {
        const args = [
          "run",
          "--project",
          this.pythonProjectDir,
          "--locked",
          "python",
          "-u",
          this.bridgePath,
        ];
        if (this.profileDir) args.push("--profile-dir", this.profileDir);
        if (this.browserExecutable) {
          args.push("--browser-executable", this.browserExecutable);
        }
        if (this.browserHidden) {
          args.push("--browser-hidden", this.browserHidden);
        }
        const child = this.spawnImpl(this.uvCommand, args, {
          cwd: this.pythonProjectDir,
          env: this.env,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        });

        let settled = false;
        const resolveStart = (readyChild: ChildProcessWithoutNullStreams) => {
          if (settled) return;
          settled = true;
          if (
            this.launchWaiter?.child === child &&
            this.launchWaiter.generation === generation
          ) {
            this.launchWaiter = null;
          }
          if (this.startingGeneration === generation) {
            this.starting = null;
            this.startingGeneration = null;
          }
          resolve(readyChild);
        };
        const rejectStart = (error: Error) => {
          if (settled) return;
          settled = true;
          if (
            this.launchWaiter?.child === child &&
            this.launchWaiter.generation === generation
          ) {
            this.launchWaiter = null;
          }
          if (this.startingGeneration === generation) {
            this.starting = null;
            this.startingGeneration = null;
          }
          reject(error);
        };
        this.launchWaiter = { generation, child, reject: rejectStart };

        const startupError = (error: Error) => {
          rejectStart(
            new BrowserUseTransportError(
              "Could not start the Browser Use subprocess",
              { cause: error },
            ),
          );
        };
        child.once("error", startupError);
        child.once("spawn", () => {
          child.off("error", startupError);
          if (
            settled ||
            this.closing ||
            this.startingGeneration !== generation ||
            this.launchWaiter?.generation !== generation
          ) {
            rejectStart(
              new BrowserUseTransportError(
                "Stale Browser Use subprocess generation was discarded",
              ),
            );
            child.kill("SIGTERM");
            return;
          }
          this.child = child;
          this.activeGeneration = generation;
          this.stdoutBuffers.set(generation, Buffer.alloc(0));
          this.startupStderr.set(generation, "");
          const timer = setTimeout(() => {
            this.failProcess(
              new BrowserUseTimeoutError(this.defaultTimeoutMs),
              child,
              generation,
            );
          }, this.defaultTimeoutMs);
          timer.unref?.();
          this.readyWaiter = {
            generation,
            child,
            resolve: resolveStart,
            reject: rejectStart,
            timer,
          };
          this.attachChild(child, generation);
        });
      },
    );
    return this.starting;
  }

  private attachChild(
    child: ChildProcessWithoutNullStreams,
    generation: number,
  ): void {
    child.stdout.on("data", (chunk: Buffer | string) => {
      if (!this.isActive(child, generation)) return;
      this.onStdout(
        child,
        generation,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      );
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      // Kept by GENERATION rather than behind the active-child guard: `exit`
      // clears the active generation while stderr may still be draining, and
      // the sidecar's startup diagnosis is exactly what would be dropped.
      this.noteStartupStderr(generation, text);
      if (!this.isActive(child, generation)) return;
      this.onStderr(text);
    });
    child.once("error", (error) => {
      if (!this.isActive(child, generation)) return;
      this.failProcess(
        new BrowserUseTransportError("Browser Use subprocess failed", {
          cause: error,
        }),
        child,
        generation,
      );
    });
    child.once("exit", (code, signal) => {
      if (!this.isActive(child, generation)) return;
      this.child = null;
      this.activeGeneration = null;
      this.stdoutBuffers.delete(generation);
      this.rejectReadyOnStartupFailure(child, generation, code, signal);
      this.rejectGeneration(
        generation,
        new BrowserUseTransportError(
          `Browser Use subprocess exited before responding (code=${code ?? "null"}, signal=${signal ?? "null"})`,
        ),
      );
    });
  }

  /** A bounded head of one generation's PRE-READY stderr. The entry only
   *  exists between `spawn` and the ready event, so a healthy sidecar's
   *  diagnostics are forwarded and forgotten as they always were. */
  private noteStartupStderr(generation: number, text: string): void {
    const seen = this.startupStderr.get(generation);
    if (seen === undefined || seen.length >= MAX_STARTUP_STDERR_CHARS) return;
    this.startupStderr.set(
      generation,
      (seen + text).slice(0, MAX_STARTUP_STDERR_CHARS),
    );
  }

  /**
   * Fail a generation that died before it was ever ready, in the sidecar's own
   * words.
   *
   * `exit` is not the moment those words are complete — stderr may still be
   * draining, and a locked browser profile says so THERE and nowhere else, so
   * rejecting on `exit` classifies "another Engager already has your browser"
   * as an anonymous crash. The wait is bounded by the shutdown grace because
   * the ready timer is no longer a backstop: it calls `failProcess`, which
   * returns the moment `exit` cleared the active child.
   */
  private rejectReadyOnStartupFailure(
    child: ChildProcessWithoutNullStreams,
    generation: number,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    const waiter = this.readyWaiter;
    if (!waiter || waiter.child !== child || waiter.generation !== generation) {
      this.startupStderr.delete(generation);
      return;
    }
    let grace: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      if (grace) clearTimeout(grace);
      child.off("close", settle);
      const stderr = (this.startupStderr.get(generation) ?? "").trim();
      this.rejectReady(
        PROFILE_LOCKED_STDERR.test(stderr)
          ? new BrowserUseProfileInUseError(stderr)
          : new BrowserUseTransportError(
              `Browser Use subprocess exited before ready (code=${code ?? "null"}, signal=${signal ?? "null"})`,
            ),
        child,
        generation,
      );
    };
    grace = setTimeout(settle, this.shutdownGraceMs);
    grace.unref?.();
    child.once("close", settle);
  }

  private onStdout(
    child: ChildProcessWithoutNullStreams,
    generation: number,
    chunk: Buffer,
  ): void {
    if (!this.isActive(child, generation)) return;
    let stdoutBuffer = Buffer.concat([
      this.stdoutBuffers.get(generation) ?? Buffer.alloc(0),
      chunk,
    ]);
    this.stdoutBuffers.set(generation, stdoutBuffer);
    if (
      stdoutBuffer.byteLength > this.maxFrameBytes &&
      !stdoutBuffer.includes(0x0a)
    ) {
      this.failProcess(
        new BrowserUseTransportError(
          `Browser Use response frame exceeds ${this.maxFrameBytes} bytes`,
        ),
        child,
        generation,
      );
      return;
    }

    while (true) {
      const newline = stdoutBuffer.indexOf(0x0a);
      if (newline < 0) return;
      const frame = stdoutBuffer.subarray(0, newline);
      stdoutBuffer = stdoutBuffer.subarray(newline + 1);
      this.stdoutBuffers.set(generation, stdoutBuffer);
      if (frame.byteLength === 0) continue;
      if (frame.byteLength > this.maxFrameBytes) {
        this.failProcess(
          new BrowserUseTransportError(
            `Browser Use response frame exceeds ${this.maxFrameBytes} bytes`,
          ),
          child,
          generation,
        );
        return;
      }
      this.acceptFrame(child, generation, frame);
      if (!this.isActive(child, generation)) return;
    }
  }

  private acceptFrame(
    child: ChildProcessWithoutNullStreams,
    generation: number,
    frame: Buffer,
  ): void {
    if (!this.isActive(child, generation)) return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(frame.toString("utf8"));
    } catch (error) {
      this.failProcess(
        new BrowserUseTransportError(
          "Browser Use subprocess emitted invalid NDJSON",
          { cause: error },
        ),
        child,
        generation,
      );
      return;
    }

    const ready = BrowserUseReadyEventSchema.safeParse(decoded);
    if (ready.success) {
      const waiter = this.readyWaiter;
      if (
        !waiter ||
        waiter.child !== child ||
        waiter.generation !== generation
      ) {
        this.failProcess(
          new BrowserUseTransportError(
            "Browser Use subprocess emitted an unexpected ready event",
          ),
          child,
          generation,
        );
        return;
      }
      clearTimeout(waiter.timer);
      this.readyWaiter = null;
      this.startupStderr.delete(generation);
      waiter.resolve(waiter.child);
      return;
    }

    const parsed = BrowserUseResponseSchema.safeParse(decoded);
    if (!parsed.success) {
      this.failProcess(
        new BrowserUseTransportError(
          `Browser Use subprocess violated protocol v${BROWSER_USE_PROTOCOL_VERSION}: ${parsed.error.message}`,
        ),
        child,
        generation,
      );
      return;
    }
    const response = parsed.data;
    const pending = this.pending.get(response.id);
    if (
      !pending ||
      pending.generation !== generation ||
      pending.op !== response.op
    ) {
      this.failProcess(
        new BrowserUseTransportError(
          "Browser Use subprocess returned an unknown or mismatched response",
        ),
        child,
        generation,
      );
      return;
    }
    this.pending.delete(response.id);
    this.cleanupPending(pending);
    pending.resolve(response);
  }

  private failProcess(
    error: Error,
    expectedChild: ChildProcessWithoutNullStreams,
    generation: number,
  ): void {
    if (!this.isActive(expectedChild, generation)) return;
    const child = expectedChild;
    this.child = null;
    this.activeGeneration = null;
    this.stdoutBuffers.delete(generation);
    this.rejectReady(error, child, generation);
    // Install the reap barrier before rejecting request promises. An immediate
    // retry therefore observes `reaping` and cannot spawn a replacement first.
    this.beginReap(child, generation, "sigterm");
    this.rejectGeneration(generation, error);
  }

  private beginReap(
    child: ChildProcessWithoutNullStreams,
    generation: number,
    initialAction: "sigterm" | "eof",
  ): void {
    const existing = this.reaping;
    if (existing) {
      if (existing.child === child && existing.generation === generation) return;
      this.lifecycleFailure = new BrowserUseTransportError(
        "Browser Use attempted to reap overlapping subprocess generations",
      );
      return;
    }

    let state: ReapingGeneration;
    const promise = this.reapChild(child, generation, initialAction)
      .catch((error: unknown) => {
        this.lifecycleFailure =
          error instanceof BrowserUseTransportError
            ? error
            : new BrowserUseTransportError(
                "Browser Use subprocess could not be reaped",
                { cause: error },
              );
      })
      .finally(() => {
        if (this.reaping === state) this.reaping = null;
      });
    state = { child, generation, promise };
    this.reaping = state;
  }

  private reapChild(
    child: ChildProcessWithoutNullStreams,
    generation: number,
    initialAction: "sigterm" | "eof",
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let escalationTimer: ReturnType<typeof setTimeout> | null = null;
      let killTimer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (escalationTimer) clearTimeout(escalationTimer);
        if (killTimer) clearTimeout(killTimer);
        child.off("exit", onExit);
      };
      const finish = (error?: BrowserUseTransportError) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onExit = () => finish();

      if (child.exitCode !== null || child.signalCode !== null) {
        finish();
        return;
      }
      child.once("exit", onExit);

      const sendSigkill = () => {
        if (settled) return;
        child.kill("SIGKILL");
        if (settled) return;
        killTimer = setTimeout(() => {
          finish(
            new BrowserUseTransportError(
              `Browser Use subprocess generation ${generation} did not exit after SIGKILL`,
            ),
          );
        }, this.shutdownGraceMs);
        killTimer.unref?.();
      };
      const sendSigterm = () => {
        if (settled) return;
        child.kill("SIGTERM");
        if (settled) return;
        escalationTimer = setTimeout(sendSigkill, this.shutdownGraceMs);
        escalationTimer.unref?.();
      };

      if (initialAction === "eof") {
        child.stdin.end();
        if (settled) return;
        // The SHUTDOWN budget, not the signal grace. EOF is how an orderly exit
        // reaches the sidecar — the bridge's read loop ends and `service.close`
        // runs — and what it does there is close Chromium and WAIT for the
        // process to go (`backend._close_local_browser`). Three seconds is a
        // signal escalation's budget, not a browser's: it SIGTERMed a Chromium
        // that was still flushing, which is how a sign-in the owner had just
        // completed never reached the profile's cookie store (measured
        // 2026-09-15). A sidecar that has not finished by the shutdown budget
        // is a stuck one, and the escalation below is still there for it.
        escalationTimer = setTimeout(sendSigterm, this.idleShutdownMs);
        escalationTimer.unref?.();
      } else {
        sendSigterm();
      }
    });
  }

  private rejectReady(
    error: Error,
    child: ChildProcessWithoutNullStreams,
    generation: number,
  ): void {
    const waiter = this.readyWaiter;
    if (
      !waiter ||
      waiter.child !== child ||
      waiter.generation !== generation
    ) {
      return;
    }
    clearTimeout(waiter.timer);
    this.readyWaiter = null;
    this.startupStderr.delete(generation);
    waiter.reject(error);
  }

  private rejectGeneration(generation: number, error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.generation !== generation) continue;
      this.pending.delete(id);
      this.cleanupPending(pending);
      pending.reject(error);
    }
  }

  private isActive(
    child: ChildProcessWithoutNullStreams,
    generation: number,
  ): boolean {
    return this.child === child && this.activeGeneration === generation;
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      this.cleanupPending(pending);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private cleanupPending(pending: PendingRequest): void {
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
    // Every settle path funnels through here, so this is the one place that has
    // to notice the transport just went quiet.
    this.armIdleRelease();
  }

  /** Start (or restart) the countdown to handing the profile back. Idempotent,
   *  and a no-op whenever something is in flight or there is nothing to hand
   *  back. */
  private armIdleRelease(): void {
    this.disarmIdleRelease();
    if (this.closing) return;
    if (!Number.isFinite(this.idleReleaseMs) || this.idleReleaseMs <= 0) return;
    if (this.pending.size > 0 || !this.child) return;
    this.idleTimer = setTimeout(() => void this.releaseIdle(), this.idleReleaseMs);
    this.idleTimer.unref?.();
  }

  private disarmIdleRelease(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /**
   * Retire the idle child so its journal flock — and the BROWSER PROFILE behind
   * it — go back to whoever needs them next. NOT `close()`: the transport stays
   * usable, and the next `send` starts a fresh generation.
   *
   * It asks for a `shutdown` first and waits for the answer, because the flock
   * is not the only lock. Chrome holds its own on the user-data-dir, and it
   * outlives a sidecar that was merely killed: EOF plus a 3s SIGTERM
   * escalation orphaned a Chrome that was still closing, the next process took
   * the freed journal, and its launch then hung on a directory the orphan still
   * owned — 30s of `BrowserStartEvent` timeout per attempt. `shutdown` closes
   * the browser inside the sidecar (backend.shutdown → browser.stop) and only
   * then does the process go.
   */
  /**
   * Retire the child there is and start none, for a holder handing the profile
   * to another: the journal must be free when this returns, and a `shutdown`
   * sent to a transport with no child would spawn one to stop it. Whether the
   * browser looked ready says nothing about it; a child that answered
   * `BROWSER_UNAVAILABLE` still holds the journal. Throws when the child is
   * still there, or would not exit.
   */
  async retire(): Promise<void> {
    if (this.releasing) await this.releasing;
    await this.starting?.catch(() => undefined);
    await this.reaping?.promise;
    await this.releaseIdleNow();
    if (this.lifecycleFailure) throw this.lifecycleFailure;
    if (this.child) throw new BrowserUseTransportError("Browser Use subprocess is still running");
  }

  private async releaseIdle(): Promise<void> {
    this.idleTimer = null;
    if (this.coordinateIdleRelease) {
      await this.coordinateIdleRelease(() => this.releaseIdleNow());
      this.armIdleRelease();
      return;
    }
    await this.releaseIdleNow();
  }

  private async releaseIdleNow(): Promise<void> {
    if (this.closing || this.starting || this.reaping || this.releasing) return;
    if (this.pending.size > 0 || !this.child || this.activeGeneration === null) {
      return;
    }
    this.onIdleRelease?.();
    const release = (async () => {
      try {
        await this.send(
          { v: BROWSER_USE_PROTOCOL_VERSION, id: randomUUID(), op: "shutdown", params: {} },
          { timeoutMs: this.idleShutdownMs },
        );
      } catch {
        // A sidecar that cannot answer is one the reap below handles anyway.
      }
      const child = this.child;
      const generation = this.activeGeneration;
      if (!child || generation === null) return; // it exited on its own
      this.child = null;
      this.activeGeneration = null;
      this.stdoutBuffers.delete(generation);
      if (child.pid == null) child.kill("SIGTERM");
      else this.beginReap(child, generation, "eof");
      await this.reaping?.promise;
    })();
    // Cleared against the promise stored, not `release`: comparing with the
    // inner one never matched, so the first release left `releasing` set and
    // every sidecar started after it kept the profile for good.
    const releasing = release.finally(() => {
      if (this.releasing === releasing) this.releasing = null;
    });
    this.releasing = releasing;
    await releasing;
  }
}
