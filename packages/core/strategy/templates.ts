import { isDeepStrictEqual } from "node:util";
import { CONNECTOR_DECLARATIONS, type ConnectorDeclaration } from "../connector/capabilities";
import {
  CONVERSATION_POLICY,
  catalogStepTemplate,
  type HireableStepId,
} from "./addStep";
import {
  ACTION_KIND_GROUPS,
  BUDGETED_MODE_KEYS,
  CAPABILITIES,
  CAPABILITY_GROUPS,
  CATALOG_STEPS,
  MODE_KEYS,
  capabilityAvailable,
  modeKeyOf,
  networkActionFor,
  type ActionMode,
  type BudgetedModeKey,
  type CapabilityGroup,
  type CapabilityId,
  type GrantId,
  type ModeKey,
  type NetworkCatalog,
  type TargetType,
} from "./catalog";
import type {
  ActionBinding,
  CampaignAgentStrategy,
  StrategyStep,
} from "./contract";
import { STRATEGY_PATCH, type StrategyPatch, type PatchOp, type PatchState } from "./patch";
import { hasCeiling } from "./resolve";
import { findLeadsStep } from "./seed";
import {
  AMBASSADOR_STEP_ROWS,
  STARTING_POINTS,
  startingPointOf,
  type AmbassadorStepId,
  type CampaignDesign,
} from "./firstCampaignActions";

/**
 * CAMPAIGN TEMPLATES — the strategies a campaign can be designed from, as data
 * (spec §06 "Initial campaign templates"). A template names catalog steps, each
 * owned by its worker and binding only that worker's actions (`addStep.ts` is
 * where a step's bindings come from, so a templated step and an added one are
 * the same step). It is turned into a document by the owner's answers to the
 * consequential questions — which sends may ask first, whether the campaign
 * starts from Scout's finds, and what an outcome counts against — and by
 * nothing else. A new campaign's starting point (`firstCampaignActions.ts`) is
 * designed the same way, from the steps the owner switched on and the mode
 * each was given (`designDocument`).
 *
 * WHAT A TEMPLATE NEVER DOES, whatever it is answered:
 *
 *   - set a send to Automatic. A send the owner allows is Ask me; every other
 *     one is Off. Automatic is a separate, confirmed patch, and stays Ask me
 *     until the account holds a ceiling for it (INV-28). A starting point is
 *     the owner's own choice of mode, so Find and engage is Automatic there,
 *     and nothing it says is in force before the owner's Start.
 *   - carry a ceiling. A campaign document has no budgets or windows (the
 *     contract refuses them).
 *   - enable what the channel cannot do. A send whose capability the
 *     connector does not declare resolves Off with that reason (layer 3 of
 *     `catalog.ts`), and the design summary names it (`designSummary.ts`)
 *     rather than pretending it runs. The owner's answer stays the campaign's
 *     mode for it, so a later campaign-wide change reaches it.
 *
 * Pure: no I/O, no clock beyond the `now` it is handed.
 */

export const TEMPLATE_COMPILER_VERSION = "campaign-template/1";

export const CAMPAIGN_TEMPLATES = {
  /** Reply when they answer → Invite to connect → Message after they accept
   *  → Check outcome, optionally led in by Scout's finds and the
   *  Ambassador's comments. */
  conversation_to_conversion: {
    label: "Conversation to conversion",
    leadIn: ["find_leads", "comment_on_posts"],
    steps: ["handle_reply", "connect", "continue_in_dms", "check_outcome"],
  },
  /** Scout's Find leads → the Ambassador's Comment on posts. */
  discover_and_draft: {
    label: "Discover and draft",
    leadIn: [],
    steps: ["find_leads", "comment_on_posts"],
  },
} as const satisfies Record<
  string,
  {
    label: string;
    leadIn: readonly HireableStepId[];
    steps: readonly HireableStepId[];
  }
>;
export type CampaignTemplateId = keyof typeof CAMPAIGN_TEMPLATES;
export const CAMPAIGN_TEMPLATE_IDS = Object.keys(CAMPAIGN_TEMPLATES) as [
  CampaignTemplateId,
  ...CampaignTemplateId[],
];

