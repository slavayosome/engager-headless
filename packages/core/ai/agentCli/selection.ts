import { createHash, randomUUID } from "node:crypto";
import { agentExecutablePath, isolatedAuthStore } from "./authStore";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  discoverLocalAgents,
  executableIdentity,
  inspectExecutable,
} from "./discovery";
import { currentUsageContext } from "../usage";
import {
  declaredRouteFor,
  installationCatalog,
  offeredModelIds,
  resolveModelRoute,
  sameFamilyModel,
} from "./catalog";
import {
  admissionBoundTo,
  catalogFromAdmission,
  readAdmission,
  recordAdmission,
} from "./admission";
import { verifyIsolationProfile, type IsolationVerifier } from "./isolation";
import {
  agentFailure,
  agentStateDirectory,
  mutateAgentState,
  selectionSchema,
} from "./state";
import type {
  AgentCliAdapter,
  AgentModelCatalog,
  AgentPurpose,
  LocalAgentDescriptor,
  ResolvedAgentSelection,
  UnofferedRoleModel,
} from "./types";
import { executableVersionSupported } from "./types";

export function storedAgentSelection(
  purpose: AgentPurpose,
): ResolvedAgentSelection | undefined {
  try {
    const state = JSON.parse(
      readFileSync(join(agentStateDirectory(), "state.json"), "utf8"),
    );
    if (state.version !== 1) throw agentFailure("agent_state_invalid");
    const value = state[`${purpose}Selection`];
    return value ? selectionSchema.parse(value) : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw agentFailure("agent_state_invalid");
  }
}

/**
 * Whether this adapter may be asked for this model, given the installation
 * evidence the selection carries — §6's retirement of the static array as the
 * SOLE local-model admission rule.
 *
 * The distinction it keeps is the one the plan draws: the support matrix stays
 * exactly what it is, the published vocabulary and the price table, while
 * whether a given call may name an id is decided here from the route the id
 * travels and the evidence the installation actually produced. A model the
 * catalog reported on this executable, this version and this auth route gets
 * through; the same id with no evidence, or with evidence bound to a different
 * binary, does not.
 */
export function admittedModel(
  adapter: Pick<AgentCliAdapter, "id" | "descriptor">,
  modelRef: string,
  selection: ResolvedAgentSelection | undefined,
  catalog: AgentModelCatalog | undefined,
): boolean {
  if (!selection)
    // No selection to be about: the question is the vocabulary one — does this
    // id travel a route this adapter declares — because there is no auth route
    // to narrow it with yet, and refusing here would say an adapter cannot be
    // asked for a model the support matrix publishes for it.
    return declaredRouteFor(adapter, modelRef, authRouteFor(adapter)) !== undefined;
  return (
    routeMatchesProvider(adapter, { ...selection, modelRef }, catalog) !==
    undefined
  );
}

/**
 * The evidence binding: a catalog authorizes a model only for the exact
 * executable, version, contract, auth route, provider and profile that
 * produced it.
 *
 * This is the check every reader of a catalog makes, and a selection being
 * PREPARED is not exempt from it: a catalog handed to `prepareAgentSelection`
 * describes the executable, version, route and profile it was read from, and
 * admitting an id from it for anything else would stamp foreign evidence with
 * the values in front of us.
 */
function catalogMatchesSelection(
  adapter: Pick<AgentCliAdapter, "id" | "descriptor">,
  selection: Pick<
    ResolvedAgentSelection,
    | "adapterId"
    | "executableIdentity"
    | "observedVersion"
    | "authRoute"
    | "providerRef"
    | "authStorePath"
  >,
  catalog: AgentModelCatalog,
): boolean {
  return (
    catalog.adapterId === selection.adapterId &&
    catalog.executableIdentity === selection.executableIdentity &&
    catalog.observedVersion === selection.observedVersion &&
    catalog.authRoute === selection.authRoute &&
    catalog.providerRef === selection.providerRef &&
    catalog.adapterContractVersion === adapter.descriptor.adapterContractVersion &&
    (catalog.authStorePath ?? undefined) === (selection.authStorePath ?? undefined)
  );
}

