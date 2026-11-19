import {
  ACTION_KIND_GROUPS,
  CAPABILITIES,
  CATALOG_STEPS,
  STRATEGY_WORKERS,
  MODE_GRANTS,
  WORKER_CATALOG,
  NETWORK_CATALOGS,
  networkActionFor,
  type ActionMode,
  type CapabilityGroup,
  type CatalogStepId,
  type StrategyWorker,
  type GrantId,
  type NetworkCatalog,
} from "./catalog";
import type {
  ActionBinding,
  CampaignAgentStrategy,
  StrategyStep,
} from "./contract";
import { STRATEGY_PATCH, type StrategyPatch, type PatchOp } from "./patch";
import {
  DEFAULT_STEP_BUDGET,
  commentOnPostsStep,
  findLeadsStep,
  handleReplyStep,
  type SeedStep,
} from "./seed";

/**
 * ADD STEP — how a campaign hires a worker (INV-33). The picker offers each
 * worker's catalog steps; choosing one is a `strategy.patch` that adds that
 * step, owned by its worker, binding only that worker's catalog actions for
 * the step, each Off until the owner sets it. Meet the room stages its two
 * actions at Ask me in the inspector before that patch. No free wiring,
 * no edge, no direct document write. The patch classifies itself like any
 * other — a new send, grant or group is a widening and waits for the owner's
 * click — and
 * deciding it activates a version whose projection creates the worker's row
 * if the campaign had none.
 *
 * Every step id is its catalog step's id, so a step the strategy already has
 * is offered disabled rather than added twice: a second Comment on posts would
 * be a second owner of the same actions, which no runtime path reads.
 */

export const ADD_STEP_COMPILER_VERSION = "campaign-workspace-add-step/2";

/** Why a step cannot be added, in the owner's words. */
export const ADD_STEP_REFUSALS = {
  present: "Already in this strategy.",
  needs_offer: "Needs an offer to count first — set one up in chat.",
  later: "Coming later.",
} as const;

export type StepOffer = {
  catalogStep: CatalogStepId;
  label: string;
  /** The catalog labels of the actions it brings, in catalog order. */
  actions: string[];
  /** Null when it can be added. */
  unavailable: string | null;
};

export const MEET_THE_ROOM_INSTRUCTIONS =
  "Answer the pain they named in their own comment, briefly and in my voice. Invite only after a real exchange.";

export type StagedStep = {
  modes: Partial<Record<string, ActionMode>>;
  instructions?: string;
};

export type WorkerOffer = {
  worker: StrategyWorker;
  label: string;
  /** False for a worker the product names and does not hire yet. */
  offered: boolean;
  steps: StepOffer[];
};

/**
 * The policy a newly enabled conversation group needs: direct replies to the
 * owner's own comments, a note on every invitation, no opener before
 * interest, no follow-up. A neutral reply that is on topic is the step's to
 * read and decide — eligible, never more than its step's modes let it be, so
 * at Ask me whatever it proposes still waits for a yes; only an unknown one
 * waits for a look. The owner widens or narrows each through its own patch. A
 * campaign designed from a template starts from the same policy
 * (`templates.ts`); one that already exists changes only by a patch the owner
 * confirms (INV-26).
 */
export const CONVERSATION_POLICY = {
  observation: {
    source_scopes: ["own_comments"],
    direct_replies_only: true,
    replay_lookback_hours: 0,
    catchup_requires_review: true,
  },
  eligibility: {
    neutral_relevant: "eligible",
    negative: "skip",
    spam: "skip",
    unknown: "review",
    exclusion_set_id: null,
  },
  invite: { note_required: true, no_repeat_invite: true },
  dm: { outgoing_acceptance: "wait_for_interest", incoming_linked_opener: false },
  followup: { max_count: 0, delay_hours: 72, requires_explicit_interest: true },
} as const satisfies Pick<
  CampaignAgentStrategy,
  "observation" | "eligibility" | "invite" | "dm" | "followup"
>;

function step(
  catalogStep: CatalogStepId,
  fields: Pick<
    StrategyStep,
    "objective" | "context_refs" | "allowed_tools" | "action_binding_refs" | "entry"
  > &
    Partial<Pick<StrategyStep, "barriers">>,
): StrategyStep {
  const { worker, label } = CATALOG_STEPS[catalogStep];
  return {
    step_id: catalogStep,
    catalog_step: catalogStep,
    worker,
    label,
    instructions: "",
    output_schema: "AgentStepResult.v1",
    model_override: null,
    budget: DEFAULT_STEP_BUDGET,
    on_missing_context: "wait_or_review",
    on_no_progress: "escalate",
    barriers: [],
    ...fields,
  };
}

