import type { Job } from "@engager/database/schema";
import { resolvedAgentId } from "./client";
import { roleModels, type ModelRole } from "./modelRoles";
import { orgAgentOverrides } from "./orgModelOverrides";
import { currentUsageContext, type UsageContext } from "./usage";
import { storedAgentSelection } from "./agentCli/selection";
import { config } from "../config";

/** The roles, re-exported from the leaf that declares them beside the single
 *  read they name — so every existing call site keeps importing them here. */
export type { ModelRole } from "./modelRoles";

/** The resolution half of a usage scope: who thinks, and with which model per role. */
type ModelScope = Pick<UsageContext, "agent" | "models" | "localAgentSelection">;

/**
 * The resolution SEAM. An entry boundary spreads this into its
 * `withUsageContext` object once, and every `modelFor(role)` inside — at any
 * depth, through any call stack — reads the answer off the scope instead of a
 * global. The manual button and the scheduled run open the same boundaries and
 * call the same functions, so neither can resolve a model the other did not
 * (INV-5); there is no parameter at which they could diverge.
 *
 * A NESTED scope gets `{}`. The ALS merge carries every parent field through,
 * so an inner scope inherits the resolution its boundary made rather than making
 * a second one — and an empty object is what makes that true: returning
 * `{ agent: undefined, models: undefined }` would spread those keys over the
 * parent's answer and reset it.
 *
 * Phase 8's per-worker override changes what this function consults and nothing
 * else. No call site resolves a model again.
 */
export function boundaryModelScope(): ModelScope {
  if (currentUsageContext()?.models) return {};
  return { agent: boundaryAgent(), models: roleModels(), ...boundarySelection() };
}

/**
 * The org-aware boundary: the env map with the org's stored overrides merged
 * over it, plus the stored claude spawn path. Every PRODUCTION entry boundary
 * spreads this one — it is what makes the Agent page's saves take effect on
 * the very next unit of work, no restart — while the sync `boundaryModelScope`
 * above keeps the env-only semantics for tests and for scopes that have no
 * org. The nested-scope guard is the same: an inner boundary inherits its
 * parent's answer rather than reading the row again.
 */
export async function boundaryModelScopeFor(
  organizationId: string,
): Promise<ModelScope & Pick<UsageContext, "agentBin">> {
  if (currentUsageContext()?.models) return {};
  const stored = await orgAgentOverrides(organizationId);
  // An org override is the OWNER's older statement about a role and is still
  // honoured wherever the local installation has not spoken. Where it HAS — the
  // picker writes `roles` into local agent state — that answer wins, because
  // the form cannot be allowed to claim a change execution ignores: the local
  // roles were validated against the installed agent's own route when they
  // were saved, and an org override could name a model this agent refuses.
  // `roleModels` states that precedence once, for every surface that reports it.
  return {
    agent: boundaryAgent(),
    models: roleModels(stored.models),
    agentBin: stored.bin,
    ...boundarySelection(),
  };
}

function boundarySelection(): Pick<UsageContext, "localAgentSelection"> {
  if (config.llmBackend !== "agent-cli") return {};
  try {
    const selected = storedAgentSelection("background");
    return selected ? { localAgentSelection: selected } : {};
  } catch { return {}; }
}

/**
 * Which agent backs inference — resolved through the same memo `getLLM()` uses,
 * so the scope can never name one agent while another serves its calls.
 *
 * A selection FAILURE is recorded as `null` rather than thrown: a boundary opens
 * around every job and every MCP tool call, including the many that never reach
 * a model, and those must not start requiring an installed agent CLI — the
 * laziness `getLLM()` is written for. A unit of work that does reach inference
 * still gets the real refusal, from the call that needed it.
 */
function boundaryAgent(): string | null {
  try {
    return resolvedAgentId();
  } catch {
    return null;
  }
}

/**
 * The job type whose scope must NAME the worker it runs as.
 *
 * There is one, and it used to be two: Radar's button had a job of its own
 * until T-8.3b routed the press into this one. THREE producers enqueue it —
 * the five-minute tick, `run_campaign`, and `discoverNow` — and each
 * resolves the identity for itself before enqueueing. So what this throw is for
 * is the producer that arrives later, copies the enqueue and not the
 * resolution, and would otherwise resolve the role map as though the question
 * had been asked.
 *
 * `undefined` is that unstamped producer, and answering it would be the silent
 * default INV-5 forbids, on the very field the per-worker model keys on. `null`
 * decides: no worker drives this campaign. Discovery enqueues no
 * job at all and so is not bound here — it sweeps inline and opens its own
 * identity scope.
 *
 * Read off `budgetTool` rather than `stage`, because only an entry boundary
 * writes `budgetTool` — `campaigns/suggest.ts` opens a nested scope that renames
 * `stage`, and a check reading that field would stop looking inside one. What
 * this holds is the boundary's own fields: a nested scope that renamed `source`
 * would pass unasked, and nothing under this job type opens one.
 */
const WORKER_IDENTITY_JOBS = new Set<string>([
  "worker_run",
] satisfies Job["type"][]);

/**
 * The model this unit of work uses for one background role.
 *
 * THROWS when no scope is established. A fallback to `config.models` would let
 * an unwrapped path resolve silently, and silently is exactly how one trigger
 * comes to use a model the other does not — the drift INV-5 exists to prevent.
 * An entry point that reaches inference opens a boundary, and this says so
 * rather than answering on its behalf.
 */
export function modelFor(role: ModelRole): string {
  const scope = currentUsageContext();
  if (!scope?.models) {
    throw new Error(
      `modelFor("${role}") ran outside a usage scope — the entry boundary must spread boundaryModelScope() into its withUsageContext`,
    );
  }
  if (
    scope.source === "worker" &&
    WORKER_IDENTITY_JOBS.has(scope.budgetTool ?? "") &&
    scope.workerId === undefined
  ) {
    throw new Error(
      `modelFor("${role}") ran in a ${scope.budgetTool} job whose scope names no worker — the trigger must decide one (an id, or null when the campaign has no scout)`,
    );
  }
  return scope.models[role];
}