/**
 * The evidence that admits `selection.modelRef`, in one resolution shared by
 * preparation, the LLM admission check and the executor's revalidation.
 *
 * A live catalog entry wins when it is about this exact selection and names the
 * id. Otherwise the selection's own admission record is consulted: that is what
 * keeps a model the installation reported working after the picker's cache is
 * evicted or a refresh no longer lists it.
 *
 * The record is bound at BIRTH — the executable, version, adapter contract,
 * auth route, provider and profile the catalog read was about — and the reader
 * compares every one of them against the selection and the adapter in front of
 * it. A changed contract, a replaced binary, a second profile or a re-pointed
 * provider all read as "nothing admits this id", which is the honest answer:
 * the report that justified the model described something that no longer
 * exists. A declared model never needs a record at all — the adapter's route is
 * its evidence — so this can only ever NARROW what the cache used to admit.
 */
function evidenceFor(
  adapter: Pick<AgentCliAdapter, "id" | "descriptor">,
  selection: Pick<
    ResolvedAgentSelection,
    | "adapterId"
    | "executableIdentity"
    | "observedVersion"
    | "authRoute"
    | "providerRef"
    | "authStorePath"
    | "modelRef"
    | "configRevision"
  >,
  catalog: AgentModelCatalog | undefined,
): AgentModelCatalog | undefined {
  const bound =
    catalog && catalogMatchesSelection(adapter, selection, catalog)
      ? catalog
      : undefined;
  if (bound?.options.some((option) => option.id === selection.modelRef))
    return bound;
  const record = readAdmission(selection.configRevision);
  if (
    !record ||
    !admissionBoundTo(
      record,
      selection,
      adapter.descriptor.adapterContractVersion,
    )
  )
    return bound;
  // The record's own report, for whichever id the caller is asking about: a
  // role the owner changed after admission must answer from the SAME evidence
  // that admitted it, and a rebound selection revision carries its own record.
  return catalogFromAdmission(record);
}

/**
 * The provider route `modelRef` travels under this selection, or undefined when
 * nothing admits it. The ONE answer every caller shares: selection, the LLM
 * and the picker's eligibility column all read this rather than restating a
 * route rule of their own.
 */
export function selectedModelRoute(
  adapter: Pick<AgentCliAdapter, "id" | "descriptor">,
  modelRef: string,
  authRoute: string,
  catalog: AgentModelCatalog | undefined,
  binding?: Pick<
    ResolvedAgentSelection,
    | "adapterId"
    | "executableIdentity"
    | "observedVersion"
    | "providerRef"
    | "authStorePath"
    | "configRevision"
  >,
): string | undefined {
  const evidence = binding
    ? evidenceFor(adapter, { ...binding, authRoute, modelRef }, catalog)
    : catalog;
  const decision = resolveModelRoute(adapter, modelRef, {
    authRoute,
    ...(evidence ? { catalog: evidence } : {}),
  });
  if (decision.eligible) return decision.providerRef;
  // An adapter whose descriptor declares a route the published matrix does not
  // list — the offline conformance fixture is the only one — still answers its
  // own vocabulary, which is what its registry entry means. It is asked
  // SECOND, so the stricter evidence question decides whenever it can, and
  // with the same auth-route condition applied — a route that declares the
  // model but does not carry this auth route is exactly the cross-wiring this
  // check exists to refuse.
  return declaredRouteFor(adapter, modelRef, authRoute);
}

/** The one auth route to ask a vocabulary question with, for an adapter that
 *  declares several: the first it supports. A catalog-evidenced model answers
 *  on its own route and never reaches this fallback. */
function authRouteFor(
  adapter: Pick<AgentCliAdapter, "id" | "descriptor">,
): string {
  return adapter.descriptor.supportedAuthRoutes[0] ?? "";
}

/** The same lookup for a CALLER that already knows which provider the
 *  selection claims, so a cross-wired provider is refused rather than silently
 *  answered with the route the model really travels. */
