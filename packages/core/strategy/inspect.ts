import type { ConnectorDeclaration } from "../connector/capabilities";
import {
  BUDGETED_MODE_KEYS,
  CONTEXT_TYPES,
  WORKER_CATALOG,
  networkActionFor,
  type ActionKind,
  type BindingMode,
  type BudgetedModeKey,
  type CapabilityId,
  type ContextTypeId,
  type IntentCeilings,
  type LiveChecks,
  type ModeKey,
  type NetworkAction,
  type NetworkCatalog,
  type TargetType,
} from "./catalog";
import type {
  ActionBinding,
  CampaignAgentStrategy,
  StrategyStep,
} from "./contract";
import {
  hasCeiling,
  resolveStrategy,
  type ResolveReason,
  type ResolvedAction,
  type ResolvedFrom,
} from "./resolve";

/**
 * WHAT THE STEP INSPECTOR SHOWS — one step of a campaign's strategy in the four
 * sections R19 names, every value resolved by the one resolver and every label
 * the catalog's. Pure: the document, the account default whose ceilings bind
 * it, the network and the connector are its only inputs.
 *
 * For each action it answers the two questions the inspector's controls
 * need without a round trip:
 *
 *   what is it now     — the mode its binding holds (Off where it holds
 *                        none), what takes effect, and what held it lower;
 *   what if I asked    — the effective value and the ceiling's reason were
 *     for the most       this step to ask for Automatic (or On, for a read),
 *                        so choosing it can say "stays Ask me — no ceiling
 *                        set" the moment it is chosen.
 *
 * A binding's mode is the action's only setting: nothing above the step
 * keeps one to inherit, so there is nothing to reset to.
 */

export type InspectedAction = {
  bindingId: string;
  kind: ActionKind;
  /** The capability its binding names: what tells Find posts' Research from
   *  Find leads', which share a kind. */
  capability: CapabilityId;
  label: string;
  /** The modes the catalog row allows, or null for one that takes none. */
  modes: readonly BindingMode[] | null;
  /** The key its account ceiling and daily limit are kept under, or null for
   *  a read and for an action that takes no mode. */
  modeKey: ModeKey | null;
  /** The mode its binding holds — Off where it holds none — or null for an
   *  action that takes no mode. */
  requested: BindingMode | null;
  effective: BindingMode | null;
  resolvedFrom: ResolvedFrom;
  reason: ResolveReason | null;
  /** Were the step to ask for the top mode: what it would get, and why not
   *  more. Null for a mode-less action. */
  atTop: { mode: BindingMode; effective: BindingMode | null; reason: ResolveReason | null } | null;
  /** Whether its Automatic stays Ask me until the account holds its daily
   *  number (`hasCeiling`): the mode control does not offer Automatic then,
   *  as the account's control did before the step's mode was the only one. */
  needsNumber: boolean;
  targets: readonly TargetType[];
  target: TargetType;
  /** What the catalog row aims at when the binding names nothing. */
  defaultTarget: TargetType;
  targetOverridden: boolean;
  condition: NonNullable<ActionBinding["condition"]> | null;
  /** Who gets an opener, per intent — each at its default where the binding
   *  stores none — and the ones it does store. Null for every action but the
   *  Comment of a step that answers leads. */
  intentCeilings: IntentCeilings | null;
  storedCeilings: NonNullable<ActionBinding["intent_ceilings"]> | null;
};

export type InspectedStep = {
  step: StrategyStep;
  workerLabel: string;
  context: Array<{ id: ContextTypeId; description: string }>;
  actions: InspectedAction[];
};

export type InspectInput = {
  document: CampaignAgentStrategy;
  accountDefault: CampaignAgentStrategy | null;
  network: NetworkCatalog;
  connector: ConnectorDeclaration | null;
  /** The first sends and live checks recorded on the account. */
  liveChecks?: LiveChecks;
  now?: number;
};

function resolveAll(input: InspectInput, document: CampaignAgentStrategy): ResolvedAction[] {
  return resolveStrategy({
    accountDefault: input.accountDefault,
    campaign: document,
    network: input.network,
    connector: input.connector,
    liveChecks: input.liveChecks,
    now: input.now,
  });
}

/** Every step in the document, inspected, in strategy order. */
export function inspectSteps(input: InspectInput): InspectedStep[] {
  const resolved = new Map(
    resolveAll(input, input.document).map((action) => [action.action_binding_id, action]),
  );
  const bindings = new Map(
    (input.document.action_bindings ?? []).map((binding) => [binding.action_binding_id, binding]),
  );
  return (input.document.steps ?? []).map((step) => ({
    step,
    workerLabel: WORKER_CATALOG[step.worker].label,
    context: step.context_refs.map((id) => ({ id, description: CONTEXT_TYPES[id].description })),
    actions: step.action_binding_refs.flatMap((ref): InspectedAction[] => {
      const binding = bindings.get(ref);
      const action = resolved.get(ref);
      if (!binding || !action) return [];
      const row = networkActionFor(input.network, binding.capability_ref, step.catalog_step);
      if (!row.ok) return [];
      const modes = row.action.modes;
      // A read's most is On; a send's is Automatic.
      const top: BindingMode | null =
        modes === null ? null : modes.includes("on") ? "on" : "auto";
      return [
        {
          bindingId: binding.action_binding_id,
          kind: action.kind,
          capability: action.capability,
          label: action.label,
          modes,
          modeKey:
            row.action.stored === null || row.action.stored === "step_switch"
              ? null
              : row.action.stored,
          requested: action.requested,
          effective: action.effective,
          resolvedFrom: action.resolved_from,
          reason: action.reason,
          atTop: top === null ? null : askedFor(input, binding.action_binding_id, top),
          needsNumber: budgeted(row.action.stored) && !hasCeiling(input.accountDefault, row.action.stored),
          targets: row.action.targets,
          target: action.target,
          defaultTarget: row.action.defaultTarget,
          targetOverridden: binding.target !== undefined,
          condition: binding.condition ?? null,
          intentCeilings: action.intent_ceilings,
          storedCeilings: action.intent_ceilings === null ? null : (binding.intent_ceilings ?? {}),
        },
      ];
    }),
  }));
}

const budgeted = (stored: NetworkAction["stored"]): stored is BudgetedModeKey =>
  (BUDGETED_MODE_KEYS as readonly unknown[]).includes(stored);

/** The binding's resolution were its step to ask for `mode`. */
function askedFor(
  input: InspectInput,
  bindingId: string,
  mode: BindingMode,
): NonNullable<InspectedAction["atTop"]> {
  const document: CampaignAgentStrategy = {
    ...input.document,
    action_bindings: (input.document.action_bindings ?? []).map((binding) =>
      binding.action_binding_id === bindingId ? { ...binding, mode } : binding,
    ),
  };
  const action = resolveAll(input, document).find(
    (candidate) => candidate.action_binding_id === bindingId,
  );
  return { mode, effective: action?.effective ?? null, reason: action?.reason ?? null };
}