/** The owner's answers to the questions that decide what a campaign may do. */
export type TemplateAnswers = {
  /** The sends that may ask the owner first (Ask me). Every other send stays
   *  Off; none is ever Automatic. */
  askFirst: readonly ModeKey[];
  /** Begin with Scout's Find leads and the Ambassador's Comment on posts. A
   *  template whose strategy IS those steps has them either way. */
  leadIn: boolean;
  /** What an outcome counts against — an offer reference such as
   *  `product:12` — or null for none, when the strategy has no Check outcome
   *  step: there is nothing to count. */
  offer: string | null;
};

/** The sends no template switches on unless the owner was asked: an
 *  invitation, a message, a reply in the room and a follow-up reach a person
 *  privately or uninvited, so each is opt-in. */
const OPT_IN_SENDS: ReadonlySet<ModeKey> = new Set(["room_reply", "invite", "accept_invite", "dm", "followup"]);

/**
 * The answers of an owner who was not asked — Start from template in the
 * workspace, and a Quick create: the public sends the template brings may ask
 * first — Ask me, so nothing goes out without a yes — and every opt-in send
 * stays Off until they switch its step on; it leads in from Scout's finds, and
 * counts no outcome until an offer is set up.
 */
export const UNASKED_ANSWERS: TemplateAnswers = {
  askFirst: MODE_KEYS.filter((key) => !OPT_IN_SENDS.has(key)),
  leadIn: true,
  offer: null,
};

export type TemplateContext = {
  network: NetworkCatalog;
  /** The channel's connector, or null when none is bound: then only the
   *  catalog's own word holds, and an undeclared capability is unavailable. */
  connector: ConnectorDeclaration | null;
  /** Set for a campaign that finds leads: its Scout
   *  step is Find leads, whose Research is On at every depth. */
  lead?: true;
};

/** A campaign's template context, off the state its patches are drawn
 *  against: its network, the connector its account declares, and whether it
 *  finds leads. */
export function templateContext(state: Pick<PatchState, "network" | "channel" | "campaign">): TemplateContext {
  return {
    network: state.network,
    connector: state.channel.connector ? CONNECTOR_DECLARATIONS[state.channel.connector] : null,
    lead: true as const,
  };
}

/** What every designed campaign reads, by the groups it enables. Reads only:
 *  a template grants no memory write (a write widens, INV-26). */
const MEMORY_BINDINGS: Record<
  CapabilityGroup | "always",
  CampaignAgentStrategy["memory_bindings"]
> = {
  always: [{ slot: "goal_audience", scope: "campaign", access: "read" }],
  discovery: [],
  public_engagement: [
    { slot: "preferences_voice", scope: "campaign", access: "read" },
    { slot: "business_knowledge", scope: "account", access: "read" },
  ],
  conversation: [{ slot: "relationship_memory", scope: "person", access: "read" }],
  conversion: [{ slot: "outcome_evidence", scope: "campaign", access: "read" }],
};

/** After one relevant exchange, ask directly (spec R06). */
const CTA_AFTER_EXCHANGES = 1;

/** The catalog steps a template gives this campaign, in strategy order. */
export function templateSteps(
  template: CampaignTemplateId,
  answers: Pick<TemplateAnswers, "leadIn" | "offer">,
): HireableStepId[] {
  const { leadIn, steps } = CAMPAIGN_TEMPLATES[template];
  return [...(answers.leadIn ? leadIn : []), ...steps]
    .filter(
      // Record outcome counts against an offer; with none there is nothing to
      // count, and the summary says so instead.
      (id) => id !== "check_outcome" || answers.offer !== null,
    );
}

/** Whether the channel can perform one binding's capability against its
 *  target. A read or a draft that needs nothing is always available, and so
 *  is everything with no connector to ask. */
export function bindingAvailable(
  capability: CapabilityId,
  target: TargetType,
  connector: ConnectorDeclaration | null,
): boolean {
  return connector === null || capabilityAvailable(capability, connector, target);
}

