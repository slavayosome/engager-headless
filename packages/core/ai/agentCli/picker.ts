import { constants, accessSync, realpathSync } from "node:fs";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { track } from "@engager/observability/analytics";
import { AGENT_ADAPTERS } from "@engager/observability/events";
import {
  ADAPTERS,
  candidateWithEligibility,
  catalogForInstallation,
  scanAgentInventoryDetailed,
} from "./index";
import {
  eligibleOptions,
  offeredModelIds,
  resolveModelRoute,
} from "./catalog";
import { installationCandidateId } from "./discovery";
import { AGENT_INSTALLERS } from "./installers";
import { runAgentCli } from "./run";
import {
  commitAgentConfiguration,
  prepareSharedAgentConfiguration,
  ROLE_PURPOSES,
  rolePurpose,
  storedAgentSelection,
  validateAgentConfiguration,
  type PreparedAgentConfiguration,
} from "./selection";
import {
  agentFailure,
  readAgentState,
  type LocalAgentState,
} from "./state";
import { verifyIsolationProfile, type IsolationVerifier } from "./isolation";
import { agentReasonCopy } from "./reasonCopy";
import { readSelectedEffort, recordSelectedEffort } from "./effort";
import {
  AgentCliError,
  type AgentCliAdapter,
  type AgentInventory,
  type AgentModelCatalog,
  type AgentPurpose,
  type AgentReadiness,
  type EligibleModelOption,
  type AgentReadinessState,
  type AgentSelectionRequest,
} from "./types";

/**
 * The bounded connection check §7 specifies: ONE tool-free structured request
 * with a fixed innocuous prompt, on the selected auth route, through the shared
 * executor.
 *
 * It receives no Brain, no chat history, no LinkedIn content and no filesystem
 * content — the prompt here is the whole request. A draft-selection path must
 * not have to overwrite the working selection to find out whether a candidate
 * works, so the executor is told this is a preflight and skips the "is this the
 * active revision" comparison it makes for real work.
 *
 * What a success proves is stated exactly: that THIS invocation runs. It is not
 * R-10 certification, and nothing here writes a proof record.
 */
const SMOKE_SCHEMA = z.object({ ok: z.boolean() }).strict();

export type AgentSelectionOutcome =
  | {
      ok: true;
      configured: readonly { purpose: AgentPurpose; adapterId: string; modelRef: string }[];
      backgroundUnavailable: boolean;
      revision: string;
      readiness: AgentReadiness;
    }
  | {
      ok: false;
      /** Safe, actionable code — never subprocess output or a machine path. */
      reasonCode: string;
      /** The previously active selection is still in force. */
      preserved: boolean;
      /** When a usage limit lifts, epoch ms — typed, parsed in the adapter
       *  (`usageLimit.ts`), and the only trace of what the CLI printed. */
      resetsAt?: number | undefined;
    };

/** What the picker needs to render, in one round trip: the inventory, and the
 *  catalog for whichever installation the owner is looking at.
 *
 *  `candidateId` is the EXACT installation `catalog`/`options`/`roles` are
 *  about. The client never re-derives it from an adapter id: two versions of
 *  one agent are two candidates, and matching by adapter is how a click on the
 *  second came back describing the first. Null means "the owner has to
 *  choose" — several usable installations and nothing saved or clicked. */
export type AgentPickerState = {
  inventory: AgentInventory;
  /** The selection currently in force, if any — never cleared by a scan. */
  active: {
    background: AgentPickerSelection | null;
    chat: AgentPickerSelection | null;
  };
  /** The candidate the catalog and options describe, when there is one. */
  candidateId: string | null;
  /** Every stored role model, with whether THIS candidate's route admits it —
   *  what lets a save preserve the owner's explicit choices and say which one
   *  a change would reset. */
  roles: readonly AgentPickerRole[];
  /** The configuration revision a save must still find, so a concurrent change
   *  is a refreshable conflict instead of a last-write-wins overwrite. */
  configurationRevision: string;
  catalog: AgentModelCatalog | null;
  /** `catalog`'s options with this install's eligibility attached. */
  options: EligibleModelOption[];
  readiness: AgentReadiness;
};

