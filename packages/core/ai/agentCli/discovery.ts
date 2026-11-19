import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  access,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type {
  AdapterDiscoveryDescriptor,
  LocalAgentDescriptor,
} from "./types";
import { executableVersionSupported } from "./types";
import { agentFailure } from "./state";

export const KNOWN_LOCAL_AGENTS = [
  "claude",
  "codex",
  "gemini",
  "opencode",
  "grok",
  "cursor",
  "openclaw",
  "hermes",
] as const;

/** §5's suggested bounds. They are limits, not targets: an inventory that
 *  finishes sooner returns sooner, and one that hits the deadline returns what
 *  it has rather than nothing. */
export const DISCOVERY_LIMITS = {
  concurrentProbes: 2,
  probeTimeoutMs: 5_000,
  scanTimeoutMs: 20_000,
  maxCandidates: 64,
  /** Version directories enumerated under a package manager's own root. */
  maxVersionDirectories: 16,
} as const;

/** The bounds a caller may tighten — for a test that cannot wait twenty
 *  seconds, and for an operation with a shorter budget of its own. */
export type DiscoveryLimits = {
  concurrentProbes: number;
  probeTimeoutMs: number;
  scanTimeoutMs: number;
  maxCandidates: number;
  maxVersionDirectories: number;
};

/** One installation an adapter's descriptor claims, already identified and
 *  version-probed. `absoluteExecutable` stays SERVER-SIDE: it is what the
 *  picker's opaque `candidateId` resolves back to, and sending it to a browser
 *  would turn a scan into an arbitrary-executable picker. */
export type DiscoveredInstallation = {
  candidateId: string;
  adapterId: string;
  displayName: string;
  absoluteExecutable: string;
  realPath: string;
  executableIdentity: string;
  observedVersion: string;
  /** Whether the descriptor admits this exact version. */
  versionSupported: boolean;
  /** Whether an adapter is registered to execute it at all. */
  adapterRegistered: boolean;
  /** Where it was found: `PATH`, `homebrew`, `npm_global`, `app_bundle`, … */
  location: string;
  reasonCodes: string[];
};

export type AgentInventoryScan = {
  installations: DiscoveredInstallation[];
  /** The scan deadline passed with probes still outstanding. */
  partial: boolean;
  warnings: string[];
};

/** Opaque, stable, and deterministic: the same real path yields the same id
 *  across scans, so a selection survives a rescan and a candidate id cannot be
 *  minted for a path discovery never returned. Exported so a SAVED selection
 *  can be matched to the candidate it is about — the alternative is a second
 *  copy of this hash, and the two would part on the first change. */
export function installationCandidateId(realPath: string): string {
  return createHash("sha256").update(realPath).digest("hex").slice(0, 32);
}


export async function executableIdentity(
  file: string,
  options: { signal?: AbortSignal | undefined } = {},
): Promise<{ realPath: string; executableIdentity: string }> {
  if (!isAbsolute(file)) throw agentFailure("agent_absolute_path_required");
  try {
    await access(file, constants.X_OK);
    const target = await realpath(file);
    if (!(await stat(target)).isFile())
      throw agentFailure("agent_executable_missing");
    const hash = createHash("sha256");
    // The hash is a full read of the file and the one filesystem step with no
    // natural bound, so a canceled scan must be able to stop it rather than
    // wait out a large binary: the stream takes the caller's signal.
    const stream = createReadStream(
      target,
      options.signal ? { signal: options.signal } : {},
    );
    for await (const part of stream) hash.update(part);
    return { realPath: target, executableIdentity: hash.digest("hex") };
  } catch {
    // A cancel is not "this file is missing": the caller distinguishes the two
    // with the signal it passed, so the distinction survives here as the same
    // error the other probe paths raise.
    if (options.signal?.aborted) throw agentFailure("agent_canceled");
    throw agentFailure("agent_executable_missing");
  }
}

/** Read-only inspection is bounded and never inherits provider credentials.
 *  Empty `HOME` is the point: this answers a question about the BINARY, and an
 *  owner's project configuration must not be able to change the answer.
 *
 * The bound is the caller's, because a scan's per-probe budget and an
 * installation's worth are different questions: discovery passes its own
 * deadline, and the durable verifiers keep the default. `timedOut` is reported
 * separately from a non-zero exit because the two mean opposite things — an
 * agent that did not answer inside the bound is a fact about the scan, while
 * an agent that answered and failed is a fact about the installation. */
