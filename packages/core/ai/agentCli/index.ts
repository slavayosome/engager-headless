import { randomUUID } from "node:crypto";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { AGENT_SUPPORT_MATRIX } from "@engager/common/agent-support";
import { resolvedRoleModels } from "../modelRoles";
import { currentUsageContext } from "../usage";
import { claudeAdapter } from "./claude";
import { codexAdapter } from "./codex";
import { geminiAdapter } from "./gemini";
import { opencodeAdapter } from "./opencode";
import { recordAdmission } from "./admission";
import { readSelectedEffort, recordSelectedEffort } from "./effort";
import {
  admissionEvidenceFor,
  admittedModel,
  installationOmitsModel,
  installedRoleModels,
  rolePurpose,
  selectedModelRoute,
  storedAgentSelection,
  verifyAgentSelection,
} from "./selection";
import { agentFailure, mutateAgentState, readAgentState } from "./state";
import {
  discoverInstallations,
  discoveryOnlyShape,
  mapBounded,
  type DiscoveredInstallation,
} from "./discovery";
import {
  CATALOG_FRESH_MS,
  readModelCatalog,
  storeCatalog,
  storedCatalog,
  type CatalogBinding,
} from "./catalog";
import {
  profileIsolationAdmitted,
  profileIsolationRefusal,
  verifyIsolationProfile,
  type IsolationVerifier,
} from "./isolation";
import { rememberAgentPath, rememberedAgentPaths } from "./explicitPaths";
import {
  authStatusForProbe,
  probeSignIn as probeAgentSignIn,
  type SignInInstallation,
  type SignInProbe,
  type SignInProbeOptions,
} from "./signin";
import {
  AgentCliError,
  missingBackgroundCapabilities,
  type AgentInstallHint,
  type AgentInstallation,
  type AgentInventory,
  type AgentModelCatalog,
  type LocalAgentDescriptor,
} from "./types";
import type {
  AdapterMetadataDescriptor,
  AgentCliAdapter,
  AgentCliStatus,
  AgentPurpose,
  AgentRoleModel,
  ChatCapableAdapter,
  ResolvedAgentSelection,
  UnofferedRoleModel,
} from "./types";

export { AgentCliLLM } from "./llm";
export { AgentCliError } from "./types";
export * from "./installers";
export {
  authStatusForProbe,
  probeSignIn,
  startLogin,
  type SignInInstallation,
  type SignInProbe,
  type SignInProbeOptions,
  type StartedLogin,
} from "./signin";
export * from "./discovery";
export * from "./selection";
export * from "./catalog";
export * from "./admission";
export * from "./explicitPaths";
export * from "./metadata";
export type {
  AdapterDiscoveryDescriptor,
  AdapterMetadataDescriptor,
  AgentChatSurface,
  AgentCliAdapter,
  AgentCliId,
  AgentCliStatus,
  AgentConnectionStatus,
  AgentInstallHint,
  AgentInstallation,
  AgentInventory,
  AgentModelCatalog,
  AgentReadiness,
  AgentReadinessState,
  AgentRoleModel,
  AgentSelectionRequest,
  ChatCapableAdapter,
  ChatDriverEvent,
  ChatSpawnOpts,
  ChatStreamParser,
  ModelListResult,
  ModelMetadataContext,
  NormalizedModelOption,
  UnofferedRoleModel,
} from "./types";
export type { DiscoveredInstallation } from "./discovery";

export const ADAPTERS: Record<string, AgentCliAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  gemini: geminiAdapter,
  opencode: opencodeAdapter,
};
/** Compatibility inventory only. No entry is silently selected. */
export const AUTO_ORDER = Object.values(ADAPTERS).filter(
  (adapter) => missingBackgroundCapabilities(adapter).length === 0,
);

/**
 * Agents Engager can FIND without being able to run them. They stay in the
 * inventory because "installed but not supported in this Engager version" is
 * an answer the owner needs — and because §5's rule is that the registry, not
 * the picker, decides which executables are looked for. Their descriptors
 * carry no versions and no model routes, so selection refuses them and
 * discovery reports them as `discovery_only`.
 */
const DISCOVERY_ONLY: readonly {
  id: string;
  discovery: LocalAgentDescriptor["discovery"];
}[] = [
  { id: "grok", discovery: { executables: ["grok"] } },
  // Cursor's AGENT is `cursor-agent`. The editor's own `cursor` launcher
  // (commonly /usr/local/bin/cursor) is a different program, and looking
  // for it would report every Cursor editor install as an agent.
  { id: "cursor", discovery: { executables: ["cursor-agent"] } },
  { id: "openclaw", discovery: { executables: ["openclaw"] } },
  { id: "hermes", discovery: { executables: ["hermes"] } },
];

/** Every executable name discovery may look for: the registered adapters plus
 *  the discovery-only registry. The picker resolves a candidate id against
 *  THIS list and nothing else, which is what makes an arbitrary executable
 *  unselectable rather than merely unlisted.
 *
 * A discovery-only entry is described by the whole refusing descriptor rather
 * than by a borrowed one, so nothing downstream can mistake a found binary for
 * a supported agent — and so the registry never has to state a `discover`
 * block the scan would then read as an adapter's own claim. */
export function discoveryRegistry(): {
  descriptor: LocalAgentDescriptor;
  displayName?: string;
  adapterRegistered: boolean;
}[] {
  return [
    ...Object.values(ADAPTERS).map((adapter) => ({
      descriptor: adapter.descriptor,
      displayName: adapter.name,
      adapterRegistered: true,
    })),
    ...DISCOVERY_ONLY.map((entry) => ({
      descriptor: discoveryOnlyShape(entry.id, entry.discovery.executables),
      displayName: entry.id,
      adapterRegistered: false,
    })),
  ];
}

/** The support tier product truth assigns an agent id, read from the one
 *  matrix (`packages/common/agent-support.ts`) rather than restated here. */
function supportTier(adapterId: string): string | undefined {
  return AGENT_SUPPORT_MATRIX.find((entry) => entry.id === adapterId)?.tier;
}

/** Every agent Engager can USE now, with the vendor's install copy — the
 *  registry's own facts, for an empty screen that has to say what to install.
 *  A coming-soon adapter (Gemini, OpenCode) keeps its registry entry and its
 *  conformance fixtures, but an empty screen must not offer installing
 *  something this product cannot run yet; discovery-only entries are absent
 *  for the same reason. */
export function supportedAgents(): AgentInstallHint[] {
  return Object.values(ADAPTERS).flatMap((adapter) =>
    adapter.install && supportTier(adapter.id) === "supported"
      ? [
          {
            adapterId: adapter.id,
            displayName: adapter.name,
            installCommand: adapter.install.command,
            installUrl: adapter.install.url,
          },
        ]
      : [],
  );
}

/** Every executable path a saved selection names, keyed by the adapter it
 *  belongs to. §5's documented search set starts with these: an installation
 *  the owner already chose is looked for even when it lives outside PATH,
 *  Homebrew and the version managers — a pin that still works must not
 *  disappear from its own picker, and must not be mistaken for another
 *  adapter's installation.
 *
 *  BOTH purposes are kept, not one per adapter: chat and background may be two
 *  different binaries of the same agent installed outside the standard
 *  locations, and retaining only the first is how the second one — still in
 *  use for the other purpose — fails to appear in the scan that is supposed to
 *  offer it back. */