export type AgentPickerSelection = {
  adapterId: string;
  modelRef: string;
  effort?: string | undefined;
  configRevision: string;
  /** The candidate this pin resolves to on this scan, by exact identity. */
  candidateId: string | null;
};

export type AgentPickerRole = {
  role: string;
  model: string;
  purpose: AgentPurpose;
  /** Whether the candidate being configured admits this model. */
  eligible: boolean;
  reasonCode?: string | undefined;
};

/**
 * Classify the readiness of one purpose from what is actually stored and
 * verifiable — never from a scan, and never by running inference. §8's rule
 * that the 15-second setup poll must not spawn scanners or perform inference
 * is why this is a projection and not a probe: it reads state and does the
 * CHEAP half of the identity check (presence, executability, resolved path).
 * The hash and the version probe stay on the explicit open/repair action and
 * immediately before every spawn, where the decision is actually made.
 *
 * What the cheap half buys is the state the poll used to miss: an installation
 * whose binary was removed or re-pointed reports `action_required` here —
 * with the code that says which — instead of reading as configured until the
 * next chat turn fails.
 */
export function agentReadiness(): AgentReadiness {
  const background = storedAgentSelection("background");
  const chat = storedAgentSelection("chat");
  const reasonCodes = new Set<string>();
  const stateOf = (
    purpose: AgentPurpose,
    selection: ReturnType<typeof storedAgentSelection>,
  ): AgentReadinessState => {
    if (!selection) {
      reasonCodes.add(
        purpose === "chat" ? "agent_selection_required" : "background_unconfigured",
      );
      return "unconfigured";
    }
    const adapter = ADAPTERS[selection.adapterId];
    if (!adapter) {
      reasonCodes.add("agent_adapter_unsupported");
      return "action_required";
    }
    const trouble = executableTrouble(selection);
    if (trouble) {
      reasonCodes.add(trouble);
      return "action_required";
    }
    return "configured";
  };
  const chatState = stateOf("chat", chat);
  const backgroundState = stateOf("background", background);
  return {
    chat: chatState,
    background: backgroundState,
    reasonCodes: [...reasonCodes],
    checkedAt: Date.now(),
  };
}

/** The setup board's name for the agent a purpose runs on — "Claude Code",
 *  "Codex" — read from the stored selection like `agentReadiness`, never from
 *  a scan. Undefined when none is selected or its adapter is not one this
 *  build ships. */
export function selectedAgentName(purpose: AgentPurpose): string | undefined {
  const adapterId = storedAgentSelection(purpose)?.adapterId;
  if (!adapterId) return undefined;
  return (
    AGENT_INSTALLERS[adapterId as keyof typeof AGENT_INSTALLERS]?.name ??
    ADAPTERS[adapterId]?.name
  );
}

/** The cheap half of `verifyAgentSelection`, for the poll: presence,
 *  executability, and the path the selection recorded. A replaced binary that
 *  kept its path is still refused by the real verifier before every spawn —
 *  this only tells the poll what can be known without hashing a file. */
function executableTrouble(selection: {
  absoluteExecutable: string;
  realPath: string;
}): string | undefined {
  try {
    accessSync(selection.absoluteExecutable, constants.X_OK);
    if (realpathSync(selection.absoluteExecutable) !== selection.realPath)
      return "agent_executable_changed";
    return undefined;
  } catch {
    return "agent_executable_missing";
  }
}