function routeMatchesProvider(
  adapter: Pick<AgentCliAdapter, "id" | "descriptor">,
  selection: Pick<
    ResolvedAgentSelection,
    | "adapterId"
    | "executableIdentity"
    | "observedVersion"
    | "modelRef"
    | "providerRef"
    | "authRoute"
    | "authStorePath"
    | "configRevision"
  >,
  catalog: AgentModelCatalog | undefined,
): string | undefined {
  const providerRef = selectedModelRoute(
    adapter,
    selection.modelRef,
    selection.authRoute,
    catalog,
    selection,
  );
  if (providerRef !== undefined && providerRef !== selection.providerRef)
    return undefined;
  return providerRef;
}

export function storedAgentRoles(): Record<string, string> {
  try {
    const state = JSON.parse(
      readFileSync(join(agentStateDirectory(), "state.json"), "utf8"),
    );
    if (
      state.version !== 1 ||
      !state.roles ||
      Object.values(state.roles).some((value) => typeof value !== "string")
    )
      throw agentFailure("agent_state_invalid");
    return state.roles;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw agentFailure("agent_state_invalid");
  }
}

/**
 * Whether a selection's installation has said it does NOT offer `modelRef`:
 * `offered` — its last complete model list — omits the id, and the id is not
 * the model the purpose was chosen with. That one is the owner's explicit pick,
 * through a connection check, even when typed by hand — it is never
 * second-guessed here.
 *
 * False when `offered` is undefined, which is what an installation that
 * reported no complete list gives. Silence is not absence, and the question
 * then belongs to admission alone.
 *
 * `offered` is required rather than defaulted: a caller asking about many ids
 * reads the list ONCE, and a default re-read it for every id of a list the
 * installation had not reported.
 */
export function installationOmits(
  selection: Pick<ResolvedAgentSelection, "modelRef">,
  modelRef: string,
  offered: ReadonlySet<string> | undefined,
): boolean {
  return (
    modelRef !== selection.modelRef &&
    offered !== undefined &&
    !offered.has(modelRef)
  );
}

/** `installationOmits` for a caller with one id to ask about. */
export const installationOmitsModel = (
  selection: ResolvedAgentSelection,
  modelRef: string,
): boolean =>
  installationOmits(
    selection,
    modelRef,
    offeredModelIds(installationCatalog(selection)),
  );

/** Substitutions already reported by this process, so each is one log line. */
const reportedUnoffered = new Set<string>();

/**
 * The model each role RUNS on this installation: the self-heal for a role
 * pinned to an id the installed agent does not offer.
 *
 * Applied where the role map is resolved (`roleModels`), so `modelFor`, the
 * status probe and the Agent page all name the model the call will actually
 * ask for — and it heals at the next process start, on an install nobody
 * touched. A role whose purpose has a selection, and whose model that
 * installation's complete list omits, runs the newest model that list names in
 * the SAME FAMILY (`sameFamilyModel`): a sonnet becomes the installation's
 * newest sonnet, so a substitution never moves a role onto a dearer or slower
 * tier. Only when the list names no model of that family — or the adapter has
 * no family to name — does the role run the model its purpose was chosen with.
 *
 * Nothing is written. The stored role stays on the Agent page beside the model
 * running in its place, until the owner chooses one. An installation whose
 * stored selection cannot be read is left as configured: that is a state
 * problem for the surfaces that own it, and a role resolution that threw for it
 * would take every model call down with it.
 */