/** The bindings without their modes: an added action is Off until the owner
 *  sets it on its step. */
const unset = (seeded: SeedStep): SeedStep => ({
  ...seeded,
  bindings: seeded.bindings.map(({ mode: _mode, ...binding }) => binding),
});

/** The catalog steps a campaign can be given today: every one but the
 *  Writer's, which nothing hires yet. */
export type HireableStepId = Exclude<CatalogStepId, "write_post">;

/**
 * Each catalog step as Add step writes it. The three the seeder already writes
 * are the seeder's (`seed.ts`), so a step added here and a step a campaign was
 * seeded with are the same step; Reply when they answer also brings Like reply, which
 * a seed never binds because no switch of today's maps to it. A campaign
 * template (`templates.ts`) is built from these too, so a templated step and an
 * added one are the same step.
 */
const TEMPLATES: Record<HireableStepId, () => SeedStep> = {
  find_leads: () => unset(findLeadsStep({ find: "off", research: "off" })),
  comment_on_posts: () => commentOnPostsStep(),
  meet_the_room: () => ({
    step: {
      ...step("meet_the_room", {
        objective: "Reply to people who fit your audience, under their own comment.",
        context_refs: ["room_thread", "campaign_voice", "product_facts", "relationship_state"],
        allowed_tools: ["draft_comment", "reply_to_comment", "send_invitation", "read_profile"],
        action_binding_refs: ["reply_to_commenter", "invite_from_room"],
        entry: { event: "room_member_spotted" },
        barriers: [{ type: "requires_read", step_id: "find_leads", action_binding_id: "lead_research" }],
      }),
      instructions: MEET_THE_ROOM_INSTRUCTIONS,
    },
    bindings: [
      { action_binding_id: "reply_to_commenter", owner_step_id: "meet_the_room", capability_ref: "reply_to_comment", target: "room_comment", mode: "review" },
      { action_binding_id: "invite_from_room", owner_step_id: "meet_the_room", capability_ref: "send_invitation", target: "person", mode: "review" },
    ],
    grants: [MODE_GRANTS.room_reply, MODE_GRANTS.invite],
    group: "public_engagement",
  }),
  handle_reply: () => {
    const seeded = handleReplyStep();
    return {
      ...seeded,
      step: {
        ...seeded.step,
        // The seed's objective, and what its Like reply is for: a reply that
        // needs no answer is liked; one it answers carries its like.
        objective:
          "Answer a reply under one of your comments or room replies, briefly and in your voice; like one that needs no answer.",
        allowed_tools: [...seeded.step.allowed_tools, "like_target"],
        action_binding_refs: [...seeded.step.action_binding_refs, "like_reply"],
      },
      bindings: [
        ...seeded.bindings,
        {
          action_binding_id: "like_reply",
          owner_step_id: "handle_reply",
          capability_ref: "like_target",
          target: "their_reply",
        },
      ],
      grants: [...seeded.grants, MODE_GRANTS.like_target],
    };
  },
  connect: () => ({
    step: step("connect", {
      objective:
        "Connect with people who engaged, with a short note that cites the real exchange.",
      context_refs: ["relationship_state", "verified_thread", "campaign_voice"],
      allowed_tools: ["read_profile", "send_invitation", "accept_invitation"],
      action_binding_refs: ["invite", "accept_invite"],
      // An invitation's answer re-enters it; a relevant exchange Handle a
      // reply achieved hands the conversation on to it (`agentStep/select.ts`).
      entry: { event: "invitation_status" },
      barriers: [{ type: "requires_step", step_id: "handle_reply" }],
    }),
    bindings: [
      { action_binding_id: "invite", owner_step_id: "connect", capability_ref: "send_invitation" },
      { action_binding_id: "accept_invite", owner_step_id: "connect", capability_ref: "accept_invitation" },
    ],
    grants: [MODE_GRANTS.invite, MODE_GRANTS.accept_invite],
    group: "conversation",
  }),
  continue_in_dms: () => ({
    step: step("continue_in_dms", {
      objective: "Wait for genuine interest, then answer it in a direct message.",
      context_refs: ["relationship_state", "dm_thread", "campaign_voice", "product_facts"],
      allowed_tools: ["draft_dm", "send_dm", "followup"],
      action_binding_refs: ["dm", "followup"],
      entry: { event: "inbound_dm" },
    }),
    bindings: [
      { action_binding_id: "dm", owner_step_id: "continue_in_dms", capability_ref: "send_dm" },
      { action_binding_id: "followup", owner_step_id: "continue_in_dms", capability_ref: "followup" },
    ],
    grants: [MODE_GRANTS.dm, MODE_GRANTS.followup],
    group: "conversation",
  }),
  check_outcome: () => ({
    step: step("check_outcome", {
      objective: "Record real outcomes, with evidence — never inferred.",
      context_refs: ["relationship_state"],
      allowed_tools: ["record_outcome"],
      action_binding_refs: ["record_outcome"],
      entry: { event: "outcome_evidence" },
    }),
    bindings: [
      { action_binding_id: "record_outcome", owner_step_id: "check_outcome", capability_ref: "record_outcome" },
    ],
    grants: [],
    group: "conversion",
  }),
};