/** The stored state as the picker reports it. A read, never a scan. */
export async function readAgentPickerState(options: {
  candidateId?: string | undefined;
  /** The auth route to read the catalog for. One of the candidate's declared
   *  routes; anything else is refused rather than silently read as the
   *  default. */
  authRoute?: string | undefined;
  signal?: AbortSignal | undefined;
  verifyIsolation?: IsolationVerifier | undefined;
} = {}): Promise<AgentPickerState> {
  const detailed = await scanAgentInventoryDetailed({
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.verifyIsolation
      ? { verifyIsolation: options.verifyIsolation }
      : {}),
  });
  const inventory = detailed.inventory;
  const state = await readAgentState();
  const candidateOf = (
    selection: ReturnType<typeof storedAgentSelection>,
  ): string | null => {
    if (!selection) return null;
    const id = installationCandidateId(selection.realPath);
    return detailed.installations.some((found) => found.candidateId === id)
      ? id
      : null;
  };
  const summarize = (
    purpose: AgentPurpose,
  ): AgentPickerSelection | null => {
    const selection =
      purpose === "chat" ? state.chatSelection : state.backgroundSelection;
    return selection
      ? {
          adapterId: selection.adapterId,
          modelRef: selection.modelRef,
          ...((effort) => (effort ? { effort } : {}))(
            readSelectedEffort(selection.configRevision, selection.modelRef),
          ),
          configRevision: selection.configRevision,
          candidateId: candidateOf(selection),
        }
      : null;
  };
  const background = summarize("background");
  const chat = summarize("chat");
  // What the picker is LOOKING AT, in the order that matches what the owner
  // meant: the candidate they clicked, else the installation already saved,
  // else — and ONLY when there is exactly one — the single usable candidate.
  //
  // The last arm used to take the FIRST usable installation, which silently
  // recommended whichever agent happened to be found first. With several
  // usable agents the owner must choose; the server answers with no catalog
  // until they do, and the model list stays empty rather than naming a
  // preferred vendor. A lone installation that is NOT usable still gets the
  // screen — a found-but-refused installation has a catalog to show beside
  // the reason it cannot be used, and hiding it would leave the owner with an
  // empty page and no explanation.
  const usable = inventory.installations.filter(
    (installation) =>
      installation.chatEligible || installation.backgroundEligible,
  );
  // An explicit request is answered about THAT installation or not at all. The
  // fallbacks below are how a click on a candidate that was updated, removed
  // or replaced between scans came back describing a DIFFERENT installation —
  // the screen silently substituted another agent for the one the owner
  // chose. A disappearance is a refreshable "choose again", never a new pick.
  const requested = options.candidateId
    ? inventory.installations.find(
        (installation) => installation.candidateId === options.candidateId,
      )
    : undefined;
  if (options.candidateId && !requested)
    throw agentFailure("agent_candidate_unknown");
  const target =
    requested ??
    (background?.candidateId
      ? inventory.installations.find(
          (installation) => installation.candidateId === background.candidateId,
        )
      : undefined) ??
    (chat?.candidateId
      ? inventory.installations.find(
          (installation) => installation.candidateId === chat.candidateId,
        )
      : undefined) ??
    (usable.length === 1
      ? usable[0]
      : usable.length === 0 && inventory.installations.length === 1
        ? inventory.installations[0]
        : undefined);
  const adapter = target ? ADAPTERS[target.adapterId] : undefined;
  const installation = target
    ? detailed.installations.find(
        (found) => found.candidateId === target.candidateId,
      )
    : undefined;
  if (
    options.authRoute &&
    adapter &&
    !adapter.descriptor.supportedAuthRoutes.includes(options.authRoute)
  )
    throw agentFailure("agent_auth_route_unsupported");
  let catalog: AgentModelCatalog | null = null;
  if (target && adapter && installation) {
    try {
      catalog = await catalogForInstallation(adapter, installation, {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.authRoute ? { authRoute: options.authRoute } : {}),
        // The SAME verifier the scan above admitted this installation with: a
        // list route that runs the binary is admitted like execution, so the
        // two must not be able to disagree about what is admitted.
        ...(options.verifyIsolation
          ? { verifyIsolation: options.verifyIsolation }
          : {}),
      });
    } catch {
      // A catalog that cannot be read is not a failed scan: the picker shows
      // the installation with an explanation instead of an empty list, and a
      // `null` catalog is how the UI knows to say so.
      catalog = null;
    }
  }
  // The route eligibility is asked against is the one the catalog was bound
  // to, so the options shown and the route they were read for cannot disagree.
  const authRoute =
    catalog?.authRoute ??
    state.backgroundSelection?.authRoute ??
    state.chatSelection?.authRoute ??
    adapter?.descriptor.supportedAuthRoutes[0] ??
    "native_login";
  return {
    inventory,
    active: { background, chat },
    candidateId: target?.candidateId ?? null,
    roles: pickerRoles(adapter, catalog, authRoute, state),
    configurationRevision: state.revision,
    catalog,
    options:
      catalog && adapter
        ? eligibleOptions(adapter, catalog.options, authRoute)
        : [],
    readiness: agentReadiness(),
  };
}

