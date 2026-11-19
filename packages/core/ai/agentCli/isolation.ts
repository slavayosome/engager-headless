import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { inspectExecutable } from "./discovery";
import { agentFailure } from "./state";
import { AgentCliError } from "./types";
import type { AgentCliAdapter, ResolvedAgentSelection } from "./types";
import { CODEX_DISABLED_FEATURES } from "./codex";
import {
  codexProofKey,
  readCodexSandboxProof,
  recordCodexSandboxProof,
} from "./codexProof";
import { runCodexSandboxSelfTest } from "./codexSelfTest";

/** Answers of the read-only probes (`--help`, `features list`) that state a
 *  fact about the binary itself, remembered for the process while the file
 *  stands exactly as stated (real path, inode, mtime, size). The policy reads
 *  around them — managed layers, the Codex sandbox proof — are NOT remembered
 *  and run on every verification. Only a complete answer is stored: a probe
 *  that timed out or was cut short is asked again next time. */
const probeAnswers = new Map<string, string>();

async function inspectBinaryOnce(
  file: string,
  args: readonly string[],
  signal: AbortSignal | undefined,
): Promise<string> {
  let key: string | undefined;
  try {
    const real = await realpath(file);
    const stated = await stat(real);
    key = [real, stated.ino, stated.mtimeMs, stated.size, ...args].join("|");
  } catch {
    key = undefined;
  }
  const remembered = key === undefined ? undefined : probeAnswers.get(key);
  if (remembered !== undefined) return remembered;
  const result = await inspectExecutable(
    file,
    args,
    signal ? { signal } : {},
  );
  if (key !== undefined && !result.timedOut && !result.cutShort)
    probeAnswers.set(key, result.stdout);
  return result.stdout;
}

/**
 * Codex runs judgment inside its own sandbox under `CODEX_JUDGMENT_PROFILE`,
 * so its isolation is a property of the binary, proved per binary: the policy
 * layers it would obey are refused when present, the flags and features
 * `buildArgs` depends on must exist, and the sandbox self-test must have
 * passed for this exact executable (`codexProof.ts`).
 *
 * `prove` lets this call RUN the self-test when no proof is recorded. Only an
 * owner-facing question passes it — discovery's eligibility column and
 * `Repair connection` — so execution reads a verdict and never spends a dozen
 * sandboxed processes on every model call.
 */
export async function verifyCodexIsolation(
  selection: Pick<
    ResolvedAgentSelection,
    "absoluteExecutable" | "executableIdentity" | "observedVersion"
  >,
  options: IsolationOptions = {},
): Promise<void> {
  // Global/mandatory layers can supersede named permissions. Refuse unknown
  // policy rather than reading or overriding it. Native auth keeps CODEX_HOME.
  if (
    [
      "/etc/codex/config.toml",
      "/etc/codex/requirements.toml",
      "/Library/Managed Preferences/com.openai.codex.plist",
    ].some(existsSync)
  )
    throw agentFailure("isolation_unverified");
  const help = await inspectBinaryOnce(
    selection.absoluteExecutable,
    ["exec", "--help"],
    options.signal,
  );
  for (const flag of [
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--output-schema",
    "--json",
  ]) {
    if (!help.includes(flag)) throw agentFailure("isolation_unverified");
  }
  // Feature inspection uses a private empty home so user settings cannot
  // influence the contract check; this command neither authenticates nor infers.
  const features = await inspectBinaryOnce(
    selection.absoluteExecutable,
    ["features", "list"],
    options.signal,
  );
  for (const feature of CODEX_DISABLED_FEATURES) {
    if (!features.split("\n").some((line) => line.split(/\s+/)[0] === feature))
      throw agentFailure("isolation_unverified");
  }
  const key = codexProofKey(selection);
  if (readCodexSandboxProof(key)) return;
  if (!options.prove)
    throw agentFailure("isolation_unverified:codex_sandbox_unproven");
  const result = await runCodexSandboxSelfTest(selection.absoluteExecutable, {
    signal: options.signal,
  });
  if (!result.ok)
    throw agentFailure(`isolation_unverified:codex_sandbox:${result.failedCheck}`);
  await recordCodexSandboxProof(key, result);
}

/** `prove` is an owner-facing caller's permission to run a self-test where an
 *  adapter has one (`verifyCodexIsolation`); execution never passes it. */
export type IsolationOptions = {
  signal?: AbortSignal | undefined;
  prove?: boolean | undefined;
};

