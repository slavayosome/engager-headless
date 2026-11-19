import { eq } from "drizzle-orm";
import {
  AGENT_SUPPORT_MATRIX,
  agentModels,
  declaredModel,
  type AgentModel,
  type AgentSupportEntry,
} from "@engager/common/agent-support";
import { AppError } from "@engager/common/errors";
import { organizations } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { resolvedAgentId } from "../ai/client";
import { config } from "../config";
import {
  resolvedRoleModels,
  roleModels,
  type ModelRole,
} from "../ai/modelRoles";
import {
  ADAPTERS,
  admittedModel,
  installationCatalog,
  installationOmits,
  installationOmitsModel,
  offeredModelIds,
  readAdmission,
  rolePurpose,
  storedAgentRoles,
  storedAgentSelection,
  storedCatalog,
  type CommittedLocalAgentRoles,
  type UnofferedRoleModel,
} from "../ai/agentCli";
import type { AgentPurpose } from "../ai/agentCli/types";
import { readAgentState } from "../ai/agentCli/state";

/**
 * The Agent page's settings, resolved the way inference will read them: the
 * env defaults, the owner's stored per-role overrides, and their merge — which
 * is exactly what `boundaryModelScopeFor` hands the next unit of work. ONE
 * implementation behind the dashboard form and the MCP twins, so the two
 * surfaces cannot drift.
 */
export type ModelSettings = {
  /** The agent whose vocabulary the selects offer. */
  agent: AgentSupportEntry["id"];
  /** That agent's declared models; empty = no verified vocabulary, no selects. */
  options: readonly AgentModel[];
  /**
   * Every id the role's OWN purpose admits — the published vocabulary of the
   * agent that serves it plus whatever that installation's catalog reported and
   * its admission record covers. Per role because chat and background may name
   * two different installations: one union list offered every selector ids a
   * save refuses.
   */
  admitted: Record<ModelRole, readonly string[]>;
  /** What each role resolves to with no override: env → shipped defaults. */
  defaults: Record<ModelRole, string>;
  /** Only the roles the owner explicitly set on the ORGANIZATION row. */
  overrides: Partial<Record<ModelRole, string>>;
  /**
   * What inference will ACTUALLY use: defaults, then organization overrides,
   * then the local installation's own pins — the same precedence
   * `modelFor` resolves. The form used to spread the overrides last and
   * announce a change execution ignored.
   */
  effective: Record<ModelRole, string>;
  /** Which side each effective value came from, per role. */
  sources: Record<ModelRole, "local" | "organization" | "default">;
  /**
   * The roles whose configured model the installation serving them does not
   * offer, and the model each runs instead — already what `effective` says.
   * The form names both, so the substitution execution makes is never silent
   * and the stale choice is one the owner can see and replace.
   */
  unoffered: Partial<Record<ModelRole, UnofferedRoleModel>>;
  /**
   * The roles the LOCAL installation pinned (`agent:configure` and the picker),
   * which win over an organization override. Reported so the form can show a
   * conflict for confirmation rather than silently letting one side win.
   */
  localRoles: Record<string, string>;
  /**
   * The roles whose model the local installation OWNS — its selection serves
   * the role's purpose — and which a save therefore has to write through the
   * local authority. Every other role is the organization row's. A role can be
   * local without being pinned yet, which is why this is not `localRoles`.
   */
  localAuthority: readonly ModelRole[];
  /**
   * What clearing a LOCAL role falls back to: the model the picker saved for
   * that role's purpose. `planLocalAgentRoles` writes that model rather than
   * letting a cleared role fall through to the shipped vocabulary, which names
   * another agent's models — so this is the value the control's Default option
   * means, per role.
   */
  localDefaults: Partial<Record<ModelRole, string>>;
  /**
   * Whether the local installation serves the background lane. When it does,
   * the spawned binary is the picker's and the organization row's
   * `agentCliBin` control applies to nothing: the page says so instead of
   * offering a field execution ignores.
   */
  backgroundLocal: boolean;
  /** Organization overrides a local role currently supersedes. */
  conflicts: Partial<Record<ModelRole, string>>;
  /** The stored claude spawn path; null = env (`ENGAGER_AGENT_CLI_BIN`) → "claude". */
  agentCliBin: string | null;
  /**
   * The local installation's configuration revision — what a Models save names
   * so a concurrent change is a refreshable conflict rather than a
   * last-write-wins. Null on a hosted/API install, which has no local state.
   */
  localConfigurationRevision: string | null;
};