export async function inspectExecutable(
  file: string,
  args: readonly string[],
  options: { timeoutMs?: number; signal?: AbortSignal | undefined } = {},
): Promise<{ stdout: string; timedOut: boolean; cutShort: boolean }> {
  const cwd = await mkdtemp(join(tmpdir(), "engager-inspect-"));
  const timeoutMs = options.timeoutMs ?? 5_000;
  try {
    return await new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(agentFailure("agent_canceled"));
        return;
      }
      const child = spawn(file, [...args], {
        cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          HOME: cwd,
          PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
          TERM: "dumb",
          NODE_ENV: "production",
        },
      });
      let output = "";
      let bytes = 0;
      let failed = false;
      let timedOut = false;
      // A stream this probe refused to keep reading. Distinct from `failed`,
      // which is a non-zero exit: an answer cut off at the bound is not an
      // answer, and a caller that parsed the prefix as one would report a
      // version scraped out of a truncated document.
      let cutShort = false;
      const stop = () => {
        failed = true;
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        }
      };
      const onAbort = () => stop();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);
      const settle = <T>(work: (code: number | null) => T) => {
        return (code: number | null): T => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          return work(code);
        };
      };
      child.stdout.on("data", (part: Buffer) => {
        bytes += part.length;
        if (bytes > 256 * 1024) {
          cutShort = true;
          stop();
        } else output += part.toString();
      });
      child.stderr.on("data", (part: Buffer) => {
        bytes += part.length;
        if (bytes > 256 * 1024) {
          cutShort = true;
          stop();
        }
      });
      child.on("error", () => {
        failed = true;
      });
      child.on(
        "close",
        settle((code) => {
          if (!failed && code === 0)
            resolve({ stdout: output, timedOut: false, cutShort: false });
          else if (timedOut)
            resolve({ stdout: output, timedOut: true, cutShort: false });
          else if (cutShort)
            resolve({ stdout: output, timedOut: false, cutShort: true });
          else reject(agentFailure("agent_inspection_failed"));
        }),
      );
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/** The `--version` line every adapter answers with, when it answers at all. */
export async function observedExecutableVersion(
  file: string,
): Promise<string | undefined> {
  try {
    const inspected = await inspectExecutable(file, ["--version"]);
    return inspected.stdout.match(/\b\d+\.\d+\.\d+\b/)?.[0];
  } catch {
    return undefined;
  }
}

/**
 * A search root and the roots one level under it.
 *
 * The subdirectory is what makes an explicit path useful: "here is my claude"
 * is answered by the directory HOLDING the binary, and an installation that
 * keeps several versions side by side keeps them in subdirectories of one
 * root. Enumerating that level is bounded — `maxEntries` — because the roots
 * exist but the count does not; the standard roots pass zero, since a machine
 * root like `/usr/bin` holds hundreds of entries and an agent name joined onto
 * its subdirectories is never where an agent lives.
 */
async function searchRoots(
  root: string,
  maxEntries: number,
): Promise<string[]> {
  if (maxEntries <= 0) return [root];
  let entries: string[];
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort()
      .slice(0, maxEntries);
  } catch {
    return [root];
  }
  return [root, ...entries.map((entry) => join(root, entry))];
}

/** Every search root worth probing: the standard installations in their own
 *  right, and one level under each explicit path the caller named. */
async function candidateDirectories(
  explicit: readonly string[],
  standard: readonly string[],
  maxEntries: number,
): Promise<string[]> {
  const expanded = await mapBounded(explicit, 8, (root) =>
    searchRoots(root, maxEntries),
  );
  return [...expanded.flat(), ...standard];
}

/**
 * The standard installation roots §5 documents, in order: the inherited PATH
 * first, then the machine-wide and package-manager directories a Finder launch
 * cannot see. Nothing here sources a shell startup file or runs a login shell,
 * so a launch that inherited almost no PATH still finds what it needs.
 *
 * `ENGAGER_AGENT_SEARCH_ROOTS` REPLACES the whole set with an explicit list —
 * PATH entries, home-relative package-manager directories and the literal
 * Homebrew/`/usr/bin` entries alike. It exists because the suite must never
 * probe the developer's own agent CLIs — a real `claude --version` is a live
 * provider call, and every test that scans would otherwise make one — so
 * `vitest.setup.ts` points it at a private directory. Stubbing `PATH` alone
 * would not do: the Homebrew and `/usr/bin` entries below are literals, and
 * those are exactly where a developer's agents live. Unset, the documented
 * behaviour is unchanged.
 */