export function installedRoleModels<R extends string>(
  models: Readonly<Record<R, string>>,
): {
  models: Record<R, string>;
  unoffered: Partial<Record<R, UnofferedRoleModel>>;
} {
  type Installation = {
    selection: ResolvedAgentSelection;
    offered: ReadonlySet<string> | undefined;
  };
  const installations = new Map<AgentPurpose, Installation | null>();
  const installationFor = (purpose: AgentPurpose): Installation | null => {
    if (!installations.has(purpose)) {
      let installation: Installation | null = null;
      try {
        const selection = storedAgentSelection(purpose);
        if (selection)
          installation = {
            selection,
            offered: offeredModelIds(installationCatalog(selection)),
          };
      } catch {
        // Left as configured: see above.
      }
      installations.set(purpose, installation);
    }
    return installations.get(purpose) ?? null;
  };
  const resolved = { ...models } as Record<R, string>;
  const unoffered: Partial<Record<R, UnofferedRoleModel>> = {};
  for (const role of Object.keys(models) as R[]) {
    const purpose = rolePurpose(role);
    const installation = installationFor(purpose);
    const configured = models[role];
    const offered = installation?.offered;
    if (
      !installation ||
      !offered ||
      !installationOmits(installation.selection, configured, offered)
    )
      continue;
    const { selection } = installation;
    const using =
      sameFamilyModel(selection.adapterId, configured, [
        ...offered,
        selection.modelRef,
      ]) ?? selection.modelRef;
    resolved[role] = using;
    unoffered[role] = { configured, using };
    const reported = `${selection.configRevision}:${role}:${configured}`;
    if (!reportedUnoffered.has(reported)) {
      reportedUnoffered.add(reported);
      console.warn(
        `[agent] ${role} names ${configured}, which the installed ${selection.adapterId} ${selection.observedVersion} does not offer; running ${using} in its place`,
      );
    }
  }
  return { models: resolved, unoffered };
}

export function assertSelectionRoute(
  descriptor: LocalAgentDescriptor,
  selection: ResolvedAgentSelection,
  evidence?: AgentModelCatalog | undefined,
): void {
  if (selection.adapterId !== descriptor.adapterId)
    throw agentFailure("agent_selection_conflict");
  if (!executableVersionSupported(descriptor, selection.observedVersion))
    throw agentFailure("agent_version_unsupported");
  if (!descriptor.supportedAuthRoutes.includes(selection.authRoute))
    throw agentFailure("agent_auth_route_unsupported");
  // The model question goes through the SAME resolver execution uses, so a
  // model the installation reported is admissible here and a model whose
  // provider this auth route does not carry is refused here — exactly as it
  // would be at the first call. A second check written beside this one is how
  // a selection comes to store cleanly and fail hours later.
  if (
    !routeMatchesProvider({ id: descriptor.adapterId, descriptor }, selection, evidence)
  )
    throw agentFailure("agent_model_route_unknown");
  if (
    selection.purpose === "background" &&
    (!descriptor.background.text || descriptor.background.structured === "none")
  )
    throw agentFailure("agent_background_unsupported");
  // Both purposes are checked against the surface that would serve them. A chat
  // pin on an agent with no chat transport used to store cleanly and take the
  // owner's working in-app chat away — `resolveChatAdapter` reads this pin, so
  // the refusal only reached them at the next turn, naming nothing that would
  // point back at the configure command that caused it.
  if (
    selection.purpose === "chat" &&
    descriptor.chat.transport === "pending_broker"
  )
    throw agentFailure("agent_chat_transport_pending");
  if (selection.missingCapabilities.length)
    throw agentFailure("agent_capability_missing");
  if (selection.authStorePath && !isAbsolute(selection.authStorePath))
    throw agentFailure("agent_auth_store_path_invalid");
  if (descriptor.adapterId === "claude" || descriptor.adapterId === "codex")
    isolatedAuthStore(descriptor.adapterId, selection.authStorePath);
  if (selection.authStorePath && descriptor.adapterId === "opencode")
    throw agentFailure("agent_auth_store_unsupported");
}

export async function verifyAgentSelection(
  descriptor: LocalAgentDescriptor,
  selection: ResolvedAgentSelection,
  evidence?: AgentModelCatalog | undefined,
): Promise<void> {
  assertSelectionRoute(descriptor, selection, evidence);
  const identity = await executableIdentity(selection.absoluteExecutable);
  if (
    identity.realPath !== selection.realPath ||
    identity.executableIdentity !== selection.executableIdentity
  )
    throw agentFailure("agent_executable_changed");
  const version = (
    await inspectExecutable(selection.absoluteExecutable, ["--version"])
  ).stdout.match(/\b\d+\.\d+\.\d+\b/)?.[0];
  if (version !== selection.observedVersion)
    throw agentFailure("agent_executable_changed");
}