export type ModelSettingsPatch = {
  /** Per-role override edits. A string sets the role; null clears it back to
   *  the default. Roles absent from the patch are untouched. */
  models?: Partial<Record<ModelRole, string | null>>;
  /** The claude spawn path; null clears back to the env fallback. The
   *  EXECUTABILITY probe is the caller's (it runs outside the tx) — this op
   *  validates shape only. */
  agentCliBin?: string | null;
  /** The local revision the form read, when it read one. A local role write is
   *  refused as a conflict if the installation moved since. */
  expectedConfigurationRevision?: string;
};

const MODEL_ROLES: readonly ModelRole[] = [
  "filter",
  "writer",
  "writerPremium",
  "chat",
];

/**
 * ONE role resolution, so the form, the MCP twin and `modelFor` cannot part:
 * env defaults, then the organization's own row, then the local
 * installation's pins — which is exactly the precedence
 * `boundaryModelScopeFor` hands the next unit of work — and last the
 * substitution `installedRoleModels` makes for a model the installation does
 * not offer, for every role still configured with that model.
 */
export function resolveRoles(
  defaults: Record<ModelRole, string>,
  overrides: Partial<Record<ModelRole, string>>,
  localRoles: Readonly<Record<string, string>>,
  substitutions: Partial<Record<ModelRole, UnofferedRoleModel>>,
): Pick<ModelSettings, "effective" | "sources" | "conflicts" | "unoffered"> {
  const effective = { ...defaults } as Record<ModelRole, string>;
  const sources = Object.fromEntries(
    MODEL_ROLES.map((role) => [role, "default"]),
  ) as Record<ModelRole, "local" | "organization" | "default">;
  for (const role of MODEL_ROLES)
    if (overrides[role] !== undefined) {
      effective[role] = overrides[role];
      sources[role] = "organization";
    }
  for (const role of MODEL_ROLES)
    if (localRoles[role] !== undefined) {
      effective[role] = localRoles[role];
      sources[role] = "local";
    }
  const unoffered: Partial<Record<ModelRole, UnofferedRoleModel>> = {};
  for (const role of MODEL_ROLES) {
    const substitution = substitutions[role];
    if (!substitution) continue;
    // A role still on its default already holds the substituted model — the
    // defaults are what `roleModels` resolved — while any other source holds
    // the configured one. Matching the latter on its value is what lets a
    // snapshot's substitution lapse once a save replaces the role it named.
    if (
      sources[role] !== "default" &&
      substitution.configured !== effective[role]
    )
      continue;
    effective[role] = substitution.using;
    unoffered[role] = substitution;
  }
  return {
    effective,
    sources,
    unoffered,
    conflicts: Object.fromEntries(
      Object.entries(overrides).filter(([role]) => role in localRoles),
    ),
  };
}

/**
 * The agent whose declared vocabulary validates a chosen model. The direct-API
 * backend and a failed CLI selection both fall back to claude: the API path
 * speaks Anthropic ids, and a probe page must still render its options while
 * no CLI is installed.
 */
function activeAgentId(): AgentSupportEntry["id"] {
  try {
    const id = resolvedAgentId();
    const entry = AGENT_SUPPORT_MATRIX.find((candidate) => candidate.id === id);
    if (entry) return entry.id;
  } catch {
    // No selectable adapter — the fallback below still names a vocabulary.
  }
  return "claude";
}

/**
 * The vocabulary ONE role may choose from, resolved from the installation its
 * OWN purpose executes with rather than from the static table alone: the
 * published ids that route admits, plus every id its catalog reported, plus
 * the ids its admission record already covers.
 *
 * Per ROLE, not per install: chat and background may name two different
 * installations, and unioning them offered each selector ids the save refuses —
 * a Claude chat picker listing an OpenCode id, which is presented as valid and
 * then rejected. Each id here answers through the same `admittedModel` the
 * write uses, so the form and the save cannot disagree about who admits what.
 *
 * A remote tenant's container asks Anthropic and never scans the visitor's
 * Mac — that is why this reads a STORED catalog and never discovers anything.
 */