/** The action target a binding aims at: its own, else its catalog row's default. */
function targetOf(
  binding: ActionBinding,
  step: StrategyStep,
  network: NetworkCatalog,
): TargetType {
  const row = networkActionFor(network, binding.capability_ref, step.catalog_step);
  if (!row.ok) {
    throw new Error(`${binding.action_binding_id} has no ${network.network} row on ${step.step_id}`);
  }
  return binding.target ?? row.action.defaultTarget;
}

/**
 * Whether a draft still waits for its design — a template's steps among the
 * ways to give it one: it holds no step, or none but the Find posts a search
 * depth said on a blank draft (`setSearchDepth`, which seeds the step to bind
 * Research to), or the Find leads that a switch put in its place, exactly as
 * seeded, its Research on or off and nothing else of it changed. A template
 * keeps that Research (`templateDocument`). Pure.
 */
export function awaitsDesign(document: CampaignAgentStrategy): boolean {
  const steps = document.steps ?? [];
  if (steps.length === 0) return true;
  if (steps[0]?.catalog_step !== "find_leads") return false;
  const research = document.action_bindings?.find(
    (binding) => binding.capability_ref === "research_lead",
  )?.mode;
  if (steps.length !== 1 || (research !== "on" && research !== "off")) return false;
  // Deep search seeds company reads on; both depth defaults still await design.
  return (["on", "off"] as const).some((company) => {
    const seeded = findLeadsStep({ find: "off", research, company });
    return isDeepStrictEqual(steps[0], seeded.step) && isDeepStrictEqual(document.action_bindings, seeded.bindings);
  });
}

/**
 * The document `base` becomes when designed from a template: its strategy,
 * its actions' modes, grants, groups, policy and memory bindings are the
 * template's; its voice, knowledge, retention, safety, run mode, Research's
 * mode, any `max_mode` and its canvas placement stay `base`'s. Pure.
 */
export function templateDocument(
  base: CampaignAgentStrategy,
  template: CampaignTemplateId,
  answers: TemplateAnswers,
  context: TemplateContext,
): CampaignAgentStrategy {
  const askFirst = new Set(answers.askFirst);
  // A send is Ask me where the owner said to ask first, else Off.
  const sendMode = (_: ActionBinding, stored: ModeKey): ActionMode => (askFirst.has(stored) ? "review" : "off");
  return designedDocument(base, templateSteps(template, answers), sendMode, answers.offer, context);
}

/** Find leads, then the Ambassador steps a design switches on, in catalog
 *  order. */
function designSteps(design: CampaignDesign): HireableStepId[] {
  const on = new Set(AMBASSADOR_STEP_ROWS.filter((id) => design.steps[id] !== undefined));
  return (Object.keys(CATALOG_STEPS) as HireableStepId[]).filter(
    (id) => id === "find_leads" || on.has(id as AmbassadorStepId),
  );
}

/**
 * The document `base` becomes when designed from a new campaign's steps
 * (`firstCampaignActions.ts`): Find leads, and each Ambassador step switched
 * on with every send it holds at that step's mode — a follow-up excepted,
 * which stays Off until the owner turns it on — and the instructions written
 * for each. Everything else is as `templateDocument` designs it. Pure.
 */
export function designDocument(
  base: CampaignAgentStrategy,
  design: CampaignDesign,
  context: TemplateContext,
): CampaignAgentStrategy {
  const designed = designedDocument(
    base,
    designSteps(design),
    (binding, stored) => (stored === "followup" ? "off" : (design.steps[binding.owner_step_id as AmbassadorStepId] ?? "off")),
    null,
    context,
  );
  const written = design.instructions ?? {};
  return {
    ...designed,
    steps: (designed.steps ?? []).map((step) => {
      const instructions = written[step.step_id as keyof typeof written];
      return instructions === undefined ? step : { ...step, instructions };
    }),
  };
}