/** Every stored role, judged against the candidate being configured. The
 *  question is the route resolver's, with the catalog in hand, so a role the
 *  new installation cannot serve is reported before a save would refuse the
 *  whole configuration over it. */
function pickerRoles(
  adapter: AgentCliAdapter | undefined,
  catalog: AgentModelCatalog | null,
  authRoute: string,
  state: LocalAgentState,
): AgentPickerRole[] {
  return Object.entries(state.roles).map(([role, model]) => {
    const purpose = rolePurpose(role);
    if (!adapter)
      return { role, model, purpose, eligible: false, reasonCode: "agent_adapter_unsupported" };
    const refusal = roleRefusal(
      adapter,
      catalog,
      authRoute,
      model,
      state[`${purpose}Selection`]?.modelRef,
    );
    return {
      role,
      model,
      purpose,
      eligible: refusal === undefined,
      ...(refusal === undefined ? {} : { reasonCode: refusal }),
    };
  });
}

/**
 * Why the candidate cannot keep a role on `model`, or undefined when it can:
 * its route must carry the id, and when the installation reported a complete
 * list, that list must name it. The model the purpose is saved with is exempt
 * from the list — it is the owner's own pick, and a role on it follows
 * whatever this save chooses instead.
 */
export function roleRefusal(
  adapter: AgentCliAdapter,
  catalog: AgentModelCatalog | null,
  authRoute: string,
  model: string,
  purposeModel: string | undefined,
): string | undefined {
  const decision = resolveModelRoute(adapter, model, {
    authRoute,
    ...(catalog ? { catalog } : {}),
  });
  if (!decision.eligible) return decision.reasonCode;
  const offered = offeredModelIds(catalog);
  if (model !== purposeModel && offered && !offered.has(model))
    return "agent_model_execution_unverified";
  return undefined;
}

/**
 * The stored background roles a save keeps without being asked: an explicit
 * role — not one inherited from the primary this save replaces — whose model
 * the candidate can serve and still offers. Chat owns one role, and the model a
 * save chooses for chat IS that role, so it is never kept against the choice.
 *
 * The server is the authority on what a re-discovery preserves. A request that
 * named no roles used to reset every role to the chosen primary, so any client
 * that forgot to restate them, or a picker opened after an update, quietly
 * undid the owner's choices. What the request DOES name still wins.
 */
function keptRoles(
  adapter: AgentCliAdapter,
  catalog: AgentModelCatalog,
  authRoute: string,
  state: LocalAgentState,
  purposes: readonly AgentPurpose[],
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(state.roles).filter(([role, model]) => {
      const purpose = ROLE_PURPOSES[role];
      if (purpose !== "background" || !purposes.includes(purpose)) return false;
      const purposeModel = state[`${purpose}Selection`]?.modelRef;
      return (
        model !== purposeModel &&
        roleRefusal(adapter, catalog, authRoute, model, purposeModel) ===
          undefined
      );
    }),
  );
}

/** Safe, actionable refusal codes: the agent's own vocabulary only. A thrown
 *  message that carries a path, a token or subprocess text is reported as
 *  `unknown` rather than echoed to a browser. */
const FAILURE_CODE = /^[a-z][a-z0-9_]*(?::[A-Za-z0-9_.:-]+)?$/;

function safeFailureCode(value: string | undefined): string {
  const code = value?.trim() ?? "";
  return code.length <= 96 && FAILURE_CODE.test(code) ? code : "unknown";
}

/** One classification for every refusal the connection step can end with, so
 *  the UI can offer the right next action without parsing English. */
export function selectionFailureCode(error: unknown): string {
  if (error instanceof z.ZodError) return "agent_smoke_invalid";
  const code =
    error instanceof AgentCliError
      ? (error.cause?.code ?? error.message)
      : error instanceof Error
        ? error.message
        : undefined;
  return safeFailureCode(code);
}

/** The reset a refused usage limit carried, if the adapter parsed one. */
function selectionFailureResetsAt(error: unknown): number | undefined {
  return error instanceof AgentCliError ? error.cause?.resetsAt : undefined;
}

/**
 * The picker's request is a WIRE shape: TypeScript is not validation, and a
 * browser can send anything the JSON body allows. Every field is bounded here,
 * unknown fields (`argv`, `proof`, `executable`, …) are refused rather than
 * ignored, and the values that survive are re-resolved server-side anyway.
 */