async function admittedModelsForRole(
  role: ModelRole,
  agent: AgentSupportEntry["id"],
): Promise<string[]> {
  const selection =
    config.llmBackend === "agent-cli"
      ? storedAgentSelection(rolePurpose(role))
      : undefined;
  const adapter =
    selection && ADAPTERS[selection.adapterId]
      ? ADAPTERS[selection.adapterId]
      : ADAPTERS[agent];
  if (!adapter) return [];
  const catalog = selection
    ? await storedCatalog(selection, adapter.descriptor)
    : undefined;
  // Where the installation reported a complete list, it is the whole offer:
  // a published id it does not list is not one to choose, however admissible
  // its route — the first Sonnet on this list used to be one the installed
  // agent had never reported.
  const offered = selection
    ? offeredModelIds(installationCatalog(selection))
    : undefined;
  const ids = new Set<string>();
  const consider = (id: string) => {
    if (selection && installationOmits(selection, id, offered)) return;
    if (admittedModel(adapter, id, selection, catalog)) ids.add(id);
  };
  for (const model of agentModels(adapter.id)) consider(model.id);
  for (const option of catalog?.options ?? []) consider(option.id);
  // The ids the selection was admitted with outlive the picker's cache: an
  // evicted or refreshed-away entry must not make an organization override
  // the owner already set uneditable, and `admittedModel` answers them
  // through the same bound record execution revalidates.
  for (const option of selection
    ? (readAdmission(selection.configRevision)?.options ?? [])
    : [])
    consider(option.id);
  return [...ids];
}