/** The ids a selection must be able to name, recorded from the catalog that
 *  admitted them. Only the ids this configuration actually uses: persisting the
 *  whole reported list would duplicate the cache in the durable state. */
function admittedIds(
  catalog: AgentModelCatalog | undefined,
  modelRefs: readonly string[],
): string[] {
  if (!catalog) return [];
  const wanted = new Set(modelRefs);
  return [
    ...new Set(
      catalog.options
        .filter((option) => wanted.has(option.id))
        .map((option) => option.id),
    ),
  ];
}

export async function prepareAgentSelection(
  descriptor: LocalAgentDescriptor,
  input: {
    purpose: AgentPurpose;
    absoluteExecutable: string;
    modelRef: string;
    providerRef: string;
    authRoute: string;
    authStorePath?: string;
  },
  evidence?: AgentModelCatalog | undefined,
  admittedRefs: readonly string[] = [],
): Promise<ResolvedAgentSelection> {
  const identity = await executableIdentity(input.absoluteExecutable);
  const observedVersion = (
    await inspectExecutable(input.absoluteExecutable, ["--version"])
  ).stdout.match(/\b\d+\.\d+\.\d+\b/)?.[0];
  if (!observedVersion) throw agentFailure("agent_version_unknown");
  const adapter = { id: descriptor.adapterId, descriptor };
  // The route the id travels, asked first of the raw evidence so a catalog
  // that really is about this installation can still admit a model the
  // published matrix does not declare. The answer is only kept when the
  // evidence survives the binding check below; otherwise the declared
  // vocabulary answers alone, and a dynamic id is refused rather than
  // restamped with this binary's identity.
  const claimed = selectedModelRoute(
    adapter,
    input.modelRef,
    input.authRoute,
    evidence,
  );
  const bound =
    evidence &&
    claimed !== undefined &&
    catalogMatchesSelection(
      adapter,
      {
        adapterId: descriptor.adapterId,
        executableIdentity: identity.executableIdentity,
        observedVersion,
        authRoute: input.authRoute,
        providerRef: claimed,
        ...(input.authStorePath ? { authStorePath: input.authStorePath } : {}),
      },
      evidence,
    )
      ? evidence
      : undefined;
  const providerRef =
    bound && claimed !== undefined
      ? claimed
      : selectedModelRoute(adapter, input.modelRef, input.authRoute, undefined);
  if (!providerRef) throw agentFailure("agent_model_route_unknown");
  // Every model this purpose may be asked for is checked against the SAME
  // bound evidence the primary id is: a role the owner pointed at a reported
  // model must be admissible at the call that asks for it, and one the
  // evidence does not cover is refused here, before any record is written.
  for (const ref of admittedRefs) {
    const decision = resolveModelRoute(adapter, ref, {
      authRoute: input.authRoute,
      ...(bound ? { catalog: bound } : {}),
    });
    if (!decision.eligible) throw agentFailure(decision.reasonCode);
  }
  const admitted = admittedIds(bound, [input.modelRef, ...admittedRefs]);
  const selection = {
    ...input,
    ...identity,
    observedVersion,
    adapterId: descriptor.adapterId,
    providerRef,
    configRevision: randomUUID(),
    capabilityEvidence: [
      `fixture-profile:${descriptor.isolationProfileVersion}`,
      "auth:unknown",
      "R-10:pending",
      // Only when the installation's own catalog is what admitted an id: the
      // record then names the read that justified it, so an audit can tell a
      // published id from one this exact executable reported.
      ...(admitted.length && bound ? [`catalog:${bound.revision}`] : []),
    ],
    missingCapabilities: [],
  };
  // The record goes down BEFORE anything can activate this selection, and it
  // names the contract, route, provider and profile that produced it — see
  // `admission.ts` for why this is a sidecar rather than a selection field.
  // A configuration that fails later simply orphans it.
  if (admitted.length && bound) {
    await recordAdmission(selection, bound, admittedRefs);
  }
  assertSelectionRoute(descriptor, selection, bound);
  return selection;
}