export function standardSearchDirectories(): string[] {
  const override = searchRootOverride();
  if (override) return override;
  const home = homedir();
  return [
    ...(process.env.PATH ?? "")
      .split(delimiter)
      .filter((entry) => isAbsolute(entry)),
    join(home, ".npm-global", "bin"),
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".volta", "bin"),
    join(home, ".asdf", "shims"),
    join(home, ".local", "share", "mise", "shims"),
    join(home, "Library", "pnpm"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ];
}

/** The private roots a test named, when it named any. */
function searchRootOverride(): string[] | undefined {
  const override = process.env.ENGAGER_AGENT_SEARCH_ROOTS;
  if (override === undefined) return undefined;
  return override.split(delimiter).filter((entry) => isAbsolute(entry));
}

/**
 * Whether a location an adapter's descriptor names may be probed under a
 * test's own roots.
 *
 * A descriptor names the agent's real machine locations — `/Applications`,
 * Homebrew — and honoring those in a suite would execute the developer's own
 * CLIs. So under an override only locations inside the named roots, or under a
 * home directory the caller ACTUALLY redirected, stay.
 *
 * The home root is conditional on purpose: `os.homedir()` follows `HOME`, so a
 * fixture that redirected `HOME` gets its own home-relative package roots
 * exercised, while an override whose `HOME` is still the account's own can no
 * longer reach the developer's real `~/.opencode/bin` or `~/.claude/local`.
 * An override meant to be hermetic must not trust a home nobody redirected.
 */
function hermeticLocation(
  path: string,
  override: readonly string[] | undefined,
): boolean {
  if (!override) return true;
  const roots = [...override];
  if (homedir() !== userInfo().homedir) roots.push(homedir());
  return roots.some(
    (root) => path === root || path.startsWith(`${root.replace(/\/$/, "")}/`),
  );
}

/** Version managers keep one directory per installed version. Enumerating them
 *  is bounded on purpose: the roots exist, the count does not. */
export async function versionManagerBinDirectories(
  home = homedir(),
): Promise<string[]> {
  const roots = [
    join(home, ".nvm", "versions", "node"),
    join(home, "Library", "Application Support", "fnm", "node-versions"),
    join(home, ".local", "share", "fnm", "node-versions"),
  ];
  const found: string[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = (await readdir(root)).sort().reverse();
    } catch {
      continue;
    }
    for (const entry of entries.slice(0, DISCOVERY_LIMITS.maxVersionDirectories))
      found.push(join(root, entry, "bin"));
  }
  return found;
}

function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/** Where a supported app bundle keeps its CLI, for the macOS desktop install
 *  that never touched a shell. Read per call rather than at module load: the
 *  suite redirects HOME, and a constant captured on import would scan the
 *  developer's real `/Applications` regardless. */
function appBundleRoots(): string[] {
  return ["/Applications", join(homedir(), "Applications")];
}

async function bundleDirectories(
  descriptor: AdapterDiscoveryDescriptor,
  override: readonly string[] | undefined,
): Promise<string[]> {
  if (!descriptor.bundlePaths?.length) return [];
  const found: string[] = [];
  for (const root of appBundleRoots()) {
    for (const relative of descriptor.bundlePaths) {
      const directory = join(root, relative);
      if (hermeticLocation(directory, override)) found.push(directory);
    }
  }
  return found;
}

/** The extra directories an adapter's descriptor declares, expanded and — under
 *  a test's own roots — filtered to the locations that cannot reach the
 *  developer's machine-wide installs. */
function descriptorDirectories(
  descriptor: AdapterDiscoveryDescriptor,
  override: readonly string[] | undefined,
): string[] {
  return (descriptor.directories ?? [])
    .map(expandHome)
    .filter((directory) => hermeticLocation(directory, override));
}

