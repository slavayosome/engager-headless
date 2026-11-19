import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { declaredModel } from "@engager/common/agent-support";
import { agentFailure, agentStateDirectory, withAgentLock } from "./state";
import type {
  AdapterMetadataDescriptor,
  AgentCliAdapter,
  AgentModelCatalog,
  EligibleModelOption,
  LocalAgentDescriptor,
  ModelMetadataContext,
  NormalizedModelOption,
  ResolvedAgentSelection,
} from "./types";
import { ADAPTER_CONTRACT_VERSIONS } from "./types";

/**
 * HOW LONG one catalog read may take, and how much of it is kept. Both are
 * bounds the picker discloses rather than tuning knobs: the scan's own
 * deadline is separate (§5), and a catalog that cannot answer inside this one
 * reports that honestly instead of hanging the screen that asked.
 */
export const CATALOG_LIMITS = {
  probeTimeoutMs: 15_000,
  maxOptions: 200,
  /** A settings file is a local read; anything slower is a reader that is not
   *  the narrow one this operation promises, and the manual fallback is the
   *  honest answer. */
  configuredReadMs: 2_000,
} as const;

/** A catalog older than this is still shown — with its age — but a NEW
 *  selection against it has to be re-read first. Ninety seconds is shorter
 *  than any realistic editing session on the picker and longer than the round
 *  trip between choosing an installation and choosing a model. */
export const CATALOG_FRESH_MS = 90_000;

const optionSchema = z
  .object({
    id: z.string().min(1),
    label: z.string(),
    providerRef: z.string(),
    reportedDefault: z.boolean().optional(),
    efforts: z.array(z.string()).max(12).optional(),
    defaultEffort: z.string().optional(),
    certainty: z.enum(["listed", "configured", "manual"]),
  })
  .strict();

/** The same alphabet the stored selection accepts (`state.ts`). A level outside
 *  it is dropped here, so it can never be offered, saved, or put into argv. */
const EFFORT_LEVEL = /^[a-z][a-z0-9_-]{0,23}$/;

function normalizeEfforts(raw: {
  efforts?: readonly string[] | undefined;
  defaultEffort?: string | undefined;
}): Pick<NormalizedModelOption, "efforts" | "defaultEffort"> {
  const efforts = [...new Set((raw.efforts ?? []).filter((level) => EFFORT_LEVEL.test(level)))].slice(0, 12);
  if (!efforts.length) return {};
  return {
    efforts,
    ...(raw.defaultEffort && efforts.includes(raw.defaultEffort)
      ? { defaultEffort: raw.defaultEffort }
      : {}),
  };
}
const catalogSchema = z
  .object({
    adapterId: z.string(),
    providerRef: z.string(),
    executableIdentity: z.string(),
    observedVersion: z.string(),
    adapterContractVersion: z.string(),
    authRoute: z.string(),
    authStorePath: z.string().optional(),
    revision: z.string(),
    fetchedAt: z.number(),
    source: z.string(),
    listUnsupported: z.boolean(),
    partial: z.boolean(),
    stale: z.boolean().optional(),
    /** Mutable on purpose: one normalization pass rewrites the reported
     *  default onto the option it names. */
    options: z.array(optionSchema),
    error: z.string().optional(),
  })
  .strict();

/** The whole cache file. One entry per BINDING rather than one per adapter:
 *  the owner may keep two versions of one agent, or run one binary on two auth
 *  routes, and reading for the second must not overwrite what is known about
 *  the first — that is how a working saved selection loses the list that
 *  admitted it. `storedCatalog` matches on the binding fields, so an entry
 *  written by an older build under an adapter key still matches. */
const cacheSchema = z
  .object({
    version: z.literal(1),
    catalogs: z.record(catalogSchema),
  })
  .strict();

export type AgentCatalogCache = z.infer<typeof cacheSchema>;

/** What a catalog entry is about: exactly what must match for it to authorize
 *  a model. `providerRef` and `authStorePath` are part of it because a list
 *  read for one provider or one profile is not evidence for another. */
export type CatalogBinding = Pick<
  ResolvedAgentSelection,
  | "adapterId"
  | "executableIdentity"
  | "observedVersion"
  | "authRoute"
  | "providerRef"