/** The Ambassador steps whose Automatic waits on a daily number the account
 *  does not hold: the send each is named for, its first, keeps a rolling-24h
 *  ceiling and has none (`hasCeiling`). New campaign does not offer them
 *  Automatic, as a step's own control does not (`modeOptions`). Pure. */
export function stepsNeedingNumber(accountDefault: CampaignAgentStrategy | null): AmbassadorStepId[] {
  return AMBASSADOR_STEP_ROWS.filter((id) => {
    const lead = catalogStepTemplate(id).bindings[0];
    const key = lead ? modeKeyOf(lead.capability_ref) : null;
    return key !== null && (BUDGETED_MODE_KEYS as readonly ModeKey[]).includes(key) &&
      !hasCeiling(accountDefault, key as BudgetedModeKey);
  });
}

/** The document `base` becomes with `ids` as its strategy, each send at the
 *  mode `sendMode` gives it and outcomes counted against `offer`. */
function designedDocument(
  base: CampaignAgentStrategy,
  ids: readonly HireableStepId[],
  sendMode: (binding: ActionBinding, stored: ModeKey) => ActionMode,
  offer: string | null,
  context: TemplateContext,
): CampaignAgentStrategy {
  const seeded = ids.map((id) => catalogStepTemplate(id));
  const steps = seeded.map(({ step }) => ({
    ...step,
    barriers: step.barriers.filter(
      (barrier) => barrier.type !== "requires_step" || ids.includes(barrier.step_id as HireableStepId),
    ),
  }));
  const stepById = new Map(steps.map((step) => [step.step_id, step]));

  const keeps = (capability: ActionBinding["capability_ref"]) =>
    (base.action_bindings ?? []).some((binding) => binding.capability_ref === capability && binding.mode === "on");
  const researched = keeps("research");
  const action_bindings: ActionBinding[] = seeded.flatMap(({ bindings }) =>
    bindings.map((binding): ActionBinding => {
      const step = stepById.get(binding.owner_step_id)!;
      const action = networkActionFor(context.network, binding.capability_ref, step.catalog_step);
      if (!action.ok) {
        throw new Error(`${binding.action_binding_id} has no ${context.network.network} row`);
      }
      const { stored } = action.action;
      // Scout's reads are the step's own switch: Find posts is what a Scout is
      // for, where the connector can find. Research keeps what `base` says —
      // On only where it was asked for, a Deep search depth included — and is
      // Off otherwise: its profile visits show.
      if (stored === "step_switch") {
        if (binding.capability_ref === "research") return { ...binding, mode: researched ? "on" : "off" };
        // Find leads' Company page read is its Deep, kept as Research is.
        if (binding.capability_ref === "read_company") return { ...binding, mode: keeps("read_company") ? "on" : "off" };
        // Find leads' Research is On at every depth: the depth decides
        // whether a run reads (`leadRunShapeFor`), the owner's switch whether
        // it may.
        if (binding.capability_ref === "research_lead") return { ...binding, mode: "on" };
        const finds =
          (binding.capability_ref === "discover_opportunities" || binding.capability_ref === "find_leads") &&
          bindingAvailable(binding.capability_ref, targetOf(binding, step, context.network), context.connector);
        return { ...binding, mode: finds ? "on" : "off" };
      }
      // One the connector cannot perform resolves Off with that reason.
      if (stored === null) return binding;
      return { ...binding, mode: sendMode(binding, stored) };
    }),
  );

  // A step's own group, and the group of every kind it binds: Meet the room
  // is public, and its invitation is a conversation.
  const enabled = new Set([
    ...seeded.map(({ group }) => group),
    ...action_bindings.flatMap((binding): CapabilityGroup[] => {
      const kind = CAPABILITIES[binding.capability_ref].kind;
      return kind === null ? [] : [ACTION_KIND_GROUPS[kind]];
    }),
  ]);
  const capability_groups = CAPABILITY_GROUPS.filter((group) => enabled.has(group));
  const grants: GrantId[] = [...new Set(seeded.flatMap(({ grants }) => grants))];
  const memory_bindings = [
    ...MEMORY_BINDINGS.always,
    ...capability_groups.flatMap((group) => MEMORY_BINDINGS[group]),
  ];
  const followsUp = action_bindings.some((binding) => binding.capability_ref === "followup" && binding.mode !== "off");

  const {
    observation: _observation,
    eligibility: _eligibility,
    invite: _invite,
    dm: _dm,
    followup: _followup,
    cta: _cta,
    ...kept
  } = base;
  return {
    ...kept,
    capability_groups,
    grants,
    steps,
    action_bindings,
    ...(enabled.has("conversation")
      ? {
          ...structuredClone(CONVERSATION_POLICY),
          // Meet the room reads the room as well as the owner's own comments.
          ...(ids.includes("meet_the_room")
            ? { observation: { ...CONVERSATION_POLICY.observation, source_scopes: ["own_comments", "room"] } }
            : {}),
          followup: {
            ...CONVERSATION_POLICY.followup,
            max_count: followsUp ? 1 : 0,
          },
        }
      : {}),
    ...(enabled.has("conversion") && offer !== null
      ? { cta: { after_relevant_exchanges: CTA_AFTER_EXCHANGES, cta_asset_id: offer } }
      : {}),
    memory_bindings,
  };
}