function locationOf(path: string): string {
  const home = homedir();
  if (path.startsWith(join(home, ".nvm")) || path.includes("/fnm/"))
    return "version_manager";
  if (path.includes(".volta") || path.includes(".asdf") || path.includes("mise"))
    return "version_manager";
  if (path.includes(".npm-global") || path.includes("Library/pnpm"))
    return "package_manager";
  if (path.startsWith("/opt/homebrew") || path.startsWith("/usr/local"))
    return "homebrew";
  if (path.includes(".app/Contents")) return "app_bundle";
  return "PATH";
}

type Probe =
  | { kind: "installation"; installation: DiscoveredInstallation }
  /** The candidate path holds nothing executable: not an installation at all,
   *  and not a fact about the scan's completeness either. */
  | { kind: "absent" }
  /** The scan's own bound was reached before this candidate was asked. */
  | { kind: "bounded" };

/**
 * Identify and version-probe ONE candidate executable. An executable that is
 * present but unprobeable is a candidate with a reason code, not a silent
 * omission: "found but unsupported" and "not installed" are different answers
 * to the owner, and only one of them is fixed by installing something.
 */
/**
 * Whether a path is the Claude DESKTOP app rather than Claude Code. The
 * desktop bundle's executable is `Claude` under `Claude.app/Contents/MacOS`,
 * which the case-insensitive filesystem also answers to as `claude` — so a
 * basename match alone would report (and, worse, spawn) the desktop app as
 * the CLI. Scoped to `Claude.app` itself: another vendor's bundle may
 * legitimately carry its CLI, and `bundlePaths` is how such an adapter
 * says so.
 */
export function isClaudeDesktopPath(path: string): boolean {
  return /\/claude\.app\/contents\//i.test(path);
}

async function probeCandidate(
  adapterId: string,
  displayName: string,
  descriptor: LocalAgentDescriptor,
  absoluteExecutable: string,
  adapterRegistered: boolean,
  budget: { timeoutMs: number; signal: AbortSignal },
): Promise<Probe> {
  // Never even spawn the desktop app: `--version` on a GUI binary launches
  // it. Rejected before the probe, so a scan cannot open Claude Desktop.
  if (adapterId === "claude" && isClaudeDesktopPath(absoluteExecutable))
    return { kind: "absent" };
  let identity: { realPath: string; executableIdentity: string };
  try {
    identity = await executableIdentity(absoluteExecutable, {
      signal: budget.signal,
    });
  } catch {
    // A canceled hash is the scan's own bound, not a fact about the file.
    if (budget.signal.aborted) return { kind: "bounded" };
    return { kind: "absent" };
  }
  // A symlink can land inside the desktop bundle from outside it; the real
  // path gets the same refusal, still before anything is spawned.
  if (adapterId === "claude" && isClaudeDesktopPath(identity.realPath))
    return { kind: "absent" };
  const reasons: string[] = [];
  let observedVersion = "";
  try {
    const inspected = await inspectExecutable(absoluteExecutable, ["--version"], {
      timeoutMs: budget.timeoutMs,
      signal: budget.signal,
    });
    // A probe the scan cut short is a fact about the SCAN, not about the
    // agent: reporting it as an unsupported version would tell the owner their
    // installation is wrong when Engager simply stopped asking.
    if (inspected.timedOut || budget.signal.aborted) return { kind: "bounded" };
    // An answer cut off at the bound is not an answer: whatever version string
    // the prefix happened to contain is not this executable's version.
    if (inspected.cutShort) {
      reasons.push("agent_inspection_failed");
    } else {
      // Claude Code names itself in its version line ("2.1.258 (Claude
      // Code)"); anything else answering to `claude` — the desktop app
      // reached by another path, an unrelated tool — is not an installation
      // of it, whatever version-shaped text it prints.
      if (adapterId === "claude" && !inspected.stdout.includes("(Claude Code)"))
        return { kind: "absent" };
      observedVersion =
        inspected.stdout.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? "";
      if (!observedVersion) reasons.push("agent_version_unknown");
    }
  } catch {
    if (budget.signal.aborted) return { kind: "bounded" };
    reasons.push("agent_inspection_failed");
  }
  // A discovery-only entry declares no versions at all, so "unsupported" is
  // not a finding about it: the single honest reason is that Engager has no
  // adapter to run it, which the caller adds. Reporting both would name a
  // version requirement that does not exist.
  const discoveryOnly = !adapterRegistered;
  const versionSupported = executableVersionSupported(
    descriptor,
    observedVersion,
  );
  if (!discoveryOnly && observedVersion && !versionSupported)
    reasons.push("agent_version_unsupported");
  return {
    kind: "installation",
    installation: {
      candidateId: installationCandidateId(identity.realPath),
      adapterId,
      displayName,
      absoluteExecutable,
      realPath: identity.realPath,
      executableIdentity: identity.executableIdentity,
      observedVersion,
      versionSupported: discoveryOnly ? false : versionSupported,
      adapterRegistered,
      location: locationOf(absoluteExecutable),
      reasonCodes: discoveryOnly ? ["discovery_only"] : reasons,
    },
  };
}