/** What the Ambassador's two lead-fed steps are for, and what they start on
 *  and wait for, in a campaign that finds leads: a lead Scout served, from the
 *  post it was found in or the comment it left. */
const LEAD_COMMENT_OBJECTIVE = "Start a conversation with a lead on their own post, about what they said.";
const LEAD_ROOM_OBJECTIVE = "Reply to leads under their own comment, where they said it.";

function fedByLeads(catalogStep: HireableStepId, seeded: SeedStep): SeedStep {
  if (catalogStep === "comment_on_posts") {
    return {
      ...seeded,
      step: {
        ...seeded.step,
        objective: LEAD_COMMENT_OBJECTIVE,
        entry: { event: "lead_served" },
        barriers: [{ type: "requires_step", step_id: "find_leads" }],
      },
    };
  }
  if (catalogStep === "meet_the_room") {
    return {
      ...seeded,
      step: {
        ...seeded.step,
        objective: LEAD_ROOM_OBJECTIVE,
        entry: { event: "lead_served" },
        barriers: [{ type: "requires_read", step_id: "find_leads", action_binding_id: "lead_research" }],
      },
    };
  }
  return seeded;
}

/** One catalog step as Add step writes it, including Meet the room's staged
 *  Ask me defaults and the grants its sends need. In a campaign that finds
 *  leads the Ambassador's lead-fed steps start on a served lead. */
export function catalogStepTemplate(catalogStep: HireableStepId): SeedStep {
  const seeded = TEMPLATES[catalogStep]();
  return fedByLeads(catalogStep, seeded);
}

/** Why a catalog step cannot be added to this document, or null. */
function refusal(
  document: CampaignAgentStrategy,
  catalogStep: CatalogStepId,
): string | null {
  if (!WORKER_CATALOG[CATALOG_STEPS[catalogStep].worker].offered) {
    return ADD_STEP_REFUSALS.later;
  }
  if ((document.steps ?? []).some((item) => item.catalog_step === catalogStep || item.step_id === catalogStep)) {
    return ADD_STEP_REFUSALS.present;
  }
  // Record outcome counts against an offer (`cta`), and the conversion group
  // is not a group without one: there is no asset to name on the owner's
  // behalf, so the step waits until chat has set one up.
  if (catalogStep === "check_outcome" && document.cta === undefined) {
    return ADD_STEP_REFUSALS.needs_offer;
  }
  if (catalogStep === "meet_the_room" && !searchesDeep(document)) {
    return MEET_THE_ROOM_NEEDS_DEEP.switchOn;
  }
  return null;
}

/** Bind the prerequisite to the owner's stored ids, never the seed's names:
 *  Research in Find posts, or in Find leads for a campaign that finds them. */
function researchBinding(document: CampaignAgentStrategy): ActionBinding | null {
  const find = (document.steps ?? []).filter((item) => item.catalog_step === "find_leads");
  if (find.length !== 1) return null;
  const [step] = find;
  const bindings = (document.action_bindings ?? []).filter((binding) =>
    binding.owner_step_id === step!.step_id && binding.capability_ref === "research_lead" &&
    step!.action_binding_refs.includes(binding.action_binding_id),
  );
  return bindings.length === 1 ? bindings[0]! : null;
}

/** What the Add step picker offers this document, grouped by worker. The
 *  retired Find posts step is hidden and adding it is refused. Pure. */