/** Every role a configure call may write, and which purpose owns it. Stated
 *  once so the validator and the mutation cannot disagree about what a legal
 *  role map is. */
export const ROLE_PURPOSES: Readonly<Record<string, AgentPurpose>> = {
  filter: "background",
  writer: "background",
  writerPremium: "background",
  chat: "chat",
};

/** Which purpose owns a stored role. A role the map does not know — a legacy
 *  key an older build wrote — reads as background, which is the lane every
 *  role but `chat` has always belonged to. */
export function rolePurpose(role: string): AgentPurpose {
  return ROLE_PURPOSES[role] ?? (role === "chat" ? "chat" : "background");
}

/**
 * One prepared configuration for one or more purposes, fully validated before
 * ANY of it is written.
 *
 * §7 requires this shape because two sequential `configureLocalAgent()` calls
 * can leave a half-configured installation: the first lands, the second
 * refuses, and the owner is left with a chat pin their background pin
 * disagrees with. Preparing all purposes first and mutating once is what makes
 * "both, or neither" true rather than aspirational.
 */
export type PreparedAgentConfiguration = {
  descriptor: LocalAgentDescriptor;
  purposes: readonly AgentPurpose[];
  selections: { purpose: AgentPurpose; selection: ResolvedAgentSelection }[];
  roles: Record<string, string>;
  /** Every purpose was asked for and only chat could serve them. */
  backgroundUnavailable: boolean;
  /** The installation catalog this configuration was prepared against, when
   *  one was read. Carried so the later verification asks the SAME evidence
   *  question the preparation answered — an id the installation reported is
   *  admissible at the connection check too, not only at preparation. */
  evidence?: AgentModelCatalog | undefined;
};

export async function prepareSharedAgentConfiguration(
  descriptor: LocalAgentDescriptor,
  input: {
    absoluteExecutable: string;
    modelRef: string;
    authRoute: string;
    authStorePath?: string;
    purposes: readonly AgentPurpose[];
    roles?: Readonly<Record<string, string>>;
  },
  evidence?: AgentModelCatalog | undefined,
): Promise<PreparedAgentConfiguration> {
  if (input.purposes.length === 0)
    throw agentFailure("agent_purpose_required");
  const purposes = [...new Set(input.purposes)];
  const roles = { ...(input.roles ?? {}) };
  for (const role of Object.keys(roles))
    if (!ROLE_PURPOSES[role]) throw agentFailure("agent_role_unknown");
  for (const role of Object.keys(roles))
    if (!purposes.includes(ROLE_PURPOSES[role]!))
      throw agentFailure("agent_role_purpose_conflict");
  // A fresh shared choice defaults every purpose's roles to the one model the
  // owner picked; an explicit split leaves the other purpose's roles alone.
  for (const purpose of purposes) {
    for (const [role, owner] of Object.entries(ROLE_PURPOSES))
      if (owner === purpose) roles[role] ??= input.modelRef;
  }
  let backgroundUnavailable = false;
  const selections: PreparedAgentConfiguration["selections"] = [];
  for (const purpose of purposes) {
    // A role is validated with the purpose it BELONGS to, so a background role
    // that cannot be served degrades with its purpose instead of aborting a
    // chat configuration the owner can still use — and a chat role that cannot
    // be served always fails, because there is nothing left to configure.
    const owned = Object.fromEntries(
      Object.entries(roles).filter(([role]) => ROLE_PURPOSES[role] === purpose),
    );
    try {
      selections.push({
        purpose,
        selection: await prepareAgentSelection(
          descriptor,
          {
            purpose,
            absoluteExecutable: input.absoluteExecutable,
            modelRef: input.modelRef,
            providerRef:
              descriptor.supportedModelRoutes[0]?.providerRef ??
              descriptor.adapterId,
            authRoute: input.authRoute,
            ...(input.authStorePath
              ? { authStorePath: input.authStorePath }
              : {}),
          },
          evidence,
          // Every model this purpose may be asked for, not only the primary
          // one: a role the owner pointed at a reported model must still be
          // admissible at the call that asks for it, checked against the
          // catalog's own binding rather than against whatever was handed in.
          Object.values(owned),
        ),
      });
    } catch (error) {
      // §3: an installation that can serve chat and no background role keeps a
      // working conversation and an explicitly unavailable background status.
      // Any other refusal fails the whole configuration, because a partial
      // write is exactly what this operation exists to prevent.
      if (purpose === "background" && purposes.includes("chat")) {
        backgroundUnavailable = true;
        for (const role of Object.keys(owned)) delete roles[role];
      } else throw error;
    }
  }
  return {
    descriptor,
    purposes,
    selections,
    roles,
    backgroundUnavailable,
    ...(evidence ? { evidence } : {}),
  };
}