/** Run `work` over `items` with a fixed ceiling, so a hung probe occupies one
 *  slot rather than the whole operation. Exported because the inventory's
 *  isolation phase needs the same bound. */
export async function mapBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(items.length, 1)) },
    async () => {
      while (true) {
        const index = next++;
        const item = items[index];
        if (item === undefined) return;
        results[index] = await work(item);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/** Whether a candidate path holds a file this scan could execute. The probe
 *  decides the same thing again with the hash; this pass exists so a guessed
 *  name in a directory that does not hold it cannot consume the candidate
 *  budget a later adapter needs. */
async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** The candidates that count against `maxCandidates`: only paths that are
 *  actually there. `truncated` is true when the search stopped with candidates
 *  still unchecked — by the cap, or by the scan's own clock. */
async function executableCandidates<T extends { absoluteExecutable: string }>(
  candidates: readonly T[],
  maxCandidates: number,
  budget: { deadline: number; signal: AbortSignal },
): Promise<{ bounded: T[]; truncated: boolean; canceled: boolean }> {
  const bounded: T[] = [];
  for (const candidate of candidates) {
    // The stat/access pass is filesystem work on an unbounded number of
    // guessed paths, so it obeys the same end-to-end budget as the probes: a
    // canceled or expired scan stops here instead of checking the rest first.
    if (budget.signal.aborted || Date.now() >= budget.deadline)
      return { bounded, truncated: true, canceled: true };
    if (bounded.length >= maxCandidates)
      return { bounded, truncated: true, canceled: false };
    if (await isExecutableFile(candidate.absoluteExecutable))
      bounded.push(candidate);
  }
  return { bounded, truncated: false, canceled: false };
}

/**
 * The bounded inventory scan §5 specifies: a documented set of directories, an
 * overall deadline, bounded concurrency, and partial results when one agent
 * hangs. It never walks the user's disk, never sources shell startup files,
 * never runs a login shell, and never installs anything.
 *
 * `descriptors` carries the registered adapters. A descriptor with no adapter
 * behind it is still inventoried — discovery-only entries exist — and is
 * reported with `adapterRegistered: false` / `discovery_only` rather than
 * being dropped, because "your agent is not supported yet" is a real answer.
 */
export async function discoverInstallations(
  entries: readonly {
    descriptor: LocalAgentDescriptor;
    displayName?: string;
    adapterRegistered?: boolean;
  }[],
  options: {
    paths?: readonly string[];
    overrides?: Readonly<Record<string, string>>;
    /** Explicit executables a caller already knows belong to ONE adapter —
     *  saved selections' paths, one per purpose. Searched in addition to the
     *  standard roots rather than instead of them, so a pin that moved is
     *  still found. Plural because chat and background may be two different
     *  binaries of the same adapter, and keeping only the first is how the
     *  second disappears from its own picker. */
    pins?: Readonly<Record<string, readonly string[]>>;
    only?: readonly string[];
    signal?: AbortSignal | undefined;
    limits?: Partial<DiscoveryLimits>;
    /** Injects the version-manager and bundle roots so a test does not have to
     *  arrange the caller's home directory. */
    extraDirectories?: readonly string[];
  } = {},
): Promise<AgentInventoryScan> {
  const limits = { ...DISCOVERY_LIMITS, ...options.limits };
  const deadline = Date.now() + limits.scanTimeoutMs;
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onOuterAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const days = setTimeout(() => controller.abort(), limits.scanTimeoutMs);
  const warnings: string[] = [];
  try {
    // An explicit `paths` list ADDS to the standard roots rather than
    // replacing them: it is how the durable-pin import names the one
    // installation it was told about. The standard roots stay in, so a pinned
    // import still finds the machine's own installation and a Finder launch
    // still finds what a shell never put on PATH.
    const searchOverride = searchRootOverride();
    const shared = [
      ...(options.paths ?? []).map(expandHome),
      ...standardSearchDirectories(),
      ...(searchOverride ? [] : await versionManagerBinDirectories()),
      ...(options.extraDirectories ?? []),
    ];
    type Candidate = {
      adapterId: string;
      displayName: string;
      descriptor: LocalAgentDescriptor;
      adapterRegistered: boolean;
      absoluteExecutable: string;
    };
    const candidates: Candidate[] = [];
    const seen = new Set<string>();
    // Keyed by adapter as well as path: one real file can be a candidate for
    // several adapters, and letting the first registry entry claim it would
    // report a saved OpenCode binary as an unsupported Claude installation.
    const push = (candidate: Candidate) => {
      const key = `${candidate.adapterId}\u0000${candidate.absoluteExecutable}`;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push(candidate);
    };
    for (const entry of entries) {
      if (options.only && !options.only.includes(entry.descriptor.adapterId))
        continue;
      const registered = entry.adapterRegistered ?? true;
      const displayName = entry.displayName ?? entry.descriptor.adapterId;
      const override = options.overrides?.[entry.descriptor.adapterId];
      if (override) {
        if (!isAbsolute(override))
          throw agentFailure("agent_absolute_path_required");
        push({
          adapterId: entry.descriptor.adapterId,
          displayName,
          descriptor: entry.descriptor,
          adapterRegistered: registered,
          absoluteExecutable: override,
        });
        continue;
      }
      for (const pin of options.pins?.[entry.descriptor.adapterId] ?? []) {
        if (!isAbsolute(pin))
          throw agentFailure("agent_absolute_path_required");
        push({
          adapterId: entry.descriptor.adapterId,
          displayName,
          descriptor: entry.descriptor,
          adapterRegistered: registered,
          absoluteExecutable: pin,
        });
      }
      // A caller-supplied path is tried BOTH ways — as the installation
      // itself, and as a directory holding one — because those are the two
      // forms "where is your claude?" takes in practice, and the version probe
      // is what decides which of them the path actually was.
      for (const path of options.paths ?? [])
        push({
          adapterId: entry.descriptor.adapterId,
          displayName,
          descriptor: entry.descriptor,
          adapterRegistered: registered,
          absoluteExecutable: expandHome(path),
        });
      const directories = [
        ...descriptorDirectories(entry.descriptor.discovery, searchOverride),
        ...(await candidateDirectories(
          (options.paths ?? []).map(expandHome),
          shared,
          limits.maxVersionDirectories,
        )),
        ...(await bundleDirectories(entry.descriptor.discovery, searchOverride)),
      ];
      for (const directory of directories) {
        for (const executable of entry.descriptor.discovery.executables) {
          push({
            adapterId: entry.descriptor.adapterId,
            displayName,
            descriptor: entry.descriptor,
            adapterRegistered: registered,
            absoluteExecutable: join(directory, executable),
          });
        }
      }
    }
    const { bounded, truncated, canceled } = await executableCandidates(
      candidates,
      limits.maxCandidates,
      { deadline, signal: controller.signal },
    );
    if (truncated && !canceled) warnings.push("agent_inventory_truncated");
    const probed = await mapBounded(
      bounded,
      limits.concurrentProbes,
      async (candidate): Promise<Probe> => {
        // ONE clock for the whole scan: a probe that starts with one second of
        // the scan left gets one second, not its own fresh five — otherwise
        // the operation's stated bound is only a bound on when probes START.
        const remaining = deadline - Date.now();
        if (controller.signal.aborted || remaining <= 0)
          return { kind: "bounded" };
        return probeCandidate(
          candidate.adapterId,
          candidate.displayName,
          candidate.descriptor,
          candidate.absoluteExecutable,
          candidate.adapterRegistered,
          {
            timeoutMs: Math.max(
              1,
              Math.min(limits.probeTimeoutMs, remaining),
            ),
            signal: controller.signal,
          },
        );
      },
    );
    // Insertion order is the candidate order: the caller's explicit paths
    // lead, so an install that named its own binary is listed in the order it
    // named them rather than by whichever version string sorts first. Two
    // installations of one adapter at one real path still collapse to one.
    const byRealPath = new Map<string, DiscoveredInstallation>();
    for (const probe of probed) {
      if (probe.kind !== "installation") continue;
      const found = probe.installation;
      const existing = byRealPath.get(found.realPath);
      if (existing) {
        if (!existing.adapterRegistered && found.adapterRegistered) {
          byRealPath.set(found.realPath, found);
          continue;
        }
        if (
          existing.adapterRegistered === found.adapterRegistered &&
          !existing.versionSupported &&
          found.versionSupported
        )
          byRealPath.set(found.realPath, found);
        continue;
      }
      byRealPath.set(found.realPath, found);
    }
    return {
      installations: [...byRealPath.values()],
      partial: canceled || probed.some((probe) => probe.kind === "bounded"),
      warnings,
    };
  } finally {
    clearTimeout(days);
    options.signal?.removeEventListener("abort", onOuterAbort);
  }
}

/**
 * The descriptor a discovery-only entry is looked for with: a name, a place to
 * look, and nothing Engager could execute. It is a declaration of absence —
 * every capability field is the refusing answer — so nothing downstream can
 * mistake a found binary for a supported agent.
 */
export function discoveryOnlyShape(
  adapterId: string,
  executables: readonly string[] = [adapterId],
): LocalAgentDescriptor {
  return {
    adapterId,
    adapterContractVersion: "0",
    supportedExecutableVersions: [],
    background: { text: false, structured: "none" },
    chat: {
      transport: "pending_broker",
      events: false,
      textDeltas: false,
      brokerTools: false,
      resumable: "canonical_history",
    },
    isolationProfileVersion: "unregistered",
    supportedAuthRoutes: [],
    supportedModelRoutes: [],
    discovery: { executables: [...executables] },
  };
}

/** The bounded scan's earlier, adapter-name-only shape, kept as the exact
 *  question `importExistingAgentPin` asks: one adapter, one known binary, no
 *  catalog and no ownership of the owner's machine. */
export async function discoverLocalAgents(
  descriptors: readonly LocalAgentDescriptor[],
  options: {
    paths?: readonly string[];
    overrides?: Partial<Record<(typeof KNOWN_LOCAL_AGENTS)[number], string>>;
    only?: readonly string[];
    /** Executable names for a discovery-only entry, whose descriptor carries
     *  no `discover` block of its own. Without one, an adapter must state
     *  where its binary lives. */
    executables?: Readonly<Record<string, readonly string[]>>;
  } = {},
): Promise<
  {
    adapterId: string;
    absoluteExecutable: string;
    realPath?: string;
    executableIdentity?: string;
    observedVersion?: string;
    compatible: boolean;
    authStatus: "unknown";
    missingCapabilities: string[];
  }[]
> {
  const known = new Set(descriptors.map((descriptor) => descriptor.adapterId));
  const entries = [
    ...descriptors.map((descriptor) => ({
      descriptor,
      adapterRegistered: descriptor.supportedModelRoutes.length > 0,
    })),
    // An id the caller asked for BY NAME with no descriptor behind it is a
    // discovery-only entry, not a missing one: its executable is still looked
    // for and reported, so an install pinned at an agent Engager cannot yet
    // drive still learns the binary is there. That name is the whole search
    // set, which is the legacy contract this shape exists to keep.
    ...[...new Set(options.only ?? [])]
      .filter((adapterId) => !known.has(adapterId))
      .map((adapterId) => ({
        descriptor: {
          ...discoveryOnlyShape(adapterId),
          discovery: {
            executables: [adapterId, ...(options.executables?.[adapterId] ?? [])],
          },
        },
        adapterRegistered: false,
      })),
  ];
  const scan = await discoverInstallations(entries, {
    ...(options.paths ? { paths: options.paths } : {}),
    ...(options.overrides ? { overrides: options.overrides } : {}),
    ...(options.only ? { only: options.only } : {}),
  });
  return scan.installations.map((installation) => ({
    adapterId: installation.adapterId,
    absoluteExecutable: installation.absoluteExecutable,
    realPath: installation.realPath,
    executableIdentity: installation.executableIdentity,
    observedVersion: installation.observedVersion,
    compatible: installation.versionSupported,
    authStatus: "unknown" as const,
    missingCapabilities: installation.reasonCodes,
  }));
}