const REQUEST_SCHEMA = z
  .object({
    candidateId: z.string().min(1).max(128),
    catalogRevision: z.string().min(1).max(128),
    modelId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[\w.:@+/-]+(?:\[1m\])?$/),
    effort: z.string().regex(/^[a-z][a-z0-9_-]{0,23}$/).optional(),
    authRoute: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[\w.:-]+$/),
    purposes: z.array(z.enum(["background", "chat"])).min(1).max(2),
    roles: z
      .record(z.string().min(1).max(64), z.string().min(1).max(200))
      .refine((roles) => Object.keys(roles).length <= 8, {
        message: "agent_roles_bounded",
      }),
    expectedConfigurationRevision: z.string().min(1).max(128),
  })
  .strict();

/**
 * The bounded smoke request itself. Injectable so an offline test can drive
 * the whole save path without spawning an agent, exactly as the chat broker
 * takes its executor.
 */
export type SmokeExecutor = typeof runAgentCli;

async function connectionCheck(
  adapter: AgentCliAdapter,
  prepared: PreparedAgentConfiguration,
  execute: SmokeExecutor,
  signal: AbortSignal | undefined,
): Promise<void> {
  const selection =
    prepared.selections.find((entry) => entry.purpose === "chat")?.selection ??
    prepared.selections[0]?.selection;
  if (!selection) throw agentFailure("agent_selection_required");
  const schema = zodToJsonSchema(SMOKE_SCHEMA, {
    $refStrategy: "none",
  }) as Record<string, unknown>;
  const result = await execute(
    adapter,
    {
      model: selection.modelRef,
      user:
        "Reply with a single JSON object whose `ok` field is true. Do not use any tool, read any file, or search anything.",
      jsonSchema: schema,
      // The candidate, not the stored selection: a draft-selection check must
      // not require the working one to be overwritten first.
      frozenSelection: selection,
      preflight: true,
      requestId: `preflight:${selection.configRevision}`,
    },
    signal ? { signal } : {},
  );
  // A process that exited zero is not a confirmation. The reply itself has to
  // be the strict object the request asked for, with `ok` true: a false,
  // missing, extra-field or non-object answer is a failed check, and the save
  // it would have authorized does not happen.
  const parsed = SMOKE_SCHEMA.safeParse(result.structured);
  if (!parsed.success || parsed.data.ok !== true)
    throw agentFailure("agent_smoke_unconfirmed");
}

/**
 * Validate a candidate and, only then, save it — §7's canonical configure
 * operation for the picker and the CLI.
 *
 * Order matters and is the whole point: resolve the candidate from a fresh
 * scan (never from a path the caller sent), re-read its catalog, prepare every
 * purpose BEFORE any mutation, evaluate the same route and isolation
 * conditions real work uses, run one bounded connection check, re-check the
 * configuration revision, and commit atomically. A failure at any step leaves
 * the previously active selection exactly as it was.
 */
export async function selectLocalAgent(
  request: AgentSelectionRequest,
  options: SelectLocalAgentOptions = {},
): Promise<AgentSelectionOutcome> {
  const attempt: { adapterId?: string } = {};
  const outcome = await attemptLocalAgentSelection(request, options, attempt);
  trackAgentConnected(outcome, attempt.adapterId);
  return outcome;
}

type SelectLocalAgentOptions = {
  signal?: AbortSignal | undefined;
  execute?: SmokeExecutor;
  /** The isolation boundary, injectable for the same reason the executor is:
   *  an offline test cannot satisfy a native-profile check, and a save path
   *  that could only be tested by weakening the check would not be tested at
   *  all. Production never passes one. */
  verifyIsolation?: IsolationVerifier | undefined;
};

/** One connection attempt, as usage data: which agent, and how it ended in the
 *  four words the funnel needs. The reason code is read, never sent. */
export function trackAgentConnected(outcome: AgentSelectionOutcome, attemptedAdapter?: string): void {
  const adapter = outcome.ok ? outcome.configured[0]?.adapterId : attemptedAdapter;
  const known = (AGENT_ADAPTERS as readonly string[]).includes(adapter ?? "");
  const code = outcome.ok ? "" : outcome.reasonCode;
  track("agent_connected", {
    adapter: known ? (adapter as (typeof AGENT_ADAPTERS)[number]) : "unknown",
    outcome: outcome.ok
      ? "ok"
      : /^agent_(candidate_unknown|adapter_unsupported)|executable_(missing|not_found)|not_installed/.test(code)
        ? "not_found"
        : /auth|login|quota|credential/.test(code)
          ? "auth_failed"
          : "refused",
  });
}