export function stepOffers(
  document: CampaignAgentStrategy,
  network: NetworkCatalog,
): WorkerOffer[] {
  return STRATEGY_WORKERS.map((worker) => ({
    worker,
    label: WORKER_CATALOG[worker].label,
    offered: WORKER_CATALOG[worker].offered,
    steps: (Object.keys(CATALOG_STEPS) as CatalogStepId[])
      .filter((id) => CATALOG_STEPS[id].worker === worker)
      .map((catalogStep) => ({
        catalogStep,
        label: CATALOG_STEPS[catalogStep].label,
        actions: network.actions
          .filter((row) => row.step === catalogStep)
          .map((row) => row.label),
        unavailable: refusal(document, catalogStep),
      })),
  }));
}

/** What is said where Meet the room would be on below Deep. */
export const MEET_THE_ROOM_NEEDS_DEEP = {
  switchOn: "Meet the room needs Search depth Deep. Set the depth to Deep first, then switch it on.",
  leaveDeep:
    "Meet the room needs Search depth Deep. Lower the depth with save_campaign, which switches Meet the room off and says so, or switch the step off first.",
  switchedOff: "Meet the room was switched off: it needs Search depth Deep.",
} as const;

/** Meet the room's sends that are not Off, by the owner's stored step ids. */
function roomSendsOn(document: CampaignAgentStrategy): ActionBinding[] {
  const room = new Set(
    (document.steps ?? []).filter((item) => item.catalog_step === "meet_the_room").map((item) => item.step_id),
  );
  return (document.action_bindings ?? []).filter(
    (binding) => room.has(binding.owner_step_id) && binding.mode !== undefined && binding.mode !== "off",
  );
}

/** Whether a document's Meet the room step is on: one of its sends is not
 *  Off. */
export function meetTheRoomOn(document: CampaignAgentStrategy): boolean {
  return roomSendsOn(document).length > 0;
}

/** Whether a document searches Deep: Find leads' Company page read is On,
 *  as the campaign's depth reads it (`readsDeep`, searchDepth.ts). */
function searchesDeep(document: CampaignAgentStrategy): boolean {
  return (document.action_bindings ?? []).some(
    (binding) => binding.capability_ref === "read_company" && binding.mode === "on",
  );
}

/**
 * Why a change from `before` to `after` is refused for Meet the room, or
 * null: it may be switched on only at Deep, and the depth may not leave Deep
 * by a strategy change while it is on. A campaign that already has it on
 * below Deep keeps it through every other change; only a lowered depth
 * switches it off, and says so (`meetTheRoomOffPatch`). Pure.
 */
export function meetTheRoomRefusal(before: CampaignAgentStrategy, after: CampaignAgentStrategy): string | null {
  if (!meetTheRoomOn(after) || searchesDeep(after)) return null;
  if (!meetTheRoomOn(before)) return MEET_THE_ROOM_NEEDS_DEEP.switchOn;
  return searchesDeep(before) ? MEET_THE_ROOM_NEEDS_DEEP.leaveDeep : null;
}

/** The patch that switches Meet the room's sends Off, or null where it is
 *  not on. Pure. */
export function meetTheRoomOffPatch(input: {
  campaignId: number;
  expectedBaseVersion: number;
  document: CampaignAgentStrategy;
  instruction: string;
}): StrategyPatch | null {
  const ops = roomSendsOn(input.document).map(
    (binding): PatchOp => ({ op: "add", path: `/action_bindings/${binding.action_binding_id}/mode`, value: "off" }),
  );
  if (ops.length === 0) return null;
  return {
    kind: STRATEGY_PATCH,
    campaignId: input.campaignId,
    expectedBaseVersion: input.expectedBaseVersion,
    ops,
    dependencyVersions: { voice: null, knowledge: null, memory: null },
    provenance: {
      instruction: input.instruction,
      recognizedIntent: { summary: MEET_THE_ROOM_NEEDS_DEEP.switchedOff, paths: ops.map((op) => op.path) },
      scope: { stepId: null },
      compilerVersion: ADD_STEP_COMPILER_VERSION,
    },
  };
}

export class AddStepRefusedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/**
 * The patch that adds one catalog step to the active version. Pure. Its
 * barriers keep only the steps the strategy has; a newly enabled group brings
 * its narrowest policy; every grant its sends need is asked for by name, so
 * the card shows each.
 */