/** The top-level fields a design may set, add or remove — every field the
 *  template decides that is not a keyed list. Where a step sits on the canvas
 *  is never one: the canvas writes it, and a removed step's place goes with
 *  it when the ops apply (`applyPatchOps`). */
const DESIGNED_FIELDS = [
  "capability_groups",
  "observation",
  "eligibility",
  "invite",
  "dm",
  "followup",
  "cta",
  "memory_bindings",
] as const satisfies readonly (keyof CampaignAgentStrategy)[];

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** What an op sets — a document field's value, which the contract checks. */
type PatchValue = Extract<PatchOp, { op: "add" }>["value"];

/**
 * The ops that turn `base` into `target`: each step and binding removed,
 * replaced or added by its id, the steps moved into the desired order, and
 * every designed field replaced, added or removed. Pure.
 */
export function designOps(
  base: CampaignAgentStrategy,
  target: CampaignAgentStrategy,
): PatchOp[] {
  const ops: PatchOp[] = [];
  const keyed = <T extends Record<string, unknown>>(
    list: "steps" | "action_bindings",
    idField: string,
    before: readonly T[],
    after: readonly T[],
  ) => {
    const wanted = new Map(after.map((item) => [String(item[idField]), item]));
    const had = new Map(before.map((item) => [String(item[idField]), item]));
    for (const id of had.keys()) {
      if (!wanted.has(id)) ops.push({ op: "remove", path: `/${list}/${id}` });
    }
    for (const [id, item] of wanted) {
      const prior = had.get(id);
      if (!prior) ops.push({ op: "add", path: `/${list}/${id}`, value: structuredClone(item) as PatchValue });
      else if (!same(prior, item)) {
        ops.push({ op: "replace", path: `/${list}/${id}`, value: structuredClone(item) as PatchValue });
      }
    }
  };
  keyed("action_bindings", "action_binding_id", base.action_bindings ?? [], target.action_bindings ?? []);
  keyed("steps", "step_id", base.steps ?? [], target.steps ?? []);

  // Removed steps are gone and added ones appended; what is left to say is the
  // order, one move per step that is not where the desired strategy has it.
  const order = (base.steps ?? [])
    .map((step) => step.step_id)
    .filter((id) => (target.steps ?? []).some((step) => step.step_id === id));
  for (const step of target.steps ?? []) {
    if (!order.includes(step.step_id)) order.push(step.step_id);
  }
  (target.steps ?? []).forEach((step, index) => {
    const at = order.indexOf(step.step_id);
    if (at === index) return;
    order.splice(at, 1);
    order.splice(index, 0, step.step_id);
    ops.push({ op: "move", path: `/steps/${step.step_id}`, index });
  });

  for (const field of DESIGNED_FIELDS) {
    const [before, after] = [base[field], target[field]];
    if (after === undefined) {
      if (before !== undefined) ops.push({ op: "remove", path: `/${field}` });
    } else if (before === undefined) {
      ops.push({ op: "add", path: `/${field}`, value: structuredClone(after) as PatchValue });
    } else if (!same(before, after)) {
      ops.push({ op: "replace", path: `/${field}`, value: structuredClone(after) as PatchValue });
    }
  }
  return ops;
}