/** The isolation boundary's signature. Typed here, beside the reviewed
 *  verifier, so an injected seam and the production one cannot drift.
 *
 *  The optional third argument carries the caller's cancellation, which is
 *  what lets a scan that reached its budget kill a native probe it already
 *  started rather than wait the probe's own bound out. A verifier that ignores
 *  it stays correct — every probe still has its own timeout — it is simply
 *  less responsive. */
export type IsolationVerifier = (
  adapter: AgentCliAdapter,
  selection: ResolvedAgentSelection,
  options?: IsolationOptions,
) => Promise<void>;

/** Mandatory policy is never overridden to obtain a local execution profile.
 * Unknown managed layers stay unavailable; credentials are never inspected. */
export async function verifyIsolationProfile(
  adapter: AgentCliAdapter,
  selection: ResolvedAgentSelection,
  options: IsolationOptions = {},
): Promise<void> {
  if (adapter.verifyIsolation) return adapter.verifyIsolation(selection, options);
  if (adapter.id === "claude") {
    const authRoot =
      selection.authStorePath ?? join(process.env.HOME ?? homedir(), ".claude");
    const managed = [
      "/Library/Application Support/ClaudeCode/managed-settings.json",
      "/Library/Managed Preferences/com.anthropic.claudecode.plist",
      "/etc/claude-code/managed-settings.json",
      join(authRoot, "managed-settings.json"),
      join(authRoot, "managed-settings"),
    ];
    if (managed.some(existsSync)) throw agentFailure("isolation_unverified");
    const help = await inspectBinaryOnce(
      selection.absoluteExecutable,
      ["--help"],
      options.signal,
    );
    for (const flag of [
      "--safe-mode",
      "--restricted",
      "--tools",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--json-schema",
    ]) {
      if (!help.includes(flag)) throw agentFailure("isolation_unverified");
    }
    return;
  }
  if (adapter.id === "codex")
    return verifyCodexIsolation(selection, options);
  throw agentFailure("isolation_unverified");
}

/**
 * Why this exact binary's isolation is NOT admitted today, or undefined when
 * it is — a REPORT for the picker's eligibility column and `Repair
 * connection`.
 *
 * It asks the same verifier execution asks — there is no second policy here.
 * Discovery passes `prove`, because an owner is waiting on the answer and a
 * binary with no sandbox proof yet should earn one rather than read as
 * refused; a caller after the scan reads the verdict it left. It answers
 * instead of throwing, because discovery's job is to say which found
 * installations are usable, and one unverifiable installation must not fail
 * the scan that found the others. The answer is an `isolation_unverified`
 * code, with the verifier's own detail after a colon when it gave one.
 */
export async function profileIsolationRefusal(
  adapter: AgentCliAdapter,
  candidate: Pick<
    ResolvedAgentSelection,
    "absoluteExecutable" | "observedVersion" | "executableIdentity"
  >,
  verifyIsolation: IsolationVerifier = verifyIsolationProfile,
  options: IsolationOptions = {},
): Promise<string | undefined> {
  try {
    await verifyIsolation(
      adapter,
      {
        ...candidate,
        purpose: "background",
        realPath: candidate.absoluteExecutable,
        adapterId: adapter.id,
        modelRef: adapter.descriptor.supportedModelRoutes[0]?.models[0] ?? "",
        providerRef:
          adapter.descriptor.supportedModelRoutes[0]?.providerRef ??
          adapter.provider,
        authRoute: adapter.descriptor.supportedAuthRoutes[0] ?? "native_login",
        configRevision: "discovery",
        capabilityEvidence: [],
        missingCapabilities: [],
      },
      options,
    );
    return undefined;
  } catch (error) {
    const code =
      error instanceof AgentCliError ? (error.cause?.code ?? error.message) : "";
    return code.startsWith("isolation_unverified:")
      ? code
      : "isolation_unverified";
  }
}

/** `profileIsolationRefusal` as a yes or no, for a caller that only gates. */
export async function profileIsolationAdmitted(
  adapter: AgentCliAdapter,
  candidate: Pick<
    ResolvedAgentSelection,
    "absoluteExecutable" | "observedVersion" | "executableIdentity"
  >,
  verifyIsolation: IsolationVerifier = verifyIsolationProfile,
  options: IsolationOptions = {},
): Promise<boolean> {
  return (
    (await profileIsolationRefusal(
      adapter,
      candidate,
      verifyIsolation,
      options,
    )) === undefined
  );
}