/**
 * The choice setup makes when the owner makes none (US-ONE-05): the FIRST
 * eligible option of the installation's own catalog — the same list, in the
 * same order, `readAgentPickerState` hands the Settings picker — for BOTH
 * purposes, on the route that catalog was read for, with no roles named (a
 * fresh save's roles follow the chosen model, as they do from Settings).
 *
 * A catalog that could not be listed, or one with nothing eligible, is a
 * refusal, never a guess at a model id: the failure screen (US-ONE-06) is
 * where that lands, and no selection is attempted.
 */
export function defaultSelectionRequest(
  state: AgentPickerState,
): AgentSelectionRequest {
  if (!state.candidateId || !state.catalog)
    throw agentFailure("agent_catalog_unavailable");
  const first = state.options.find((option) => option.eligible);
  if (!first) throw agentFailure("agent_model_unavailable");
  return {
    candidateId: state.candidateId,
    catalogRevision: state.catalog.revision,
    modelId: first.id,
    authRoute: state.catalog.authRoute,
    purposes: ["background", "chat"],
    roles: {},
    expectedConfigurationRevision: state.configurationRevision,
  };
}

/** A connect attempt's answer: the selection outcome, plus how long the
 *  connection check itself took once it ran — whole seconds, at least 1,
 *  which is all screen 2.7's "Answered in [N] s" ever claims. Absent when
 *  the attempt was refused before any request was sent. */
export type AgentConnectOutcome = AgentSelectionOutcome & {
  elapsedSeconds?: number | undefined;
  /** A refused attempt's sentence in plain words (`reasonCopy.ts`), the one
   *  the window shows; `reasonCode` stays for clients that branch on it. */
  reason?: string | undefined;
};

/**
 * Setup's one-shot connect (`agent-setup connect`, US-ONE-05): read the
 * picker state for the chosen candidate, take its default selection, and
 * run the SAME `selectLocalAgent` the Settings picker's "Connect and
 * continue" runs — isolation check, one bounded test request, atomic
 * commit of both purposes. A failure at any step, a refusal, or the
 * owner's Cancel (`signal`) leaves no selection saved, exactly as a
 * Settings save would; nothing here touches LinkedIn, and the test
 * request is the only model traffic.
 */
export async function connectLocalAgent(
  candidateId: string,
  options: SelectLocalAgentOptions = {},
): Promise<AgentConnectOutcome> {
  const preserved = Boolean(storedAgentSelection("background"));
  let request: AgentSelectionRequest;
  let adapterId: string | undefined;
  try {
    const state = await readAgentPickerState({
      candidateId,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.verifyIsolation
        ? { verifyIsolation: options.verifyIsolation }
        : {}),
    });
    const installation = state.inventory.installations.find(
      (installation) => installation.candidateId === candidateId,
    );
    adapterId = installation?.adapterId;
    // Preserve admission's refusal before an absent/default model can mask it.
    if (installation) {
      if (!ADAPTERS[installation.adapterId])
        throw agentFailure("agent_adapter_unsupported");
      if (!installation.backgroundEligible && !installation.chatEligible)
        throw agentFailure(installation.reasonCodes[0] ?? "agent_capability_missing");
    }
    request = defaultSelectionRequest(state);
  } catch (error) {
    const reasonCode = selectionFailureCode(error);
    return {
      ok: false,
      reasonCode,
      preserved,
      reason: agentReasonCopy(reasonCode, { adapterId }),
    };
  }
  // Time the connection check itself, not the scans around it: the smoke
  // executor is the one call that talks to the agent.
  let checkMs: number | undefined;
  const execute = options.execute ?? runAgentCli;
  const timed: SmokeExecutor = async (adapter, smoke, runOptions) => {
    const started = Date.now();
    try {
      return await execute(adapter, smoke, runOptions);
    } finally {
      checkMs = Date.now() - started;
    }
  };
  const outcome = await selectLocalAgent(request, { ...options, execute: timed });
  const answered: AgentConnectOutcome =
    checkMs === undefined
      ? outcome
      : { ...outcome, elapsedSeconds: Math.max(1, Math.round(checkMs / 1000)) };
  return outcome.ok
    ? answered
    : {
        ...answered,
        reason: agentReasonCopy(outcome.reasonCode, {
          adapterId,
          resetsAt: outcome.resetsAt,
        }),
      };
}