/** The roots a design's ops sit under — its recognized intent's paths. */
export function rootsOf(ops: readonly PatchOp[]): string[] {
  return [...new Set(ops.map((op) => `/${op.path.split("/")[1]}`))];
}

/**
 * The `strategy.patch` a design is: `base` (the version patches are written
 * against) made into the template's document, with every grant the template's
 * sends need asked for by name. Pure. Its provenance records the owner's
 * words and which template and answers made it; the ops are the template's,
 * never the words'.
 */
export function designPatch(input: {
  campaignId: number;
  expectedBaseVersion: number;
  base: CampaignAgentStrategy;
  template: CampaignTemplateId;
  answers: TemplateAnswers;
  context: TemplateContext;
  instruction: string;
}): StrategyPatch {
  const askFirst = MODE_KEYS.filter((key) => input.answers.askFirst.includes(key));
  return documentPatch({
    ...input,
    target: templateDocument(input.base, input.template, input.answers, input.context),
    summary: `${CAMPAIGN_TEMPLATES[input.template].label}: ${
      askFirst.length > 0 ? `${askFirst.join(", ")} ask first` : "every send off"
    }${input.answers.leadIn ? ", from Scout's finds" : ""}${
      input.answers.offer ? `, outcomes count against ${input.answers.offer}` : ""
    }`,
  });
}

const MODE_WORDS: Record<"review" | "auto", string> = { review: "Ask me", auto: "Automatic" };

/**
 * The `strategy.patch` a new campaign's design is — `base` made into
 * {@link designDocument}, every grant its sends need asked for by name. Pure.
 * Its summary names the starting point the steps are, or says they are the
 * owner's own.
 */
export function startingPatch(input: {
  campaignId: number;
  expectedBaseVersion: number;
  base: CampaignAgentStrategy;
  design: CampaignDesign;
  context: TemplateContext;
  instruction: string;
}): StrategyPatch {
  const preset = startingPointOf(input.design.steps);
  const on = AMBASSADOR_STEP_ROWS.flatMap((id) => {
    const mode = input.design.steps[id];
    return mode ? [`${CATALOG_STEPS[id].label} at ${MODE_WORDS[mode]}`] : [];
  });
  return documentPatch({
    ...input,
    target: designDocument(input.base, input.design, input.context),
    summary: `${preset ? STARTING_POINTS[preset].label : "Custom"}: Find leads${on.length > 0 ? `, ${on.join(", ")}` : " only"}`,
  });
}

/** The patch that makes `base` into `target`, with the grants that takes. */
function documentPatch(input: {
  campaignId: number;
  expectedBaseVersion: number;
  base: CampaignAgentStrategy;
  target: CampaignAgentStrategy;
  instruction: string;
  summary: string;
}): StrategyPatch {
  const { base, target } = input;
  const ops = designOps(base, target);
  const add = target.grants.filter((grant) => !base.grants.includes(grant));
  const remove = base.grants.filter((grant) => !target.grants.includes(grant));
  const grants = add.length > 0 || remove.length > 0;
  return {
    kind: STRATEGY_PATCH,
    campaignId: input.campaignId,
    expectedBaseVersion: input.expectedBaseVersion,
    ops,
    dependencyVersions: { voice: null, knowledge: null, memory: null },
    ...(grants ? { requestedGrants: { add, remove } } : {}),
    provenance: {
      instruction: input.instruction,
      recognizedIntent: {
        summary: input.summary,
        paths: [...rootsOf(ops), ...(grants ? ["/grants"] : [])],
      },
      scope: { stepId: null },
      compilerVersion: TEMPLATE_COMPILER_VERSION,
    },
  };
}