export function addStepPatch(input: {
  campaignId: number;
  expectedBaseVersion: number;
  document: CampaignAgentStrategy;
  catalogStep: CatalogStepId;
  staged?: StagedStep;
  network?: NetworkCatalog;
}): StrategyPatch {
  const { document, catalogStep } = input;
  const refused = refusal(document, catalogStep);
  if (refused !== null || catalogStep === "write_post") {
    throw new AddStepRefusedError(refused ?? ADD_STEP_REFUSALS.later);
  }
  const seeded = catalogStepTemplate(catalogStep);
  if (input.staged) {
    if (!input.staged.modes || typeof input.staged.modes !== "object" || Array.isArray(input.staged.modes)) {
      throw new AddStepRefusedError("mode_not_allowed");
    }
    for (const [id, mode] of Object.entries(input.staged.modes)) {
      const binding = seeded.bindings.find((item) => item.action_binding_id === id);
      if (!binding) throw new AddStepRefusedError("unknown_binding");
      const row = networkActionFor(input.network ?? NETWORK_CATALOGS.linkedin, binding.capability_ref, catalogStep);
      if (!mode || !row.ok || !row.action.modes?.includes(mode)) throw new AddStepRefusedError("mode_not_allowed");
      binding.mode = mode;
    }
    if (input.staged.instructions !== undefined) {
      if (typeof input.staged.instructions !== "string" || input.staged.instructions.length > 4000) {
        throw new AddStepRefusedError("invalid_instructions");
      }
      seeded.step.instructions = input.staged.instructions;
    }
  }
  const research = catalogStep === "meet_the_room" ? researchBinding(document) : null;
  const present = new Set((document.steps ?? []).map((item) => item.step_id));
  const added: StrategyStep = {
    ...seeded.step,
    barriers: research ? [{ type: "requires_read", step_id: research.owner_step_id, action_binding_id: research.action_binding_id }] : seeded.step.barriers.filter(
      (barrier) => barrier.type !== "requires_step" || present.has(barrier.step_id),
    ),
  };

  const ops: PatchOp[] = [
    { op: "add", path: `/steps/${added.step_id}`, value: added },
    ...seeded.bindings.map(
      (binding: ActionBinding): PatchOp => ({
        op: "add",
        path: `/action_bindings/${binding.action_binding_id}`,
        value: binding,
      }),
    ),
  ];
  const needed = [...new Set(seeded.bindings.flatMap((binding): CapabilityGroup[] => {
    const kind = CAPABILITIES[binding.capability_ref].kind;
    return kind === null ? [] : [ACTION_KIND_GROUPS[kind]];
  }))];
  const groups = document.capability_groups;
  const missing = needed.filter((group) => !groups.includes(group));
  if (missing.length > 0) {
    ops.push({ op: "replace", path: "/capability_groups", value: [...groups, ...missing] });
  }
  if (needed.includes("conversation")) {
    for (const [field, value] of Object.entries(CONVERSATION_POLICY)) {
      if (document[field as keyof typeof CONVERSATION_POLICY] === undefined) {
        const policy = structuredClone(value);
        ops.push({ op: "add", path: `/${field}`, value: field === "observation" && catalogStep === "meet_the_room"
          ? { ...CONVERSATION_POLICY.observation, source_scopes: ["own_comments", "room"] }
          : policy });
      }
    }
  }
  if (catalogStep === "meet_the_room" && document.observation && !document.observation.source_scopes.includes("room")) {
    ops.push({ op: "replace", path: "/observation/source_scopes", value: [...document.observation.source_scopes, "room"] });
  }
  const grants: GrantId[] = [
    ...new Set(seeded.grants.filter((grant) => !document.grants.includes(grant))),
  ];
  const { worker, label } = CATALOG_STEPS[catalogStep];
  const workerLabel = WORKER_CATALOG[worker].label;
  return {
    kind: STRATEGY_PATCH,
    campaignId: input.campaignId,
    expectedBaseVersion: input.expectedBaseVersion,
    ops,
    dependencyVersions: { voice: null, knowledge: null, memory: null },
    ...(grants.length > 0 ? { requestedGrants: { add: grants, remove: [] } } : {}),
    provenance: {
      instruction: `Add step: ${label} (${workerLabel})`,
      recognizedIntent: {
        summary: `Add ${label}, a ${workerLabel} step`,
        paths: [
          ...new Set([
            ...ops.map((op) => op.path),
            ...(grants.length > 0 ? ["/grants"] : []),
          ]),
        ],
      },
      scope: { stepId: null },
      compilerVersion: ADD_STEP_COMPILER_VERSION,
    },
  };
}