function savedAgentPins(): Record<string, string[]> {
  const pins: Record<string, string[]> = {};
  const add = (adapterId: string, path: string) => {
    // A malformed state must not turn every scan into a refusal; execution
    // already refuses a relative path, and the scan simply does not pin it.
    if (!isAbsolute(path)) return;
    const known = (pins[adapterId] ??= []);
    if (!known.includes(path)) known.push(path);
  };
  for (const purpose of ["background", "chat"] as const) {
    const selection = storedAgentSelection(purpose);
    if (selection) add(selection.adapterId, selection.absoluteExecutable);
  }
  // Paths the owner chose in Advanced are pins too, so the candidate they
  // resolved to stays resolvable on the next scan.
  for (const [adapterId, paths] of Object.entries(rememberedAgentPaths()))
    for (const path of paths) add(adapterId, path);
  return pins;
}

/** Every role a local configuration may pin, and which purpose owns it. The
 *  same set the selection validator knows; a role outside it is refused rather
 *  than written under a guessed purpose. */
const LOCAL_ROLES = ["filter", "writer", "writerPremium", "chat"] as const;

/**
 * One validated local role edit, ready to publish.
 *
 * A plan exists so the caller can validate BOTH halves of a Models save before
 * either is written: the local mutation and the organization row are disjoint
 * per role, and a refusal on one side must not leave the other committed. It
 * also carries the purpose revisions the edit mints, because a role an
 * installation reported is admitted by a record keyed to the revision that
 * names it — a new id needs a new revision, written before it is activated.
 */
export type PreparedLocalAgentRoles = {
  /** The state revision the plan was validated against. A concurrent
   *  configuration change is a refreshable conflict, not a last-write-wins. */
  expectedRevision: string;
  /** Every role this plan writes. A cleared role keeps the installation's own
   *  model for its purpose: the published defaults name one agent's
   *  vocabulary, and falling through to them is how a cleared role would come
   *  to name a model a differently-configured installation refuses. */
  roles: Record<string, string>;
  configurations: {
    purpose: AgentPurpose;
    selection: ResolvedAgentSelection;
    evidence?: AgentModelCatalog | undefined;
    refs: readonly string[];
  }[];
};

/** Whether a role's purpose is served by an installation selection this build
 *  can drive — which is what makes the LOCAL role writer the authority for it.
 *  A role without one is the organization row's, exactly as before. */
export function localRoleIsInstalled(role: string): boolean {
  if (!LOCAL_ROLES.includes(role as (typeof LOCAL_ROLES)[number])) return false;
  const selection = storedAgentSelection(rolePurpose(role));
  return Boolean(selection && ADAPTERS[selection.adapterId]);
}

/**
 * Validate one local role edit against the installation's own admission, and
 * hold it ready to publish — without writing anything.
 *
 * `null` clears a role back to the default for a LOCAL install, which is the
 * model the picker saved for that purpose: every role a fresh configuration
 * writes already points there, so the cleared state is the default state
 * rather than a fall-through to the organization row and the shipped
 * vocabulary behind it.
 */
export async function planLocalAgentRoles(
  roles: Readonly<Record<string, string | null>>,
  options: { expectedRevision?: string | undefined } = {},
): Promise<PreparedLocalAgentRoles> {
  const before = await readAgentState();
  if (
    options.expectedRevision !== undefined &&
    options.expectedRevision !== before.revision
  )
    throw agentFailure("agent_configuration_conflict");
  if (before.active.length || before.queue.length)
    throw agentFailure("agent_configuration_busy");
  const next: Record<string, string> = {};
  const touched = new Map<
    AgentPurpose,
    {
      selection: ResolvedAgentSelection;
      adapter: AgentCliAdapter;
      catalog: AgentModelCatalog | undefined;
      models: Set<string>;
    }
  >();
  const purposeOf = (role: string): AgentPurpose => {
    if (!LOCAL_ROLES.includes(role as (typeof LOCAL_ROLES)[number]))
      throw agentFailure("agent_role_unknown");
    return rolePurpose(role);
  };
  for (const [role, model] of Object.entries(roles)) {
    const purpose = purposeOf(role);
    const selection = storedAgentSelection(purpose);
    const adapter = selection ? ADAPTERS[selection.adapterId] : undefined;
    // No local pin for this purpose: the organization row (or the default) is
    // what execution reads, so there is nothing local to write and nothing to
    // refuse. The caller still gets the org half.
    if (!selection || !adapter) continue;
    // A role is never set to a model the installed agent says it does not
    // offer. The published vocabulary used to be enough here, and that is how
    // an id the installation never listed came to run every draft.
    if (model !== null && installationOmitsModel(selection, model))
      throw agentFailure("agent_model_execution_unverified");
    next[role] = model ?? selection.modelRef;
    let entry = touched.get(purpose);
    if (!entry) {
      entry = {
        selection,
        adapter,
        catalog: await storedCatalog(selection, adapter.descriptor),
        models: new Set(),
      };
      touched.set(purpose, entry);
    }
    entry.models.add(next[role]!);
  }
  const configurations: PreparedLocalAgentRoles["configurations"] = [];
  let changed = false;
  // What the roles this edit leaves alone actually run: a stored id the
  // installation no longer offers is asked for as its substitute, so it is the
  // substitute a new record must admit — and the stale id cannot refuse an
  // edit to a different role.
  const carried = installedRoleModels(before.roles).models;
  for (const [purpose, entry] of touched) {
    // The record a new revision publishes has to carry every id the purpose
    // may still ask for — the roles it already had, not only the edited one.
    // A role this edit REPLACES is skipped: its old model is not asked for any
    // more, and requiring it to stay admissible would strand an owner on an id
    // whose evidence has gone away.
    for (const [role, model] of Object.entries(carried))
      if (rolePurpose(role) === purpose && !(role in next))
        entry.models.add(model);
    const editedRoles = Object.entries(next).some(
      ([role, model]) =>
        rolePurpose(role) === purpose && before.roles[role] !== model,
    );
    const nextChat =
      purpose === "chat" ? next.chat ?? entry.selection.modelRef : undefined;
    const selectionMoves =
      nextChat !== undefined && nextChat !== entry.selection.modelRef;
    if (!editedRoles && !selectionMoves) continue;
    changed = true;
    for (const model of entry.models)
      if (
        !admittedModel(
          entry.adapter,
          model,
          { ...entry.selection, modelRef: model },
          entry.catalog,
        )
      )
        throw agentFailure("agent_model_execution_unverified");
    const evidence = admissionEvidenceFor(
      entry.adapter,
      entry.selection,
      entry.catalog,
    );
    // The edit mints the purpose's revision: the admission that names the ids
    // this configuration may ask for is keyed to it, and a record is immutable
    // per revision — reusing the old one could only mean dropping an id the
    // owner just added.
    let selection: ResolvedAgentSelection = {
      ...entry.selection,
      configRevision: randomUUID(),
      capabilityEvidence: [
        ...entry.selection.capabilityEvidence.filter(
          (capability) => !capability.startsWith("catalog:"),
        ),
        ...(entry.catalog ? [`catalog:${entry.catalog.revision}`] : []),
      ],
    };
    if (selectionMoves) {
      const providerRef = selectedModelRoute(
        entry.adapter,
        nextChat!,
        entry.selection.authRoute,
        evidence,
      );
      // A model that travels another provider is another route, and this edit
      // has no evidence for it: the picker's own route choice is the door for
      // that, and silently keeping the old provider would cross-wire them.
      if (!providerRef || providerRef !== entry.selection.providerRef)
        throw agentFailure("agent_model_route_unknown");
      selection = { ...selection, modelRef: nextChat!, providerRef };
    }
    configurations.push({
      purpose,
      selection,
      ...(evidence ? { evidence } : {}),
      refs: [...entry.models],
    });
  }
  return {
    expectedRevision: before.revision,
    roles: next,
    configurations: changed ? configurations : [],
  };
}