/** Commit a prepared configuration under the state lock, atomically.
 *
 * `expectedRevision` is the revision the caller read before it ran its
 * connection check. A concurrent change is a refreshable conflict rather than
 * a last-write-wins overwrite: by the time Connect is pressed, the answer the
 * owner saw described a state that no longer exists. */
export async function commitAgentConfiguration(
  prepared: PreparedAgentConfiguration,
  options: { expectedRevision?: string | undefined } = {},
): Promise<{
  configured: ResolvedAgentSelection[];
  backgroundUnavailable: boolean;
  revision: string;
}> {
  return mutateAgentState((state) => {
    if (state.active.length || state.queue.length)
      throw agentFailure("agent_configuration_busy");
    if (
      options.expectedRevision !== undefined &&
      options.expectedRevision !== state.revision
    )
      throw agentFailure("agent_configuration_conflict");
    for (const { purpose, selection } of prepared.selections) {
      if (purpose === "chat" && !prepared.descriptor.chat.brokerTools)
        throw agentFailure("agent_chat_transport_pending");
      state[`${purpose}Selection`] = selection;
    }
    state.revision = prepared.selections[0]?.selection.configRevision ?? randomUUID();
    state.roles = { ...state.roles, ...prepared.roles };
    return {
      configured: prepared.selections.map((entry) => entry.selection),
      backgroundUnavailable: prepared.backgroundUnavailable,
      revision: state.revision,
    };
  });
}

/**
 * Validate a configuration without activating it — §7's draft-selection path.
 *
 * The whole point is that the connection test must not have to overwrite the
 * working selection to find out whether a candidate works: a failed smoke
 * check would then have already taken the owner's agent away.
 */
export async function validateAgentConfiguration(
  adapter: AgentCliAdapter,
  prepared: PreparedAgentConfiguration,
  verifyIsolation: IsolationVerifier = verifyIsolationProfile,
): Promise<void> {
  for (const { selection } of prepared.selections) {
    if (selection.adapterId !== adapter.id)
      throw agentFailure("agent_selection_conflict");
    await verifyAgentSelection(adapter.descriptor, selection, prepared.evidence);
    await verifyIsolation(adapter, selection);
  }
}

export async function configureLocalAgent(
  descriptor: LocalAgentDescriptor,
  input: Parameters<typeof prepareAgentSelection>[1],
  roles: Record<string, string> = {},
): Promise<ResolvedAgentSelection> {
  const selection = await prepareAgentSelection(descriptor, input);
  const offered = offeredModelIds(installationCatalog(selection));
  for (const [role, model] of Object.entries(roles)) {
    if ((role === "chat") !== (input.purpose === "chat"))
      throw agentFailure("agent_role_purpose_conflict");
    if (!["filter", "writer", "writerPremium", "chat"].includes(role))
      throw agentFailure("agent_role_unknown");
    assertSelectionRoute(descriptor, { ...selection, modelRef: model });
    // The same offer every other writer of a role honours: a model the
    // installation's complete list omits is not one a role may be set to.
    if (installationOmits(selection, model, offered))
      throw agentFailure("agent_model_execution_unverified");
  }
  await mutateAgentState((state) => {
    if (state.active.length || state.queue.length)
      throw agentFailure("agent_configuration_busy");
    state.revision = selection.configRevision;
    state[`${input.purpose}Selection`] = selection;
    state.roles = { ...state.roles, ...roles };
  });
  return selection;
}