> & {
  adapterContractVersion: string;
  authStorePath?: string | undefined;
};

function bindingOf(
  selection: Pick<
    ResolvedAgentSelection,
    | "adapterId"
    | "executableIdentity"
    | "observedVersion"
    | "authRoute"
    | "providerRef"
    | "authStorePath"
  >,
  descriptor: Pick<LocalAgentDescriptor, "adapterContractVersion">,
): CatalogBinding {
  return {
    adapterId: selection.adapterId,
    executableIdentity: selection.executableIdentity,
    observedVersion: selection.observedVersion,
    authRoute: selection.authRoute,
    providerRef: selection.providerRef,
    adapterContractVersion: descriptor.adapterContractVersion,
    ...(selection.authStorePath
      ? { authStorePath: selection.authStorePath }
      : {}),
  };
}

/** Whether this entry is about exactly this binary/route/profile. */
export function catalogBoundTo(
  catalog: AgentModelCatalog,
  binding: CatalogBinding,
): boolean {
  return (
    catalog.adapterId === binding.adapterId &&
    catalog.executableIdentity === binding.executableIdentity &&
    catalog.observedVersion === binding.observedVersion &&
    catalog.adapterContractVersion === binding.adapterContractVersion &&
    catalog.authRoute === binding.authRoute &&
    catalog.providerRef === binding.providerRef &&
    (catalog.authStorePath ?? undefined) === (binding.authStorePath ?? undefined)
  );
}

function catalogKey(binding: CatalogBinding): string {
  return [
    binding.adapterId,
    binding.executableIdentity,
    binding.observedVersion,
    binding.adapterContractVersion,
    binding.authRoute,
    binding.providerRef,
    binding.authStorePath ?? "",
  ].join("|");
}

function cacheFile(): string {
  return join(agentStateDirectory(), "catalogs.json");
}

/**
 * The cache is deliberately a SEPARATE file from `state.json`. §7's preference
 * — leave the queue/claim shape alone where a metadata cache is enough — is
 * also the safety property: a corrupt or half-written catalog can never make
 * an in-flight claim unreadable, and deleting the cache can never lose a
 * selection. It is never consulted for admission either; only
 * `resolveModelRoute` decides that, from the catalog it is handed.
 */
export async function readCatalogCache(): Promise<AgentCatalogCache> {
  try {
    return cacheSchema.parse(
      JSON.parse(await readFile(cacheFile(), "utf8")),
    );
  } catch {
    return { version: 1, catalogs: {} };
  }
}