/** What the canonical local mutation published. It is the ONLY state a caller
 *  may answer from once the mutation returns: reading the installation again
 *  could name a later revision as if it were this one — or fail and report a
 *  save that had already landed. */
export type CommittedLocalAgentRoles = {
  /** The revision the locked mutation wrote. */
  revision: string;
  /** Every role the installation now stores, merged with the plan's. */
  roles: Record<string, string>;
  /** The model each purpose's committed selection names — what a cleared local
   *  role falls back to, carried out of the mutation rather than read back. */
  purposeModels: Partial<Record<AgentPurpose, string>>;
};

/** Publish a planned role edit: admission first, then one atomic mutation
 *  under the state lock, with the claim guard re-checked inside it. */
export async function commitLocalAgentRoles(
  prepared: PreparedLocalAgentRoles,
): Promise<CommittedLocalAgentRoles> {
  for (const configuration of prepared.configurations)
    if (configuration.evidence)
      await recordAdmission(
        configuration.selection,
        configuration.evidence,
        configuration.refs,
      );
  // A role edit mints a new revision for an unchanged primary model; carry its
  // effort record forward so editing a role does not quietly reset the level.
  // A primary model that MOVED gets none: the level was validated for the old one.
  const before = await readAgentState();
  for (const configuration of prepared.configurations) {
    const previous = before[`${configuration.purpose}Selection`];
    if (!previous || previous.modelRef !== configuration.selection.modelRef) continue;
    const effort = readSelectedEffort(previous.configRevision, previous.modelRef);
    if (effort)
      await recordSelectedEffort(
        configuration.selection.configRevision,
        configuration.selection.modelRef,
        effort,
      );
  }
  return mutateAgentState((state) => {
    if (state.active.length || state.queue.length)
      throw agentFailure("agent_configuration_busy");
    if (state.revision !== prepared.expectedRevision)
      throw agentFailure("agent_configuration_conflict");
    for (const configuration of prepared.configurations)
      state[`${configuration.purpose}Selection`] = configuration.selection;
    state.roles = { ...state.roles, ...prepared.roles };
    state.revision =
      prepared.configurations[0]?.selection.configRevision ?? state.revision;
    const purposeModels: Partial<Record<AgentPurpose, string>> = {};
    for (const purpose of ["background", "chat"] as const) {
      const selection = state[`${purpose}Selection`];
      if (selection) purposeModels[purpose] = selection.modelRef;
    }
    return { revision: state.revision, roles: { ...state.roles }, purposeModels };
  });
}

/**
 * Write the roles the LOCAL installation executes with — the other half of
 * `roleModels()`'s read.
 *
 * The Agent page's Models form used to write only the organization row, which
 * `modelFor` then ignores wherever the installation has spoken: the form said
 * "Saved — the next call uses it" about a value the next call never saw. This
 * is the writer that makes that sentence true for a local install: one
 * revision-checked mutation that validates each model through the same
 * admission the call itself uses, extends the purpose's durable admission so a
 * newly reported id survives the picker's cache, and refuses while a claim is
 * live rather than draining the queue.
 *
 * Hosted/API tenants and the MCP settings tools never call this: a remote
 * tenant must not mutate the Mac's installation-wide roles.
 */
export async function setLocalAgentRoles(
  roles: Readonly<Record<string, string | null>>,
  options: { expectedRevision?: string | undefined } = {},
): Promise<CommittedLocalAgentRoles> {
  return commitLocalAgentRoles(await planLocalAgentRoles(roles, options));
}