/**
 * The evidence a role edit EXTENDS: the live catalog for this binding, plus the
 * ids an existing bound record already admitted. The old record must come
 * along because the edit mints a new revision — a record is read by the
 * revision it was written for, so the new one has to carry every id the
 * configuration may still ask for, not only the one being changed.
 */
export function admissionEvidenceFor(
  adapter: Pick<AgentCliAdapter, "id" | "descriptor">,
  selection: ResolvedAgentSelection,
  catalog: AgentModelCatalog | undefined,
): AgentModelCatalog | undefined {
  const bound =
    catalog && catalogMatchesSelection(adapter, selection, catalog)
      ? catalog
      : undefined;
  const record = readAdmission(selection.configRevision);
  const admitted =
    record &&
    admissionBoundTo(
      record,
      selection,
      adapter.descriptor.adapterContractVersion,
    )
      ? catalogFromAdmission(record)
      : undefined;
  if (!bound) return admitted;
  if (!admitted) return bound;
  return {
    ...bound,
    options: [
      ...bound.options,
      ...admitted.options.filter(
        (option) => !bound.options.some((known) => known.id === option.id),
      ),
    ],
  };
}

/** Only this route's auth-location reference is retained, never its contents. */
export function agentChildEnvironment(
  selection: ResolvedAgentSelection,
): NodeJS.ProcessEnv {
  const env: Record<string, string> = {
    HOME: process.env.HOME ?? homedir(),
    PATH: agentExecutablePath(),
    TERM: "dumb",
  };
  if (process.env.USER) env.USER = process.env.USER;
  if (selection.adapterId === "claude") {
    const authStore = isolatedAuthStore("claude", selection.authStorePath);
    if (authStore) env.CLAUDE_CONFIG_DIR = authStore;
    env.DISABLE_AUTOUPDATER = "1";
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  }
  if (selection.adapterId === "codex")
    env.CODEX_HOME = isolatedAuthStore("codex", selection.authStorePath) ?? join(env.HOME!, ".codex");
  return env as NodeJS.ProcessEnv;
}

export function selectionFingerprint(
  selection: ResolvedAgentSelection,
): string {
  return createHash("sha256").update(JSON.stringify(selection)).digest("hex");
}

/** Preserve an owner's existing explicit pin once, without selecting a vendor
 * from PATH order. Ambiguous installations still require an explicit path. */
export async function importExistingAgentPin(
  adapter: AgentCliAdapter,
  modelRef: string,
): Promise<ResolvedAgentSelection> {
  const legacyBin =
    adapter.id === "claude" ? currentUsageContext()?.agentBin : undefined;
  const pin = process.env.ENGAGER_AGENT_CLI;
  if (!legacyBin && pin !== adapter.id)
    throw agentFailure("agent_selection_required");
  const bin = legacyBin ?? adapter.bin();
  if (bin !== adapter.id && !isAbsolute(bin))
    throw agentFailure("agent_absolute_path_required");
  const inventory = await discoverLocalAgents([adapter.descriptor], {
    only: [adapter.id],
    ...(isAbsolute(bin) ? { paths: [], overrides: { [adapter.id]: bin } } : {}),
  });
  if (inventory.length !== 1) throw agentFailure("agent_selection_required");
  const candidate = inventory[0]!;
  if (!candidate.compatible) throw agentFailure("agent_version_unsupported");
  const roles = Object.fromEntries(
    Object.entries(currentUsageContext()?.models ?? {}).filter(
      ([role]) => role !== "chat",
    ),
  );
  return configureLocalAgent(
    adapter.descriptor,
    {
      purpose: "background",
      absoluteExecutable: candidate.absoluteExecutable,
      modelRef,
      providerRef: adapter.provider,
      authRoute: "native_login",
      ...(adapter.id === "claude" && process.env.CLAUDE_CONFIG_DIR
        ? { authStorePath: process.env.CLAUDE_CONFIG_DIR }
        : {}),
      ...(adapter.id === "codex" && process.env.CODEX_HOME
        ? { authStorePath: process.env.CODEX_HOME }
        : {}),
    },
    roles,
  );
}