export async function writeCatalogCache(
  cache: AgentCatalogCache,
): Promise<void> {
  const directory = agentStateDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `${randomUUID()}.catalog.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(cache), { mode: 0o600 });
    await rename(temporary, cacheFile());
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

/** One read-modify-write under the cache's own lock, so two concurrent reads
 *  for different installations cannot each start from the same file and have
 *  the later rename discard the other's entry. The lock is separate from the
 *  queue's: a metadata refresh must never hold up a claim. */
async function mutateCatalogCache<T>(
  change: (cache: AgentCatalogCache) => T,
): Promise<T> {
  return withAgentLock("catalogs", async () => {
    const cache = await readCatalogCache();
    const result = change(cache);
    await writeCatalogCache(cache);
    return result;
  });
}

export async function storeCatalog(catalog: AgentModelCatalog): Promise<void> {
  await mutateCatalogCache((cache) => {
    const binding = bindingOf(catalog, catalog);
    // Re-key on every store and drop any entry about the same binding, so a
    // legacy adapter-keyed entry is replaced rather than shadowing this one.
    for (const [key, entry] of Object.entries(cache.catalogs))
      if (key !== catalogKey(binding) && catalogBoundTo(entry, binding))
        delete cache.catalogs[key];
    cache.catalogs[catalogKey(binding)] = catalog;
  });
}

/**
 * The stored catalog for one binding, but only when it is about the exact
 * executable, version, contract, auth route, provider and profile an execution
 * would use. A binding mismatch reads as `undefined`: the honest answer is
 * "nothing is known about this installation", and a filter that returned the
 * stale entry anyway is how a model listed for the previous binary gets
 * admitted for the new one.
 */
export async function storedCatalog(
  selection: Pick<
    ResolvedAgentSelection,
    | "adapterId"
    | "executableIdentity"
    | "observedVersion"
    | "authRoute"
    | "providerRef"
    | "authStorePath"
  >,
  descriptor: Pick<LocalAgentDescriptor, "adapterContractVersion">,
): Promise<AgentModelCatalog | undefined> {
  const binding = bindingOf(selection, descriptor);
  const cache = await readCatalogCache();
  return Object.values(cache.catalogs).find((catalog) =>
    catalogBoundTo(catalog, binding),
  );
}

/**
 * The list the INSTALLATION a selection names last reported — that binary and
 * version, on that auth route, provider and profile, under the adapter
 * contract Engager runs it with — read synchronously for the role resolution,
 * which stands outside every async boundary.
 *
 * The synchronous twin of `storedCatalog`, bound the same way: a list read
 * under another contract is not evidence about what this build may run, and it
 * must not drive a substitution or a refusal that execution would then
 * contradict. An adapter with no pinned contract (`ADAPTER_CONTRACT_VERSIONS`)
 * has no installation list to read.
 */
export function installationCatalog(
  selection: Pick<
    ResolvedAgentSelection,
    | "adapterId"
    | "executableIdentity"
    | "observedVersion"
    | "authRoute"
    | "providerRef"
    | "authStorePath"
  >,
): AgentModelCatalog | undefined {
  const adapterContractVersion = ADAPTER_CONTRACT_VERSIONS[selection.adapterId];
  if (adapterContractVersion === undefined) return undefined;
  let cache: AgentCatalogCache;
  try {
    cache = cacheSchema.parse(JSON.parse(readFileSync(cacheFile(), "utf8")));
  } catch {
    return undefined;
  }
  const binding = bindingOf(selection, { adapterContractVersion });
  return Object.values(cache.catalogs).find((catalog) =>
    catalogBoundTo(catalog, binding),
  );
}

/**
 * The ids an installation's own list offers, or undefined when it reported no
 * complete list — a settings-file answer, a truncated read, an empty one. Only
 * a complete list can say an id is NOT offered; anything less says nothing
 * about the ids it did not name, and a caller must not read silence as absence.
 */
export function offeredModelIds(
  catalog: AgentModelCatalog | null | undefined,
): ReadonlySet<string> | undefined {
  if (!catalog || catalog.listUnsupported || catalog.partial) return undefined;
  if (catalog.options.length === 0) return undefined;
  return new Set(catalog.options.map((option) => option.id));
}

/**
 * The tier token in an adapter's own model ids — the name a vendor keeps while
 * the version moves. Only where it is unambiguous: Claude's four and Gemini's
 * three. An adapter without an entry has no family, so nothing is guessed for it.
 */
const MODEL_FAMILY: Readonly<Record<string, RegExp>> = {
  claude: /(?:^|-)(haiku|sonnet|opus|fable)(?:-|\[|$)/,
  gemini: /-(flash-lite|flash|pro)(?:-|$)/,
};

function modelFamily(adapterId: string, modelId: string): string | undefined {
  return MODEL_FAMILY[adapterId]?.exec(modelId)?.[1];
}

/** The numbers in an id once its release date and context suffix are gone:
 *  `claude-sonnet-4-5-20250929` is 4.5, `claude-opus-5-5[1m]` is 5.5. */
function modelVersion(modelId: string): number[] {
  return (
    modelId
      .replace(/\[[^\]]*\]$/, "")
      .replace(/-\d{8}$/, "")
      .match(/\d+/g) ?? []
  ).map(Number);
}

/** Whether `a` is a newer release than `b`, a context variant (`[1m]`) ranking
 *  below its plain id. */
function newerModel(a: string, b: string): boolean {
  const left = modelVersion(a);
  const right = modelVersion(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return !a.includes("[") && b.includes("[");
}

/**
 * The newest of `candidates` in the same model family as `configured`, or
 * undefined when none shares it. A stored role that names an unlisted id is
 * moved to the same TIER — a sonnet stays a sonnet — and never to a dearer or
 * slower one, so the substitution costs what the owner chose. An earlier
 * candidate wins a tie.
 */
export function sameFamilyModel(
  adapterId: string,
  configured: string,
  candidates: Iterable<string>,
): string | undefined {
  const family = modelFamily(adapterId, configured);
  if (family === undefined) return undefined;
  let newest: string | undefined;
  for (const id of candidates)
    if (
      modelFamily(adapterId, id) === family &&
      (newest === undefined || newerModel(id, newest))
    )
      newest = id;
  return newest;
}

/**
 * The route an id travels on this ADAPTER, with no auth route and no
 * installation asked — the vocabulary question the support matrix publishes,
 * answered from one place instead of a second list.
 *
 * It exists for the two callers that have no selection to be about: the
 * status probe and the LLM admission check when this process has resolved no
 * selection yet. Choosing a model for an actual save goes through
 * `resolveModelRoute` with the auth route, which is the stricter question.
 */
export function declaredRouteFor(
  adapter: Pick<AgentCliAdapter, "id" | "descriptor">,
  modelRef: string,
  authRoute?: string | undefined,
): string | undefined {
  const id = declaredModel(modelRef, adapter.id)?.id;
  return adapter.descriptor.supportedModelRoutes.find(
    (route) =>
      (route.models.includes(modelRef) ||
        (id !== undefined && route.models.includes(id))) &&
      (authRoute === undefined ||
        !route.authRoutes ||
        route.authRoutes.includes(authRoute)),
  )?.providerRef;
}

/**
 * Which provider route an id travels, and whether the route admits it.
 *
 * This is §6's "one model-route resolver". It answers with the SUPPORT
 * METADATA question (is this id in the adapter's declared route?) and the
 * EVIDENCE question (did this installation actually report it?) kept apart,
 * because the two are allowed to disagree: a newly returned id is admissible
 * while it is absent from the price table, and a declared id the installation
 * never listed stays usable because the owner's own configured default is
 * evidence enough for a route that already admits it.
 */
export type ModelRouteDecision =
  | {
      eligible: true;
      providerRef: string;
      /** How the id was admitted: the adapter's declared route, or the
       *  installation's own report. */
      evidence: "declared" | "catalog";
    }
  | { eligible: false; reasonCode: string };

export function resolveModelRoute(
  adapter: Pick<AgentCliAdapter, "id" | "descriptor">,
  modelRef: string,
  evidence: {
    catalog?: AgentModelCatalog | undefined;
    authRoute: string;
  },
): ModelRouteDecision {
  const declared = declaredModel(modelRef, adapter.id);
  const catalogOption = evidence.catalog?.options.find(
    (option) => option.id === modelRef,
  );
  // A listed model whose provider the selected auth route does not carry is
  // still refused: the catalog answers availability, the route answers
  // permission, and §6 keeps the isolation/route registries enforced.
  const routeFor = (providerRef: string) =>
    adapter.descriptor.supportedModelRoutes.find(
      (route) =>
        route.providerRef === providerRef &&
        (!route.authRoutes || route.authRoutes.includes(evidence.authRoute)),
    );
  if (catalogOption) {
    const route = routeFor(catalogOption.providerRef);
    if (route)
      return {
        eligible: true,
        providerRef: route.providerRef,
        evidence: "catalog",
      };
    // Reported by the installation, but a provider this auth route does not
    // carry — or none at all. That is an execution-evidence problem, not an
    // unknown-id one, and the two send the owner to different fixes.
    return {
      eligible: false,
      reasonCode: declared
        ? "agent_model_route_unknown"
        : "agent_model_execution_unverified",
    };
  }
  if (declared) {
    const route = adapter.descriptor.supportedModelRoutes.find(
      (candidate) =>
        candidate.models.includes(declared.id) &&
        (!candidate.authRoutes ||
          candidate.authRoutes.includes(evidence.authRoute)),
    );
    if (route)
      return {
        eligible: true,
        providerRef: route.providerRef,
        evidence: "declared",
      };
    return { eligible: false, reasonCode: "agent_model_route_unknown" };
  }
  return { eligible: false, reasonCode: "agent_model_route_unknown" };
}

/** An id the owner typed. It is marked `manual` and UNVERIFIED — §6's third
 *  step — and it is still refused unless its route admits it. */
export function manualOption(
  adapter: Pick<AgentCliAdapter, "id" | "descriptor">,
  modelRef: string,
  authRoute: string,
): EligibleModelOption {
  const decision = resolveModelRoute(adapter, modelRef, { authRoute });
  return {
    id: modelRef,
    label: modelRef,
    providerRef: decision.eligible ? decision.providerRef : "unknown",
    certainty: "manual",
    eligible: decision.eligible,
    ...(decision.eligible ? {} : { reasonCode: decision.reasonCode }),
  };
}

/** Map one reported id onto the wire contract. Eligibility is deliberately
 *  NOT decided here: see `NormalizedModelOption`. */
function normalizeReported(
  providerRef: string,
  raw: {
    id: string;
    label?: string | undefined;
    reportedDefault?: boolean | undefined;
    efforts?: readonly string[] | undefined;
    defaultEffort?: string | undefined;
  },
): NormalizedModelOption {
  const id = raw.id.trim();
  return {
    id,
    label: raw.label?.trim() || id,
    // A `provider/model` id names its own provider; one without a prefix
    // travels the provider this catalog was read for. Getting this wrong is
    // how a list read for OpenAI comes to advertise an Ollama model as
    // available on the OpenAI auth route.
    providerRef: id.includes("/") ? (id.split("/")[0] ?? providerRef) : providerRef,
    ...(raw.reportedDefault ? { reportedDefault: true } : {}),
    ...normalizeEfforts(raw),
    certainty: "listed",
  };
}

/**
 * Whether this install may USE one reported option, and why not when it may
 * not — the answer `NormalizedModelOption` deliberately does not carry.
 *
 * Two ways an id qualifies, and the difference is the point of a dynamic
 * catalog:
 *
 *  - its exact id is in the adapter's declared route for this auth route, or
 *  - the PROVIDER it names is one this adapter already reaches on this auth
 *    route, and an installation reported the id.
 *
 * The second is what lets a model released after this Engager build be chosen
 * on an installation that has it: Engager has no id to declare, the installed
 * agent does, and the route it travels is not new. An id under a provider no
 * route names is ineligible, which is the honest answer — there is no
 * configured route to send it down.
 */
export function modelEligibility(
  adapter: Pick<AgentCliAdapter, "id" | "descriptor">,
  option: NormalizedModelOption,
  authRoute: string,
): { eligible: boolean; reasonCode?: string } {
  const decision = resolveModelRoute(adapter, option.id, { authRoute });
  if (decision.eligible) return { eligible: true };
  const providerRoute = adapter.descriptor.supportedModelRoutes.some(
    (route) =>
      route.providerRef === option.providerRef &&
      (!route.authRoutes || route.authRoutes.includes(authRoute)),
  );
  if (providerRoute) return { eligible: true };
  return {
    eligible: false,
    reasonCode: option.certainty === "manual"
      ? decision.reasonCode
      : "agent_model_execution_unverified",
  };
}

/** Every reported option with its eligibility attached, in catalog order. What
 *  a picker renders and a save checks, derived on demand so the catalog itself
 *  stays a pure statement of what the installation reported. */
export function eligibleOptions(
  adapter: Pick<AgentCliAdapter, "id" | "descriptor">,
  options: readonly NormalizedModelOption[],
  authRoute: string,
): EligibleModelOption[] {
  return options.map((option) => ({
    ...option,
    ...modelEligibility(adapter, option, authRoute),
  }));
}

/**
 * Read one installation's model catalog through the adapter's own route.
 *
 * Failure is data, not an exception: a sign-in prompt, a network refusal and a
 * version with no list protocol all come back as a catalog whose `source` says
 * what happened and whose `options` are EMPTY. An empty catalog is the honest
 * answer — §6's manual-id entry is the path for an agent with no readable list,
 * and filling `options` from the published vocabulary would present shipped
 * constants as something the installation reported. A previously stored list
 * for the same binding is preserved by the caller instead, marked stale.
 */
export async function readModelCatalog(
  adapter: AgentCliAdapter,
  selection: Pick<
    ResolvedAgentSelection,
    | "adapterId"
    | "absoluteExecutable"
    | "executableIdentity"
    | "observedVersion"
    | "authRoute"
    | "providerRef"
    | "authStorePath"
  >,
  metadata: AdapterMetadataDescriptor | undefined,
  options: { signal?: AbortSignal | undefined; timeoutMs?: number } = {},
): Promise<AgentModelCatalog> {
  const base = {
    adapterId: adapter.id,
    providerRef: selection.providerRef,
    executableIdentity: selection.executableIdentity,
    observedVersion: selection.observedVersion,
    adapterContractVersion: adapter.descriptor.adapterContractVersion,
    authRoute: selection.authRoute,
    ...(selection.authStorePath
      ? { authStorePath: selection.authStorePath }
      : {}),
    revision: randomUUID(),
    fetchedAt: Date.now(),
    stale: false,
  };
  const fallback = (reason: string, error?: string): AgentModelCatalog => ({
    ...base,
    source: reason,
    listUnsupported: true,
    partial: true,
    options: [],
    ...(error ? { error } : {}),
  });
  if (!metadata?.listModels) {
    // §6's step two, for an agent with no list protocol: its own settings file
    // may NAME the model it is configured to use. That is one reported fact,
    // not a catalog, so `listUnsupported` stays true and the option's
    // certainty says where it came from. No file, no readable key or a key
    // that is not an id all land on the honest fallback below.
    //
    // It obeys the SAME end-to-end budget and cancellation as a list read:
    // this used to await a callback that its own timer could only signal, so a
    // reader that ignored the signal held the picker open past every deadline.
    const configured = metadata
      ? await configuredCatalogEntry(adapter, selection, metadata, {
          ...(options.signal ? { signal: options.signal } : {}),
          timeoutMs: Math.min(
            options.timeoutMs ?? CATALOG_LIMITS.probeTimeoutMs,
            CATALOG_LIMITS.configuredReadMs,
          ),
        })
      : {};
    return (
      configured.catalog ??
      fallback(
        metadata?.listUnsupported ??
          `${adapter.name} exposes no model list Engager can read safely`,
        configured.error,
      )
    );
  }
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onOuterAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? CATALOG_LIMITS.probeTimeoutMs,
  );
  const context: ModelMetadataContext = {
    absoluteExecutable: selection.absoluteExecutable,
    observedVersion: selection.observedVersion,
    authRoute: selection.authRoute,
    providerRef: selection.providerRef,
    ...(selection.authStorePath
      ? { authStorePath: selection.authStorePath }
      : {}),
    signal: controller.signal,
  };
  try {
    // A provider that ignores its signal — a hung adapter command is the
    // concrete case — must not hold the screen that asked. The race settles on
    // the abort, and the abandoned promise's rejection is swallowed so a later
    // failure cannot surface as an unhandled one.
    const listed = await settleOnAbort(
      metadata.listModels(context),
      controller.signal,
    );
    // The catalog is stored as the binding's provider; a protocol that names a
    // provider only says how to read an id with no prefix of its own.
    const reportedProvider = listed.providerRef ?? selection.providerRef;
    const normalized = listed.models
      .slice(0, CATALOG_LIMITS.maxOptions)
      .map((model) => normalizeReported(reportedProvider, model));
    const reportedDefault =
      listed.reportedDefault ?? normalized.find((model) => model.reportedDefault)?.id;
    return {
      ...base,
      source: listed.source,
      listUnsupported: false,
      partial:
        listed.partial === true ||
        listed.models.length > CATALOG_LIMITS.maxOptions,
      options: normalized.map((model): NormalizedModelOption =>
        reportedDefault && model.id === reportedDefault
          ? { ...model, reportedDefault: true }
          : model,
      ),
    };
  } catch (error) {
    // A canceled read is the owner's own action and says so; anything else is
    // reported without its subprocess text, which can carry credentials.
    const aborted = controller.signal.aborted;
    if (!aborted && metadata.configuredModel) {
      const configured = await configuredCatalogEntry(adapter, selection, metadata, {
        ...(options.signal ? { signal: options.signal } : {}),
        timeoutMs: CATALOG_LIMITS.configuredReadMs,
      });
      if (configured.catalog)
        return { ...configured.catalog, error: safeCatalogError(error) };
    }
    return fallback(
      aborted
        ? `${adapter.name} did not answer within the time Engager allows for a model list`
        : `${adapter.name} returned no model list. Choose a configured model or enter its exact ID`,
      aborted ? "catalog_timeout" : safeCatalogError(error),
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onOuterAbort);
  }
}

/**
 * ONE id read from the agent's own configuration, as a catalog entry — §6's
 * step two for an adapter with no list protocol. It is deliberately a catalog
 * with a single option and `listUnsupported: true`: the picker then shows the
 * configured id as a choice AND keeps the manual id entry, instead of the
 * empty list that looked like an agent with no models at all.
 */
async function configuredCatalogEntry(
  adapter: AgentCliAdapter,
  selection: Pick<
    ResolvedAgentSelection,
    | "absoluteExecutable"
    | "executableIdentity"
    | "observedVersion"
    | "authRoute"
    | "providerRef"
    | "authStorePath"
  >,
  metadata: AdapterMetadataDescriptor,
  options: { signal?: AbortSignal | undefined; timeoutMs: number },
): Promise<{ catalog?: AgentModelCatalog; error?: string }> {
  if (!metadata.configuredModel) return {};
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onOuterAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    // Raced, not merely signalled: a reader that never resolves is the failure
    // this bound exists for, and an abandoned read must settle the caller's
    // promise rather than hold it until the process ends.
    const id = await settleOnAbort(
      metadata.configuredModel({
        absoluteExecutable: selection.absoluteExecutable,
        observedVersion: selection.observedVersion,
        authRoute: selection.authRoute,
        providerRef: selection.providerRef,
        ...(selection.authStorePath
          ? { authStorePath: selection.authStorePath }
          : {}),
        signal: controller.signal,
      }),
      controller.signal,
    );
    if (controller.signal.aborted) return { error: "catalog_timeout" };
    if (!id) return {};
    return {
      catalog: {
        adapterId: adapter.id,
        providerRef: selection.providerRef,
        executableIdentity: selection.executableIdentity,
        observedVersion: selection.observedVersion,
        adapterContractVersion: adapter.descriptor.adapterContractVersion,
        authRoute: selection.authRoute,
        ...(selection.authStorePath
          ? { authStorePath: selection.authStorePath }
          : {}),
        revision: randomUUID(),
        fetchedAt: Date.now(),
        stale: false,
        // What the owner is looking at, and why it is all they are looking
        // at: the descriptor's own sentence about the missing list, when it
        // has one to give. Without it a dropped list route and an adapter
        // that never had one read identically.
        source: metadata.listUnsupported
          ? `${adapter.name}'s own settings name ${id} as the configured model. ${metadata.listUnsupported}`
          : `${adapter.name}'s own settings name ${id} as the configured model`,
        listUnsupported: true,
        partial: true,
        options: [
          {
            id,
            label: id,
            // The route the id would travel, when the adapter declares one: the
            // same decision `resolveModelRoute` makes at save time, so an id
            // this reader found cannot be shown as eligible on a route that
            // would refuse it.
            providerRef:
              declaredRouteFor(adapter, id, selection.authRoute) ??
              selection.providerRef,
            certainty: "configured",
          },
        ],
      },
    };
  } catch {
    // A read the budget or the caller stopped says so; anything else — a
    // callback that failed, a file that is not there — is the honest empty
    // fallback the manual id entry exists for.
    return controller.signal.aborted ? { error: "catalog_timeout" } : {};
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onOuterAbort);
  }
}

/** Resolve with the work, or reject the moment the signal aborts. */
function settleOnAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(agentFailure("agent_canceled"));
    if (signal.aborted) {
      onAbort();
      work.catch(() => {});
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Never the subprocess's own words: a metadata command can echo a token, a
 *  config path or a home directory, and none of those belong on a screen. */
function safeCatalogError(error: unknown): string {
  const code = (error as { cause?: { code?: string } })?.cause?.code;
  return typeof code === "string" && /^[a-z_]{3,64}$/.test(code)
    ? code
    : "catalog_unavailable";
}