async function attemptLocalAgentSelection(
  request: AgentSelectionRequest,
  options: SelectLocalAgentOptions,
  attempt: { adapterId?: string },
): Promise<AgentSelectionOutcome> {
  const preserved = Boolean(storedAgentSelection("background"));
  const fail = (reasonCode: string): AgentSelectionOutcome => ({
    ok: false,
    reasonCode,
    preserved,
  });
  // The wire shape first: a malformed or over-long request, or one carrying a
  // field this operation does not accept, never reaches a scan or a spawn.
  const parsedRequest = REQUEST_SCHEMA.safeParse(request);
  if (!parsedRequest.success) return fail("agent_request_invalid");
  const input = parsedRequest.data;
  try {
    const resolved = await candidateWithEligibility(input.candidateId, {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.verifyIsolation
        ? { verifyIsolation: options.verifyIsolation }
        : {}),
    });
    if (!resolved) return fail("agent_candidate_unknown");
    // A canceled request says so rather than borrowing whatever refusal the
    // interrupted scan happened to produce.
    if (options.signal?.aborted) return fail("agent_canceled");
    // The PATH comes from a fresh server-side resolution, because the
    // candidate id is the only thing the caller sent: there is no field here
    // for a request to nominate an executable with.
    const installation = resolved.installation;
    attempt.adapterId = installation.adapterId;
    // No adapter at all (a discovery-only agent — Grok, Cursor) is refused
    // as unsupported, before any eligibility reason: the scan's generic
    // `discovery_only` must not mask the refusal SAF-2 names.
    const adapter = ADAPTERS[installation.adapterId];
    if (!adapter) return fail("agent_adapter_unsupported");
    // A candidate the scan reports as unusable is refused with ITS reason —
    // never a bypass. What this refuses is a wrong-version or
    // isolation-refused installation, both of which have nothing for a
    // connection check to try.
    if (!resolved.backgroundEligible && !resolved.chatEligible)
      return fail(resolved.reasonCodes[0] ?? "agent_capability_missing");
    // The catalog the save is committed against must be the one the request
    // saw; a re-read that disagrees is a refreshable conflict, because the
    // options the owner chose from no longer describe this installation.
    const catalog = await catalogForInstallation(adapter, installation, {
      refresh: true,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.verifyIsolation
        ? { verifyIsolation: options.verifyIsolation }
        : {}),
      // The route the owner chose in the picker: re-reading for the default
      // would compare a different binding's revision and refuse the save as
      // stale.
      authRoute: input.authRoute,
    });
    if (catalog.revision !== input.catalogRevision)
      return fail("agent_catalog_stale");
    // The chosen id must be one this install admits, decided by the ONE route
    // resolver execution uses. A listed option answers for itself; an id the
    // catalog never listed is the MANUAL path — admissible exactly when its
    // declared route carries it — so a newly configured or typed id is not
    // refused merely because the catalog held something else.
    const eligible = eligibleOptions(adapter, catalog.options, input.authRoute);
    const chosen = eligible.find((option) => option.id === input.modelId);
    if (chosen && !chosen.eligible)
      return fail(chosen.reasonCode ?? "agent_model_execution_unverified");
    if (!chosen) {
      const decision = resolveModelRoute(adapter, input.modelId, {
        authRoute: input.authRoute,
        catalog,
      });
      if (!decision.eligible) return fail(decision.reasonCode);
    }
    // An effort is only ever one the installation LISTED for this exact model:
    // a typed/manual id has no reported levels, so it takes none.
    if (input.effort && !chosen?.efforts?.includes(input.effort))
      return fail("agent_effort_unsupported");
    // The revision is compared against whatever the caller read, INCLUDING a
    // fresh install's own `unconfigured`: a caller that never read state has
    // no revision to name, and treating that as "skip the check" is how a
    // last-write-wins save slips past a concurrent change.
    const state = await readAgentState();
    if (input.expectedConfigurationRevision !== state.revision)
      return fail("agent_configuration_conflict");
    if (state.active.length || state.queue.length)
      return fail("agent_configuration_busy");
    // The roles the request names are held to the offer a kept role is: a
    // client's explicit role is no way round the installation's own list. The
    // model this save chooses is the one exemption, as it is for a kept role.
    for (const model of Object.values(input.roles)) {
      const refusal = roleRefusal(
        adapter,
        catalog,
        input.authRoute,
        model,
        input.modelId,
      );
      if (refusal !== undefined) return fail(refusal);
    }
    const prepared = await prepareSharedAgentConfiguration(
      adapter.descriptor,
      {
        absoluteExecutable: installation.absoluteExecutable,
        modelRef: input.modelId,
        authRoute: input.authRoute,
        purposes: input.purposes,
        roles: {
          ...keptRoles(
            adapter,
            catalog,
            input.authRoute,
            state,
            input.purposes,
          ),
          ...input.roles,
        },
      },
      catalog,
    );
    // Before the connection check, so the check runs at the chosen level too;
    // before the commit, so an activated selection never lacks its record.
    if (input.effort)
      for (const { selection } of prepared.selections)
        await recordSelectedEffort(selection.configRevision, input.modelId, input.effort);
    await validateAgentConfiguration(
      adapter,
      prepared,
      options.verifyIsolation ?? verifyIsolationProfile,
    );
    await connectionCheck(
      adapter,
      prepared,
      options.execute ?? runAgentCli,
      options.signal,
    );
    const committed = await commitAgentConfiguration(prepared, {
      expectedRevision: state.revision,
    });
    return {
      ok: true,
      configured: committed.configured.map((selection) => ({
        purpose: selection.purpose,
        adapterId: selection.adapterId,
        modelRef: selection.modelRef,
      })),
      backgroundUnavailable: committed.backgroundUnavailable,
      revision: committed.revision,
      readiness: agentReadiness(),
    };
  } catch (error) {
    const resetsAt = selectionFailureResetsAt(error);
    return {
      ...fail(selectionFailureCode(error)),
      ...(resetsAt === undefined ? {} : { resetsAt }),
    };
  }
}