async function overridesRow(
  tx: Tx,
  organizationId: string,
): Promise<{
  modelOverrides: Partial<Record<ModelRole, string>> | null;
  agentCliBin: string | null;
} | null> {
  // `organizations` sits outside forced RLS, so unlike the channel reads this
  // query carries its own id predicate.
  const [row] = await tx
    .select({
      modelOverrides: organizations.modelOverrides,
      agentCliBin: organizations.agentCliBin,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return row ?? null;
}

/**
 * The local revision a Models save is checked against. A malformed state file
 * answers null rather than throwing: the page must still render, and
 * `planLocalAgentRoles` re-reads under the lock before it writes.
 */
async function localConfigurationRevision(): Promise<string | null> {
  if (config.llmBackend !== "agent-cli") return null;
  try {
    return (await readAgentState()).revision;
  } catch {
    return null;
  }
}

/** The purposes this installation has a live selection for, and the model each
 *  was configured with — what makes a role local, and what a cleared local role
 *  is written back to. */
function localAuthority(): {
  roles: ModelRole[];
  defaults: Partial<Record<ModelRole, string>>;
  purposes: Set<AgentPurpose>;
} {
  const roles: ModelRole[] = [];
  const defaults: Partial<Record<ModelRole, string>> = {};
  const purposes = new Set<AgentPurpose>();
  if (config.llmBackend !== "agent-cli") return { roles, defaults, purposes };
  for (const role of MODEL_ROLES) {
    const purpose = rolePurpose(role);
    const selection = storedAgentSelection(purpose);
    if (!selection || !ADAPTERS[selection.adapterId]) continue;
    roles.push(role);
    defaults[role] = selection.modelRef;
    purposes.add(purpose);
  }
  return { roles, defaults, purposes };
}

/**
 * The settings the two authorities resolve to right now: the organization half
 * is carried in, the local half read from this installation. It performs NO
 * database work, which is what lets a caller read the organization row first,
 * close that transaction, and write locally only once the read succeeded.
 *
 * It is not a post-commit readback: every read here is fallible, so a LOCAL
 * save answers from `committedLocalModelSettings` and its receipt instead.
 */
export async function resolvedModelSettings(
  authority: Pick<ModelSettings, "overrides" | "agentCliBin">,
): Promise<ModelSettings> {
  const agent = activeAgentId();
  const defaults = roleModels();
  const local = localAuthority();
  const localRoles =
    config.llmBackend === "agent-cli" ? storedAgentRoles() : {};
  const admitted = {} as Record<ModelRole, readonly string[]>;
  for (const role of MODEL_ROLES)
    admitted[role] = await admittedModelsForRole(role, agent);
  return {
    agent,
    options: agentModels(agent),
    admitted,
    defaults,
    overrides: authority.overrides,
    ...resolveRoles(
      defaults,
      authority.overrides,
      localRoles,
      resolvedRoleModels(authority.overrides).unoffered,
    ),
    localRoles,
    localAuthority: local.roles,
    localDefaults: local.defaults,
    backgroundLocal: local.purposes.has("background"),
    agentCliBin: authority.agentCliBin,
    localConfigurationRevision: await localConfigurationRevision(),
  };
}

/**
 * The answer a committed LOCAL save owes: the snapshot read before the commit,
 * with the mutation's own receipt applied.
 *
 * Pure by construction. The local write cannot be rolled back, so a catalog,
 * state or database read after it could only fail a save that had already
 * landed, or describe a later revision as if this save had written it. The
 * roles and revision named here are the ones the locked mutation published.
 */
export function committedLocalModelSettings(
  snapshot: ModelSettings,
  committed: CommittedLocalAgentRoles,
): ModelSettings {
  const localDefaults = { ...snapshot.localDefaults };
  for (const role of snapshot.localAuthority) {
    const model = committed.purposeModels[rolePurpose(role)];
    if (model !== undefined) localDefaults[role] = model;
  }
  return {
    ...snapshot,
    localRoles: committed.roles,
    localDefaults,
    localConfigurationRevision: committed.revision,
    ...resolveRoles(
      snapshot.defaults,
      snapshot.overrides,
      committed.roles,
      snapshot.unoffered,
    ),
  };
}

export async function getModelSettings(
  tx: Tx,
  organizationId: string,
): Promise<ModelSettings> {
  const row = await overridesRow(tx, organizationId);
  return resolvedModelSettings({
    overrides: row?.modelOverrides ?? {},
    agentCliBin: row?.agentCliBin ?? null,
  });
}

/**
 * Applies the owner's edits and returns the settings as the next boundary will
 * read them. A model must be one the EFFECTIVE selection admits — refused here
 * for early feedback with the role named, while the agent-CLI transport stays
 * the enforcement a bad row cannot slip past.
 *
 * A role the local installation already pins is deliberately NOT restated as a
 * conflict error: the owner is told, on the returned settings, which override
 * the installation supersedes, and the write still lands so the form does not
 * silently discard their edit.
 */
export async function updateModelSettings(
  tx: Tx,
  organizationId: string,
  patch: ModelSettingsPatch,
): Promise<ModelSettings> {
  const row = await overridesRow(tx, organizationId);
  if (!row) {
    throw new AppError(
      "org_not_found",
      "This organization has no settings to update — run setup first.",
      404,
    );
  }
  const agent = activeAgentId();
  const overrides: Partial<Record<ModelRole, string>> = {
    ...(row.modelOverrides ?? {}),
  };
  for (const role of MODEL_ROLES) {
    const edit = patch.models?.[role];
    if (edit === undefined) continue;
    if (edit === null) {
      delete overrides[role];
      continue;
    }
    // One admission rule for the form and for execution: the published id, or
    // an id this install's own catalog reported as eligible. The selection is
    // the one this ROLE's purpose executes with — a chat role must not be
    // validated against the background installation's vocabulary, which is how
    // a split configuration came to refuse a model its own lane admits.
    const purpose = rolePurpose(role);
    const selection =
      config.llmBackend === "agent-cli"
        ? storedAgentSelection(purpose)
        : undefined;
    const adapter = selection
      ? ADAPTERS[selection.adapterId]
      : ADAPTERS[agent];
    const catalog =
      adapter && selection
        ? await storedCatalog(selection, adapter.descriptor)
        : undefined;
    const admissible = adapter
      ? admittedModel(adapter, edit, selection, catalog)
      : declaredModel(edit, agent) !== undefined;
    // The same refusal, with the same code, as the local writers give a model
    // the installation's own list omits: a route that carries the id is not an
    // installation that offers it.
    const omitted = selection ? installationOmitsModel(selection, edit) : false;
    if (!admissible || omitted) {
      const offered = await admittedModelsForRole(role, agent);
      throw new AppError(
        omitted ? "agent_model_execution_unverified" : "undeclared_model",
        `"${edit}" is not a model this ${omitted ? "installation offers" : "install admits"} — pick one of: ${offered.join(", ")}`,
        400,
      );
    }
    overrides[role] = edit;
  }

  let agentCliBin = row.agentCliBin;
  if (patch.agentCliBin !== undefined) {
    const trimmed = patch.agentCliBin?.trim() ?? null;
    if (trimmed === "") {
      throw new AppError(
        "invalid_agent_cli_bin",
        "The agent binary must be a command name or path, or null to use the environment's",
        400,
      );
    }
    agentCliBin = trimmed;
  }

  await tx
    .update(organizations)
    .set({
      modelOverrides: Object.keys(overrides).length > 0 ? overrides : null,
      agentCliBin,
      updatedAt: Date.now(),
    })
    .where(eq(organizations.id, organizationId));

  return resolvedModelSettings({ overrides, agentCliBin });
}