/** One bounded scan of the registered adapters, saved paths included. */
function registeredDiscovery(options: { signal?: AbortSignal | undefined } = {}) {
  return discoverInstallations(discoveryRegistry(), {
    pins: savedAgentPins(),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/** Resolve ONE candidate id back to the installation discovery returned. The
 *  id is opaque and deterministic, and the scan is re-run rather than trusted
 *  to a client-supplied path — so a request can name a candidate Engager
 *  found, and cannot name anything else. */
export async function resolveCandidate(
  candidateId: string,
  options: { signal?: AbortSignal | undefined } = {},
): Promise<DiscoveredInstallation> {
  const found = await scanCandidate(candidateId, options);
  if (!found) throw new AgentCliError("agent_candidate_unknown");
  return found;
}

/** The same resolution without a throw, for a caller that reports rather than
 *  refuses. */
async function scanCandidate(
  candidateId: string,
  options: { signal?: AbortSignal | undefined } = {},
): Promise<DiscoveredInstallation | undefined> {
  const scan = await registeredDiscovery(options);
  return scan.installations.find(
    (installation) => installation.candidateId === candidateId,
  );
}

/**
 * §8's advanced path control, resolved into an ordinary candidate.
 *
 * The browser may send a path here and nowhere else, and the path is not
 * trusted on its own: its basename must be one a REGISTERED adapter's
 * discovery declares — so `/bin/sh` or an arbitrary program is refused before
 * anything runs — and it is then probed by the same bounded discovery every
 * other candidate goes through, with the same version, identity and
 * eligibility rules. A resolved path is remembered as a scan pin, which is
 * what lets the candidate id keep resolving on the read that follows; nothing
 * is selected or executed by asking.
 */
export async function candidateFromPath(
  input: string,
  options: { signal?: AbortSignal | undefined } = {},
): Promise<{ candidateIds: string[] }> {
  const path = input.trim().startsWith("~/")
    ? join(homedir(), input.trim().slice(2))
    : input.trim();
  if (!isAbsolute(path))
    throw new AgentCliError("agent_absolute_path_required");
  const base = path.slice(path.lastIndexOf("/") + 1);
  const entry = discoveryRegistry().find(
    (candidate) =>
      candidate.adapterRegistered &&
      candidate.descriptor.discovery.executables.includes(base),
  );
  if (entry) {
    const adapterId = entry.descriptor.adapterId;
    const scan = await discoverInstallations([entry], {
      overrides: { [adapterId]: path },
      only: [adapterId],
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const found = scan.installations.find(
      (installation) => installation.absoluteExecutable === path,
    );
    if (found) {
      await rememberAgentPath(found.adapterId, found.absoluteExecutable);
      return { candidateIds: [found.candidateId] };
    }
  }
  // The path may also be the DIRECTORY holding the binary the owner meant.
  // The same bounded discovery decides, and only installations that really
  // sit at that level are accepted; several come back as several, so the
  // owner chooses in the ordinary list rather than being handed whichever
  // adapter happened to be found first.
  const directory = path;
  const scan = await discoverInstallations(discoveryRegistry(), {
    paths: [directory],
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const found = scan.installations.filter(
    (installation) => dirname(installation.absoluteExecutable) === directory,
  );
  if (found.length === 0) throw new AgentCliError("agent_candidate_unknown");
  for (const installation of found)
    await rememberAgentPath(
      installation.adapterId,
      installation.absoluteExecutable,
    );
  return { candidateIds: found.map((installation) => installation.candidateId) };
}

/** The capabilities a descriptor declares, independent of any scan. One
 *  function because the inventory and a candidate's own recheck must give the
 *  same answer — a second copy is how "eligible" comes to mean two things. */
function declaredCapabilities(adapter: AgentCliAdapter): {
  chatEligible: boolean;
  backgroundEligible: boolean;
} {
  return {
    backgroundEligible:
      adapter.descriptor.background.text &&
      adapter.descriptor.background.structured !== "none" &&
      missingBackgroundCapabilities(adapter).length === 0,
    chatEligible:
      adapter.descriptor.chat.transport === "broker" &&
      adapter.descriptor.chat.brokerTools,
  };
}

/** One candidate, its eligibility report, and the server-side paths a save
 *  needs — everything the picker and the save must agree on, resolved from ONE
 *  scan. A second nested scan per question was the public inventory's own
 *  unbounded work.
 *
 *  A candidate the inventory budget skipped is UNKNOWN, not unusable, so it
 *  gets its own bounded isolation check here: exhaustion of a shared scan must
 *  not permanently hide an installation the owner explicitly selected. The
 *  check is the same verifier execution runs, bounded by its own per-probe
 *  timeouts, and the execution path still revalidates immediately before the
 *  spawn — this only decides what the picker may offer. */
export async function candidateWithEligibility(
  candidateId: string,
  options: {
    signal?: AbortSignal | undefined;
    verifyIsolation?: IsolationVerifier | undefined;
  } = {},
): Promise<
  | {
      installation: DiscoveredInstallation;
      chatEligible: boolean;
      backgroundEligible: boolean;
      reasonCodes: readonly string[];
    }
  | undefined
> {
  const detailed = await scanAgentInventoryDetailed(options);
  const reported = detailed.inventory.installations.find(
    (installation) => installation.candidateId === candidateId,
  );
  const installation = detailed.installations.find(
    (found) => found.candidateId === candidateId,
  );
  if (!reported || !installation) return undefined;
  if (!reported.reasonCodes.includes("isolation_unchecked"))
    return {
      installation,
      chatEligible: reported.chatEligible,
      backgroundEligible: reported.backgroundEligible,
      reasonCodes: reported.reasonCodes,
    };
  const reasons = installation.reasonCodes.filter(
    (code) => code !== "isolation_unchecked",
  );
  const adapter = ADAPTERS[installation.adapterId];
  if (!adapter || !installation.versionSupported)
    return {
      installation,
      chatEligible: false,
      backgroundEligible: false,
      reasonCodes: reasons,
    };
  const declared = declaredCapabilities(adapter);
  if (!declared.chatEligible && !declared.backgroundEligible)
    return {
      installation,
      chatEligible: false,
      backgroundEligible: false,
      reasonCodes: reasons,
    };
  const refusal = await profileIsolationRefusal(
    adapter,
    installation,
    options.verifyIsolation,
    { signal: options.signal, prove: true },
  );
  if (refusal)
    return {
      installation,
      chatEligible: false,
      backgroundEligible: false,
      reasonCodes: [...reasons, refusal],
    };
  return {
    installation,
    chatEligible: declared.chatEligible,
    backgroundEligible: declared.backgroundEligible,
    reasonCodes: reasons,
  };
}

/** How long the isolation half of a scan may take, and how many probes run at
 *  once. It is a second phase after discovery, so it carries its own bound
 *  rather than borrowing the scan's remaining clock; a candidate whose check
 *  the bound cut off is reported as unchecked, never as admitted. */
const ISOLATION_LIMITS = {
  concurrentProbes: 2,
  budgetMs: 20_000,
} as const;

/** The bounds a caller may tighten — an operation with a shorter budget of its
 *  own, and a test that cannot wait twenty seconds. */
export type InventoryLimits = {
  isolationConcurrency: number;
  isolationBudgetMs: number;
};

export type AgentInventoryScanDetailed = {
  inventory: AgentInventory;
  /** The server-side installations, parallel to `inventory.installations` —
   *  what a caller resolves a candidate id against without scanning again. */
  installations: DiscoveredInstallation[];
};

/**
 * One bounded scan, normalized for a browser: the server-side absolute paths
 * are dropped, eligibility is decided from the registry rather than from the
 * presence of a file, and a discovery-only entry is reported as found but
 * unusable instead of being hidden.
 */
export async function scanAgentInventoryDetailed(
  options: {
    signal?: AbortSignal | undefined;
    /** The isolation boundary, injectable for the same reason the executor
     *  takes one: an offline host cannot satisfy a native-profile check, and
     *  an inventory that could only be exercised by weakening the check would
     *  not be exercised at all. Production never passes one. */
    verifyIsolation?: IsolationVerifier | undefined;
    limits?: Partial<InventoryLimits> | undefined;
    /** Permission to RUN an isolation self-test (which RECORDS its proof).
     *  Defaults to true — the picker's owner is waiting on the answer. A
     *  read-only scan passes false and writes nothing. */
    prove?: boolean | undefined;
    /** Ask each found CLI whether it is signed in, filling
     *  `authStatus` from the probe (US-ONE-04). Absent, no probe ran and
     *  every installation reads `unknown`: discovery alone never labels
     *  an installation Connected. The probe keeps its account string to
     *  itself — only the word reaches the inventory view. Injectable
     *  the way the isolation verifier is; `true` runs the real probe. */
    probeSignIn?:
      | boolean
      | ((
          installation: SignInInstallation,
          options?: SignInProbeOptions,
        ) => Promise<SignInProbe>)
      | undefined;
  } = {},
): Promise<AgentInventoryScanDetailed> {
  const limits: InventoryLimits = {
    isolationConcurrency:
      options.limits?.isolationConcurrency ?? ISOLATION_LIMITS.concurrentProbes,
    isolationBudgetMs:
      options.limits?.isolationBudgetMs ?? ISOLATION_LIMITS.budgetMs,
  };
  const scan = await registeredDiscovery(options);
  const startedAt = Date.now();
  const scannedAt = startedAt;
  // The isolation phase carries its own bound because it is a second phase
  // after discovery, and its own controller so that bound TEARS DOWN the
  // native probe it interrupts: an expired budget or a canceled caller aborts
  // a `--help` already in flight instead of waiting the probe's own timeout
  // out. Without this, "bounded" was only a bound on when probes started.
  const isolationController = new AbortController();
  const onOuterAbort = () => isolationController.abort();
  options.signal?.addEventListener("abort", onOuterAbort, { once: true });
  if (options.signal?.aborted) isolationController.abort();
  const isolationTimer = setTimeout(
    () => isolationController.abort(),
    limits.isolationBudgetMs,
  );
  try {
    const probed = await mapBounded(
      scan.installations,
      limits.isolationConcurrency,
      async (installation) => {
        const adapter = ADAPTERS[installation.adapterId];
        const reasons = [...installation.reasonCodes];
        // Eligibility is false until the isolation question is ANSWERED. A
        // candidate the budget skipped is reported with `isolation_unchecked`
        // and no capability at all: "we did not ask" must never read as "we
        // asked and it passed", which is exactly what a `true` here beside that
        // reason code said before.
        let chatEligible = false;
        let backgroundEligible = false;
        let isolationPending = false;
        const declared =
          adapter && installation.versionSupported
            ? declaredCapabilities(adapter)
            : undefined;
        // Isolation is asked ONLY about a candidate that is otherwise usable,
        // and about the exact binary that was found: the answer costs two
        // bounded `--help` probes, and a version discovery already refused has
        // nothing for them to change. A refusal is reported as a reason code
        // rather than hidden — "found, but Engager will not run it on this
        // machine" is exactly the state §3's blocked-by-execution-checks row
        // has to explain.
        if (
          adapter &&
          declared &&
          (declared.chatEligible || declared.backgroundEligible)
        ) {
          if (isolationController.signal.aborted) {
            isolationPending = true;
            reasons.push("isolation_unchecked");
          } else {
            const refusal = await profileIsolationRefusal(
              adapter,
              {
                absoluteExecutable: installation.absoluteExecutable,
                observedVersion: installation.observedVersion,
                executableIdentity: installation.executableIdentity,
              },
              options.verifyIsolation,
              { signal: isolationController.signal, prove: options.prove ?? true },
            );
            // A probe the budget killed is unchecked, not refused: a refusal
            // would tell the owner their installation failed a check Engager
            // never finished asking.
            if (isolationController.signal.aborted) {
              isolationPending = true;
              reasons.push("isolation_unchecked");
            } else if (refusal) reasons.push(refusal);
            else {
              chatEligible = declared.chatEligible;
              backgroundEligible = declared.backgroundEligible;
            }
          }
        }
        return {
          installation,
          chatEligible,
          backgroundEligible,
          reasons,
          isolationPending,
        };
      },
    );
    // The sign-in half, only when the caller asked: one bounded probe per
    // found installation, beside the isolation phase's own bound rather
    // than inside it. A probe that throws is "unknown" for that row —
    // it never withholds the inventory the scan already earned.
    const signInProbe =
      options.probeSignIn === true
        ? probeAgentSignIn
        : typeof options.probeSignIn === "function"
          ? options.probeSignIn
          : undefined;
    const authStatuses = signInProbe
      ? await mapBounded(
          probed,
          limits.isolationConcurrency,
          async (entry) => {
            try {
              const probe = await signInProbe(entry.installation, {
                ...(options.signal ? { signal: options.signal } : {}),
              });
              return authStatusForProbe(probe);
            } catch {
              return "unknown" as const;
            }
          },
        )
      : undefined;
    return {
      installations: scan.installations,
      inventory: {
        installations: probed.map(
          (entry, index): AgentInstallation => ({
            candidateId: entry.installation.candidateId,
            adapterId: entry.installation.adapterId,
            displayName: entry.installation.displayName,
            observedVersion: entry.installation.observedVersion,
            minimumVersion:
              ADAPTERS[entry.installation.adapterId]?.descriptor
                .minimumExecutableVersion,
            chatEligible: entry.chatEligible,
            backgroundEligible: entry.backgroundEligible,
            authRoutes:
              ADAPTERS[entry.installation.adapterId]?.descriptor
                .supportedAuthRoutes ?? [],
            reasonCodes: entry.reasons,
            // Discovery never labels an installation Connected: a found
            // executable is not an authenticated one, and the picker must not
            // imply it is. Only a probe the caller asked for fills this.
            authStatus: authStatuses?.[index] ?? "unknown",
            location: entry.installation.location,
            discoveredAt: scannedAt,
          }),
        ),
        scannedAt,
        supported: supportedAgents(),
        // A skipped isolation probe is incompleteness, and the scan says so
        // rather than presenting "not checked" as "not usable".
        partial:
          scan.partial || probed.some((entry) => entry.isolationPending),
        warnings: scan.warnings,
      },
    };
  } finally {
    clearTimeout(isolationTimer);
    options.signal?.removeEventListener("abort", onOuterAbort);
  }
}

export async function scanAgentInventory(
  options: {
    signal?: AbortSignal | undefined;
    verifyIsolation?: IsolationVerifier | undefined;
    limits?: Partial<InventoryLimits> | undefined;
    prove?: boolean | undefined;
    probeSignIn?:
      | boolean
      | ((
          installation: SignInInstallation,
          options?: SignInProbeOptions,
        ) => Promise<SignInProbe>)
      | undefined;
  } = {},
): Promise<AgentInventory> {
  return (await scanAgentInventoryDetailed(options)).inventory;
}

/** One agent as the first-run window needs it: plainly usable now, coming
 *  soon, or neither — with no absolute path and no account name, because the
 *  window renders this decoded shape and decides nothing from the filesystem
 *  itself (INV-20). `hidden` marks the community pair setup never shows;
 *  Settings › Agent keeps listing them as today. */
export type AgentSetupEntry = {
  id: string;
  name: string;
  supported: boolean;
  comingSoon: boolean;
  found: boolean;
  usable: boolean;
  version?: string | undefined;
  minimumVersion?: string | undefined;
  candidateId?: string | undefined;
  /** Where it was found (`PATH`, `homebrew`, `app_bundle`, …) — a category
   *  word, never a path — for the failure card's "Show details". */
  location?: string | undefined;
  reasons: string[];
  hidden?: true | undefined;
};

export type AgentSetupInventory = {
  agents: AgentSetupEntry[];
  /** The scan was cut short, so an unfound row may still be looking. */
  partial: boolean;
};

/** The one reason that makes an otherwise admitted Codex unusable for a scan
 *  that does not prove: its sandbox self-test has not run on this binary yet. */
const CODEX_UNPROVEN = "isolation_unverified:codex_sandbox_unproven";

/** The six names of the setup board, in board order, then the hidden
 *  community pair. Labels only — supported/comingSoon/hidden are read from
 *  the support matrix's tiers below, never restated here. */
const SETUP_AGENTS: readonly { id: string; name: string }[] = [
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "gemini", name: "Gemini" },
  { id: "grok", name: "Grok" },
  { id: "opencode", name: "OpenCode" },
  { id: "cursor", name: "Cursor" },
  { id: "openclaw", name: "OpenClaw" },
  { id: "hermes", name: "Hermes" },
];

/**
 * The setup view of one ordinary scan — the `engager agent-setup inventory`
 * answer. It is the picker's inventory re-cut per AGENT rather than per
 * installation: `usable` is true only for a found, supported-version,
 * isolation-admitted supported agent, which is exactly what eligibility
 * already means, so setup cannot offer what selection would refuse. The
 * scan is read-only: nothing is written and nothing leaves the machine —
 * `prove: false` is what keeps that true, because proving Codex isolation
 * RECORDS a sandbox proof under the state dir. A Codex with no proof on
 * file yet is therefore still `usable` here, so the owner can reach the test
 * request that earns the proof: `connectLocalAgent` runs the real isolation
 * gate with `prove` set, refuses a failing sandbox before any inference, and
 * saves nothing. Unproven is "not asked yet", never "refused" — a refusal
 * carries its own reason code and stays unusable.
 */
export async function scanAgentSetupInventory(
  options: {
    signal?: AbortSignal | undefined;
    verifyIsolation?: IsolationVerifier | undefined;
    limits?: Partial<InventoryLimits> | undefined;
  } = {},
): Promise<AgentSetupInventory> {
  const { inventory } = await scanAgentInventoryDetailed({
    ...options,
    prove: false,
  });
  const agents = SETUP_AGENTS.map(({ id, name }): AgentSetupEntry => {
    const tier = supportTier(id);
    const supported = tier === "supported";
    const found = inventory.installations.filter(
      (installation) => installation.adapterId === id,
    );
    // Several installations of one agent collapse to the best answer: a
    // usable one when there is one, otherwise the first discovery found.
    const best =
      found.find(
        (installation) =>
          installation.chatEligible ||
          installation.backgroundEligible ||
          (installation.reasonCodes.length === 1 && installation.reasonCodes[0] === CODEX_UNPROVEN),
      ) ?? found[0];
    return {
      id,
      name,
      supported,
      comingSoon: tier === "coming_soon",
      found: best !== undefined,
      usable:
        supported &&
        best !== undefined &&
        (best.chatEligible ||
          best.backgroundEligible ||
          (best.reasonCodes.length === 1 && best.reasonCodes[0] === CODEX_UNPROVEN)),
      ...(best?.observedVersion ? { version: best.observedVersion } : {}),
      ...(best?.minimumVersion
        ? { minimumVersion: best.minimumVersion }
        : {}),
      ...(best ? { candidateId: best.candidateId, location: best.location } : {}),
      reasons: best ? [...best.reasonCodes] : [],
      ...(tier === "community" ? { hidden: true as const } : {}),
    };
  });
  return { agents, partial: inventory.partial };
}

/** The saved selection that is about this exact installation, if any. It is
 *  what makes a catalog read describe the route and profile the owner actually
 *  configured rather than the adapter's first one — a cache entry for another
 *  route would not match, and the saved selection would lose its list. */
function savedSelectionFor(found: DiscoveredInstallation) {
  for (const purpose of ["background", "chat"] as const) {
    const selection = storedAgentSelection(purpose);
    if (
      selection?.adapterId === found.adapterId &&
      selection.executableIdentity === found.executableIdentity &&
      selection.observedVersion === found.observedVersion
    )
      return selection;
  }
  return undefined;
}

/** Everything a catalog read is bound to, plus the executable the read runs.
 *  The adapter contract is deliberately absent: it is read from the adapter at
 *  the call, and a binding that restated it could disagree with the descriptor
 *  the entry is matched against. */
export function catalogBindingFor(
  adapter: AgentCliAdapter,
  found: DiscoveredInstallation,
  authRoute?: string,
): Omit<CatalogBinding, "adapterContractVersion"> & {
  absoluteExecutable: string;
} {
  const saved = savedSelectionFor(found);
  const route =
    authRoute ??
    saved?.authRoute ??
    adapter.descriptor.supportedAuthRoutes[0] ??
    "native_login";
  // A saved selection answers only for the route it was saved on: switching
  // routes in Advanced is switching accounts/credentials, so the provider and
  // the profile root come from the route being read, not from the old pin.
  const savedMatches = saved?.authRoute === route ? saved : undefined;
  const declared = adapter.descriptor.supportedModelRoutes.find(
    (candidate) =>
      !candidate.authRoutes || candidate.authRoutes.includes(route),
  );
  return {
    adapterId: found.adapterId,
    absoluteExecutable: found.absoluteExecutable,
    executableIdentity: found.executableIdentity,
    observedVersion: found.observedVersion,
    authRoute: route,
    providerRef:
      savedMatches?.providerRef ?? declared?.providerRef ?? adapter.provider,
    ...(savedMatches?.authStorePath
      ? { authStorePath: savedMatches.authStorePath }
      : {}),
  };
}

/** The catalog for one discovered installation, read and stored under its own
 *  binding. Kept separate from candidate resolution so a caller that already
 *  resolved the installation does not scan a second time. */
export async function catalogForInstallation(
  adapter: AgentCliAdapter,
  found: DiscoveredInstallation,
  options: {
    signal?: AbortSignal | undefined;
    refresh?: boolean;
    /** The auth route to read for, when the owner chose one. It must be one
     *  this adapter declares; the caller validates that, and a route the
     *  descriptor does not carry has no catalog to read. */
    authRoute?: string | undefined;
    /** The isolation verifier to admit this installation with — the inventory
     *  path's own override, taken here for the same reason: a fixture binary
     *  is admitted by a fixture verifier, never by a weaker rule. */
    verifyIsolation?: IsolationVerifier;
  } = {},
): Promise<AgentModelCatalog> {
  // Read-only model discovery is independent of execution admission: a newer
  // CLI can report its models while selection and execution stay blocked until
  // that exact version satisfies their existing checks. A list route that
  // spawns the binary against the owner's own agent home is the exception —
  // that is the isolation R-10 refuses to assume, so an installation execution
  // would refuse is read through the configured/manual fallback instead of
  // being run.
  const metadata = await listRouteFor(adapter, found, {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.verifyIsolation
      ? { verifyIsolation: options.verifyIsolation }
      : {}),
  });
  const binding = catalogBindingFor(adapter, found, options.authRoute);
  const previous = await storedCatalog(binding, adapter.descriptor);
  // A failed read is never "fresh": the cache is a list, and a read that
  // returned none must not stop the next open from asking again. A preserved
  // last-known list keeps its own age, so it re-reads on the same window.
  if (
    !options.refresh &&
    previous &&
    !previous.error &&
    Date.now() - previous.fetchedAt < CATALOG_FRESH_MS
  )
    return previous;
  const read = await readModelCatalog(
    adapter,
    binding,
    metadata,
    options.signal ? { signal: options.signal } : {},
  );
  // §3's offline row: a refresh that failed keeps the last known options, with
  // the age of the read that produced them and the error that replaced them.
  // The binding match above is what keeps that promise from crossing binaries,
  // routes or profiles.
  const catalog: AgentModelCatalog =
    read.error && previous
      ? { ...previous, stale: true, partial: true, error: read.error }
      : read;
  // A re-read of an UNCHANGED catalog keeps its revision. The revision is what
  // a save is checked against, and minting a new one per read would make every
  // second read invalidate the options the owner is looking at — a conflict
  // against a catalog that never moved. Only a catalog whose contents actually
  // changed is a new revision, which is the fact the check is about.
  const stable =
    previous && catalogFingerprint(previous) === catalogFingerprint(catalog)
      ? { ...catalog, revision: previous.revision }
      : catalog;
  await storeCatalog(stable);
  return stable;
}

/**
 * The metadata routes this installation may be read through: the adapter's own,
 * minus a list route that would spawn the binary against the owner's real
 * credentials without being admitted to run at all.
 *
 * ADMITTED MEANS WHAT IT MEANS FOR EXECUTION — the declared version AND the
 * isolation verifier execution itself uses (`eligibilityFor` above runs the
 * same pair). A version this build declares but whose profile nothing has
 * verified is exactly the installed Codex of today: refused before inference
 * (R-10), and so refused this route too.
 *
 * Dropping the route rather than refusing the read is what keeps the picker on
 * §6's existing fallback — the configured id, then manual entry — with copy
 * that says which of the two happened, instead of an error the owner cannot
 * act on.
 */
async function listRouteFor(
  adapter: AgentCliAdapter,
  found: DiscoveredInstallation,
  options: {
    signal?: AbortSignal | undefined;
    verifyIsolation?: IsolationVerifier;
  },
): Promise<AdapterMetadataDescriptor | undefined> {
  const metadata = adapter.metadata;
  if (!metadata?.readsOwnerAuthStore) return metadata;
  const admitted =
    found.versionSupported &&
    (await profileIsolationAdmitted(
      adapter,
      found,
      options.verifyIsolation,
      options.signal ? { signal: options.signal } : {},
    ));
  if (admitted) return metadata;
  const { listModels, ...withoutList } = metadata;
  return {
    ...withoutList,
    listUnsupported: `${adapter.name} reports its models only from a copy Engager is admitted to run, and this one is not — choose the configured model or enter a model id.`,
  };
}

/**
 * The catalog for one discovered candidate, read through its adapter's own
 * route and persisted bound to that exact executable. A candidate with no
 * execution adapter returns the empty catalog its registry entry implies
 * rather than being refused — the picker shows why nothing is selectable.
 */
export async function catalogForCandidate(
  candidateId: string,
  options: { signal?: AbortSignal | undefined; refresh?: boolean } = {},
): Promise<AgentModelCatalog> {
  const found = await scanCandidate(candidateId, options);
  if (!found) throw new AgentCliError("agent_candidate_unknown");
  const adapter = ADAPTERS[found.adapterId];
  if (!adapter) throw new AgentCliError("agent_adapter_unsupported");
  return catalogForInstallation(adapter, found, options);
}

/** What a catalog revision is ABOUT: the binding and the options a save would
 *  care about. Read time and status are deliberately absent — a refresh that
 *  failed, or one that answered from the same list minutes later, is not a
 *  change to what the owner may choose. */
function catalogFingerprint(catalog: AgentModelCatalog): string {
  return JSON.stringify({
    adapterId: catalog.adapterId,
    providerRef: catalog.providerRef,
    executableIdentity: catalog.executableIdentity,
    observedVersion: catalog.observedVersion,
    adapterContractVersion: catalog.adapterContractVersion,
    authRoute: catalog.authRoute,
    authStorePath: catalog.authStorePath ?? null,
    listUnsupported: catalog.listUnsupported,
    options: catalog.options,
  });
}

export function resolveAgentCliAdapter(): AgentCliAdapter {
  const selection =
    currentUsageContext()?.localAgentSelection ??
    storedAgentSelection("background");
  const pin = process.env.ENGAGER_AGENT_CLI?.trim().toLowerCase();
  if (selection && pin && pin !== "auto" && pin !== selection.adapterId)
    throw new AgentCliError("agent_selection_conflict");
  const id =
    selection?.adapterId ??
    (pin !== "auto" ? pin : undefined) ??
    (currentUsageContext()?.agentBin ? "claude" : undefined);
  if (!id) throw new AgentCliError("agent_selection_required");
  const adapter = ADAPTERS[id];
  if (!adapter) throw new AgentCliError("agent_adapter_unsupported");
  if (missingBackgroundCapabilities(adapter).length)
    throw new AgentCliError("agent_background_unsupported");
  return adapter;
}

/** DEAD COMPATIBILITY PATH — no production caller since P2b. In-app chat runs
 * through `chat/broker.ts`, which resolves the selection itself and refuses an
 * adapter without `chat.brokerTools`. Both supported adapters now declare the
 * broker transport, so what this returns says nothing about how a turn runs; it
 * survives only for the legacy CLI-driver tests and the Agent page fixtures
 * until they are retired with `chat_sessions.claude_session_id`. */
export function resolveChatAdapter(): ChatCapableAdapter {
  const selected = storedAgentSelection("chat");
  const adapter = selected
    ? ADAPTERS[selected.adapterId]
    : Object.values(ADAPTERS).find((entry) => entry.chat);
  if (!adapter?.chat) throw new AgentCliError("agent_chat_transport_pending");
  return adapter as ChatCapableAdapter;
}

/**
 * One row per BACKGROUND role, answered by the SAME resolver the first call
 * answers with: `admittedModel`, over the catalog this installation actually
 * reported, the selection's own admission record, and the adapter's declared
 * route behind them.
 *
 * It used to ask the static support matrix alone. That made every role of a
 * working install report as failing the moment the owner chose a model their
 * installation reports and this build does not list — an amber pill per role,
 * four ✗ lines out of doctor and `declared: false` on the wire, for calls the
 * same selection answers in two seconds. The matrix keeps what it owns, the
 * published vocabulary and the price table; which ids a role may ask for is an
 * evidence question, and two authorities answering it differently is exactly
 * what the owner was reading.
 *
 * `chat` is a role of `config.models` too, and it is filtered OUT rather than
 * judged here: the evidence this function holds is the BACKGROUND selection's,
 * while a chat model's admission belongs to the chat pin and its own binding.
 * Two installations is a configuration the product supports, and judging the
 * chat model by the background catalog reported a chat that works as a failing
 * row under “In the background”, with a doctor ✗ and a non-zero exit behind it.
 * `chatSelection` is where chat answers for itself, and the wire contract has
 * always promised these rows are the background ones.
 */
export function agentRoleModels(
  adapter: AgentCliAdapter,
  models: Readonly<Record<string, string>>,
  selection: ResolvedAgentSelection | undefined,
  catalog: AgentModelCatalog | undefined,
  unoffered: Readonly<Record<string, UnofferedRoleModel>> = {},
): AgentRoleModel[] {
  return Object.entries(models)
    .filter(([role]) => rolePurpose(role) === "background")
    .map(([role, model]) => ({
      role,
      model,
      declared: admittedModel(adapter, model, selection, catalog),
      // A role running in place of a model its installation does not offer
      // says so on the wire, so a probe reading `model` is never left to
      // wonder why it is not the configured one.
      ...(unoffered[role] ? { configured: unoffered[role].configured } : {}),
    }));
}

/** The stored overrides a DB-capable caller resolved — what makes the probe
 *  agree with what inference will actually do when the owner set either. */
export type AgentCliStatusOverrides = {
  /** The effective role map (`getModelSettings().effective`); the roles'
   *  own resolution serves when omitted. */
  models?: Readonly<Record<string, string>>;
  /** The roles that map substitutes for a model the installation does not
   *  offer (`resolvedRoleModels().unoffered`), so the probe can say so. */
  unoffered?: Readonly<Record<string, UnofferedRoleModel>>;
  /** The stored claude spawn path; claude-only, like every reader of it. */
  claudeBin?: string | null;
};

/**
 * How long one probe answer is reused. `get_status` is polled every ~15s
 * by a connected agent and `getSetupState` reads it with a tenant transaction
 * open, so an unmemoized probe pays a `--version`, a `--help` (and, for Codex,
 * a `features list`) and a full hash of the selected CLI on every tick. Short
 * enough that an owner who fixes a pin and reloads the Agent page sees it.
 */
const STATUS_MEMO_MS = 30_000;

/**
 * A REPORT, never an authorization. Nothing on the execution path reads this:
 * `runAgentCli` verifies the selection and isolation itself before admission
 * and again immediately before the spawn, remembering a pass only for the
 * binary exactly as stated at that pass (`run.ts`). A replaced binary never
 * matches the remembered key; memoizing what the Agent page prints is a
 * separate, purely presentational reuse.
 */
let memo: { key: string; at: number; status: Promise<AgentCliStatus> } | null =
  null;

/**
 * What the answer is ABOUT, so a change asks a new question rather than reading
 * a stale answer to the old one: the selection's own revision (every
 * `configureLocalAgent` mints a fresh one), the executable it names and that
 * file's size and mtime, the env pins selection reads, and the caller's stored
 * overrides. Size and mtime are the cheap half of `executableIdentity` — the
 * hash stays where the decision is made, and a replaced binary that somehow
 * kept both is still refused before every spawn, never admitted by this memo.
 *
 * `null` means "do not memo": there is no selection to be about, and that case
 * spawns nothing anyway — while a newly configured install must not read a
 * remembered "no agent selected" for the next 30 seconds.
 *
 * The stored catalog's REVISION is part of it because `declared` reads that
 * catalog: a picker refresh that newly lists a role's model would otherwise be
 * answered with the remembered "not admitted" for up to 30 seconds, on the same
 * screen that just listed it. Read here separately from the answer's own read
 * on purpose — this asks what the question is about, and a key derived from the
 * body's read could not tell that it had moved.
 */
async function statusMemoKey(
  overrides: AgentCliStatusOverrides | undefined,
): Promise<string | null> {
  try {
    const selected = storedAgentSelection("background");
    if (!selected) return null;
    const file = await stat(selected.absoluteExecutable);
    const adapter = ADAPTERS[selected.adapterId];
    const catalog = adapter
      ? await storedCatalog(selected, adapter.descriptor)
      : undefined;
    return JSON.stringify([
      selected.adapterId,
      selected.absoluteExecutable,
      selected.configRevision,
      storedAgentSelection("chat")?.configRevision ?? null,
      file.size,
      file.mtimeMs,
      process.env.ENGAGER_AGENT_CLI ?? "",
      process.env.ENGAGER_AGENT_CLI_BIN ?? "",
      process.env.ENGAGER_CODEX_BIN ?? "",
      overrides?.claudeBin ?? "",
      overrides?.models ?? null,
      overrides?.unoffered ?? null,
      catalog?.revision ?? null,
    ]);
  } catch {
    return null;
  }
}

/**
 * Read-only probe for `doctor`, the setup-state read and the Agent page: which
 * adapter selection resolves, whether its binary is there, what it can do, the
 * model each background role would ask it for — and, when selection or the
 * isolation profile refuses, that refusal verbatim. Never throws, which is what
 * lets the memo hold the promise itself and hand every concurrent caller one
 * probe.
 */
export function agentCliStatusAsync(
  overrides?: AgentCliStatusOverrides,
): Promise<AgentCliStatus> {
  return (async () => {
    const key = await statusMemoKey(overrides);
    const now = Date.now();
    if (key !== null && memo?.key === key && now - memo.at < STATUS_MEMO_MS)
      return memo.status;
    const status = (async (): Promise<AgentCliStatus> => {
      try {
        const adapter = resolveAgentCliAdapter();
        const selected = storedAgentSelection("background");
        if (!selected) throw new AgentCliError("agent_selection_required");
        // Presence only. Identity, version and profile are the business of the
        // verifiers below, which read the same file once between them — asking
        // `discoverLocalAgents` first hashed it and spawned `--version` a
        // second time for an answer this probe never used.
        const installed = await access(
          selected.absoluteExecutable,
          constants.X_OK,
        ).then(
          () => true,
          () => false,
        );
        let refusal: string | undefined;
        try {
          if (
            adapter.id === "claude" &&
            overrides?.claudeBin &&
            overrides.claudeBin !== selected.absoluteExecutable
          )
            throw new AgentCliError("agent_selection_conflict");
          await verifyAgentSelection(adapter.descriptor, selected);
          await verifyIsolationProfile(adapter, selected);
        } catch (error) {
          refusal =
            error instanceof Error ? error.message : "isolation_unverified";
        }
        const roles = overrides?.models
          ? { models: overrides.models, unoffered: overrides.unoffered }
          : resolvedRoleModels();
        return {
          id: adapter.id,
          name: adapter.name,
          bin: selected.absoluteExecutable,
          installed,
          supportsJsonSchema: adapter.supportsJsonSchema,
          models: agentRoleModels(
            adapter,
            roles.models,
            selected,
            await storedCatalog(selected, adapter.descriptor),
            roles.unoffered,
          ),
          localExecution: {
            configurationRevision: selected.configRevision,
            observedVersion: selected.observedVersion,
            authRoute: selected.authRoute,
            authStatus: "unknown",
            isolationProfileAdmitted: !refusal,
            background: adapter.descriptor.background,
            chat: adapter.descriptor.chat,
            nativeBrowser: false,
            providerValidation: "pending_R10",
          },
          ...(refusal ? { error: refusal } : {}),
        };
      } catch (error) {
        return {
          id: null,
          name: null,
          bin: null,
          installed: false,
          supportsJsonSchema: false,
          models: [],
          error: error instanceof Error ? error.message : "agent_unavailable",
        };
      }
    })().then(withChatSelection);
    if (key !== null) memo = { key, at: now, status };
    return status;
  })();
}

function withChatSelection(status: AgentCliStatus): AgentCliStatus {
  const chat = storedAgentSelection("chat");
  return { ...status, chatSelection: chat ? { adapterId: chat.adapterId, model: chat.modelRef, configRevision: chat.configRevision, transport: ADAPTERS[chat.adapterId]!.descriptor.chat.transport, authStatus: "unknown", streamMode: "events" } : null };
}