/**
 * A report for one installation: whether its isolation evidence is admitted,
 * asked through the same verifier execution asks. It exists for the picker's
 * eligibility column and for `Repair connection`, and it is a REPORT — the
 * execution path re-runs the real verifier twice per call regardless.
 */
export async function repairAgentConnection(
  candidateId: string,
): Promise<{ admitted: boolean; reasonCode?: string }> {
  const resolved = await candidateWithEligibility(candidateId);
  if (!resolved)
    return { admitted: false, reasonCode: "agent_candidate_unknown" };
  const installation = resolved.installation;
  const adapter = ADAPTERS[installation.adapterId];
  if (!adapter)
    return { admitted: false, reasonCode: "agent_adapter_unsupported" };
  const saved =
    storedAgentSelection("background") ?? storedAgentSelection("chat");
  try {
    // The same verifier execution runs before every spawn, with `prove` set:
    // a repair is where an owner asks Engager to look again, so a binary with
    // no sandbox proof yet (a Codex update) earns one here. The model and
    // provider named are the saved ones, or the adapter's first route for an
    // installation that has no saved selection yet — isolation evidence is
    // keyed on the exact binary and platform, and a stale saved route
    // surfacing as a refusal here is the honest answer.
    await verifyIsolationProfile(
      adapter,
      {
        purpose: "background",
        absoluteExecutable: installation.absoluteExecutable,
        realPath: installation.realPath,
        executableIdentity: installation.executableIdentity,
        observedVersion: installation.observedVersion,
        adapterId: adapter.id,
        modelRef: saved?.modelRef ?? "",
        providerRef: saved?.providerRef ?? adapter.provider,
        authRoute:
          saved?.authRoute ?? adapter.descriptor.supportedAuthRoutes[0] ?? "",
        configRevision: "picker",
        capabilityEvidence: [],
        missingCapabilities: [],
      },
      { prove: true },
    );
    return { admitted: true };
  } catch (error) {
    return { admitted: false, reasonCode: selectionFailureCode(error) };
  }
}
