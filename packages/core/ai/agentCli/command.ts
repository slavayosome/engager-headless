import {
  ADAPTERS,
  resolveCandidate,
  scanAgentInventory,
  scanAgentSetupInventory,
} from "./index";
import { probeSignIn, startLogin } from "./signin";
import {
  agentReadiness,
  connectLocalAgent,
  type SmokeExecutor,
} from "./picker";
import type { IsolationVerifier } from "./isolation";
import { configureLocalAgent, storedAgentSelection } from "./selection";
import { discoverLocalAgents } from "./discovery";
import { agentFailure } from "./state";
import {
  agentInstaller,
  runAgentInstall,
  type AgentInstallEvent,
  type InstallerRunner,
} from "./installers";

/** Neutral source CLI; P3 carries this same operation into the packed CLI.
 *
 * `discover` keeps its original shape — the flat, adapter-name-keyed
 * inventory `engager doctor` and the local-agent skills already parse — and
 * `inventory` is the normalized one the picker reads: opaque candidate ids,
 * eligibility, and no absolute paths.
 */
export async function localAgentCommand(argv: string[]): Promise<unknown> {
  const [command, ...rest] = argv;
  if (command === "discover") {
    if (rest.some((arg) => arg !== "--json"))
      throw agentFailure("agent_arguments_invalid");
    return discoverLocalAgents(
      Object.values(ADAPTERS).map((entry) => entry.descriptor),
    );
  }
  if (command === "inventory") {
    if (rest.some((arg) => arg !== "--json"))
      throw agentFailure("agent_arguments_invalid");
    return scanAgentInventory();
  }
  if (command !== "configure")
    throw agentFailure("use_agent_discover_configure_or_inventory");
  const flags = new Map<string, string>();
  const allowed = [
    "--purpose",
    "--adapter",
    "--executable",
    "--model",
    "--provider",
    "--auth",
    "--auth-store",
    "--filter",
    "--writer",
    "--writerPremium",
  ];
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i],
      value = rest[i + 1];
    if (!key || !allowed.includes(key) || !value || flags.has(key))
      throw agentFailure("agent_arguments_invalid");
    flags.set(key, value);
  }
  const purpose = flags.get("--purpose");
  if (purpose !== "background" && purpose !== "chat")
    throw agentFailure("agent_purpose_required");
  const adapter = ADAPTERS[flags.get("--adapter") ?? ""];
  if (!adapter) throw agentFailure("agent_adapter_unsupported");
  const required = (key: string) => {
    const value = flags.get(key);
    if (!value) throw agentFailure("agent_selection_incomplete");
    return value;
  };
  const modelRef = required("--model");
  const roles =
    purpose === "background"
      ? Object.fromEntries(
          ["filter", "writer", "writerPremium"].map((role) => [
            role,
            flags.get(`--${role}`) ?? modelRef,
          ]),
        )
      : { chat: modelRef };
  return configureLocalAgent(
    adapter.descriptor,
    {
      purpose,
      absoluteExecutable: required("--executable"),
      modelRef,
      providerRef: required("--provider"),
      authRoute: required("--auth"),
      ...(flags.has("--auth-store")
        ? { authStorePath: required("--auth-store") }
        : {}),
    },
    roles,
  );
}

/**
 * The first-run window's setup verbs (`engager agent-setup …`). `inventory`
 * is the read-only per-agent scan the Agent step renders; it writes nothing
 * and selects nothing. `install <claude|codex>` runs that agent's ONE
 * table installer (`installers.ts`), streaming phase/log/done/failed
 * events through `emit` — the id is the only thing the page or Swift send,
 * and anything but `claude` or `codex` is refused rather than guessed at.
 * An install is started only by this verb, which only the window's button
 * press reaches — never by detection, `engager init` or a background job.
 * `status <candidateId>` probes that one found installation's sign-in and
 * `login <candidateId>` runs its own login (US-ONE-04) — both resolve the
 * opaque candidate id against a fresh scan, so a caller can name only an
 * agent Engager found, and never another agent or an arbitrary
 * executable. `connect <candidateId>` runs setup's one test request and,
 * only on its answer, saves the default selection for both purposes
 * (US-ONE-05, `connectLocalAgent`); `readiness` is the stored-selection
 * projection the reopened window derives "already connected" from — plus
 * the adapter id the chat selection names, so a reopened Connected card
 * names the agent the owner chose and not the first one found — a read
 * that spawns nothing. Anything else here is refused rather than guessed
 * at.
 */
export async function agentSetupCommand(
  argv: string[],
  options: {
    signal?: AbortSignal | undefined;
    emit?: ((event: AgentInstallEvent) => void) | undefined;
    installerRunner?: InstallerRunner | undefined;
    /** The connection check's executor, injectable so a test drives
     *  `connect` without spawning a real agent (§5 rule 12). Production
     *  never passes one. */
    execute?: SmokeExecutor | undefined;
    verifyIsolation?: IsolationVerifier | undefined;
  } = {},
): Promise<unknown> {
  const [command, ...rest] = argv;
  if (command === "inventory") {
    if (rest.some((arg) => arg !== "--json"))
      throw agentFailure("agent_arguments_invalid");
    return scanAgentSetupInventory({
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.verifyIsolation
        ? { verifyIsolation: options.verifyIsolation }
        : {}),
    });
  }
  if (command === "install") {
    const [id, ...flags] = rest;
    if (!id || flags.some((arg) => arg !== "--json"))
      throw agentFailure("agent_arguments_invalid");
    const entry = agentInstaller(id);
    if (!entry) throw agentFailure("agent_adapter_unsupported");
    const events: AgentInstallEvent[] = [];
    const emit = options.emit ?? ((event: AgentInstallEvent) => void events.push(event));
    await runAgentInstall(entry, {
      emit,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.installerRunner ? { runner: options.installerRunner } : {}),
    });
    // With a streaming sink the events already left; the collected list is
    // the answer only for a caller (a test) that handed in no sink.
    return options.emit ? undefined : { events };
  }
  if (command === "readiness") {
    if (rest.some((arg) => arg !== "--json"))
      throw agentFailure("agent_arguments_invalid");
    const adapterId = storedAgentSelection("chat")?.adapterId;
    return { ...agentReadiness(), ...(adapterId ? { adapterId } : {}) };
  }
  if (command !== "status" && command !== "login" && command !== "connect")
    throw agentFailure(
      "use_agent_setup_inventory_install_status_login_connect_or_readiness",
    );
  const [candidateId, ...flags] = rest;
  if (
    !candidateId ||
    candidateId.startsWith("--") ||
    flags.some((arg) => arg !== "--json")
  )
    throw agentFailure("agent_arguments_invalid");
  if (command === "connect")
    return connectLocalAgent(candidateId, {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.execute ? { execute: options.execute } : {}),
      ...(options.verifyIsolation
        ? { verifyIsolation: options.verifyIsolation }
        : {}),
    });
  const installation = await resolveCandidate(
    candidateId,
    options.signal ? { signal: options.signal } : {},
  );
  if (command === "status")
    return probeSignIn(
      installation,
      options.signal ? { signal: options.signal } : {},
    );
  const login = startLogin(
    installation,
    options.signal ? { signal: options.signal } : {},
  );
  return { exitCode: await login.exit };
}

if (process.argv[1]?.endsWith("/agentCli/command.ts")) {
  localAgentCommand(process.argv.slice(2)).then(
    (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`),
    (error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : "agent_operation_failed"}\n`,
      );
      process.exitCode = 1;
    },
  );
}
