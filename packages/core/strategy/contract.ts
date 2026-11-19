import { z } from "zod";
import type { ScoutIntent } from "@engager/database/schema";
import {
  ACTION_KIND_GROUPS,
  ACTION_KIND_OWNERS,
  ACTION_MODES,
  CAPABILITIES,
  CAPABILITY_GROUPS,
  CAPABILITY_IDS,
  CATALOG_STEPS,
  CATALOG_STEP_IDS,
  CONTEXT_TYPES,
  CONTEXT_TYPE_IDS,
  STRATEGY_WORKERS,
  GRANT_IDS,
  READ_MODES,
  STEP_ENTRIES,
  TARGET_TYPES,
  capabilityKind,
  modeKeyOf,
  networkActionFor,
  type ActionMode,
  type BindingMode,
  type BudgetedModeKey,
  type CapabilityGroup,
  type CatalogStepId,
  type EffectClass,
  type ModeKey,
  type NetworkCatalog,
} from "./catalog";
import { upgradeStrategy } from "./upgrade";

/**
 * The `CampaignAgentStrategy` — ONE versioned document per campaign that
 * says what its workers may do: its steps, each owned by exactly one worker,
 * the actions each step binds with each one's mode, and the policy groups the
 * actions need. Spec §04, §05, §07, §13.
 *
 * ONE MODE PER ACTION. A send's Off / Ask me / Automatic, and a read's On /
 * Off, is its step's binding and nothing else: no scope above the step keeps
 * a mode of its own (founder, 2026-10-16; the account's, 2026-11-15). What
 * binds every campaign on the account is arithmetic — its ceilings and
 * windows, the Stops and the kill switch — which only ever lowers a mode
 * (`resolve.ts`). The account default's `grants` and `max_mode`, and a
 * campaign's own `max_mode`, are still accepted here and no longer read
 * (INV-28); no patch writes a `max_mode` (`patch.ts`).
 *
 * Two scopes share this shape. A campaign's own document names its
 * `campaign_id`; the ACCOUNT DEFAULT names none and is stored against its
 * channel (a channel is one account). Exposure is the account's (INV-4), so
 * the rolling-24h budgets and the sending windows live on the account default
 * only — a campaign document carrying either fails here, which is how INV-28 is
 * resolved against INV-4: a campaign can lower its own cap, never hold a
 * ceiling.
 *
 * FAILS CLOSED. Every object is `.strict()`, so an unknown field is an error
 * with a path rather than a key nobody reads; and null never means unlimited —
 * a budget the owner has not set is an explicit null that keeps Automatic
 * unreachable (`resolve.ts`). Fields marked `=` in the spec are literals.
 *
 * A document stored under an older schema is read as this one
 * (`upgrade.ts`) before any of it is checked.
 *
 * Validation is two-layered. The shape and every network-independent rule —
 * a step's worker owns what it binds, references resolve, a group's fields are
 * present exactly when the group is on — need nothing but the document. The
 * network's rows (labels, targets, allowed modes) need the campaign's channel,
 * so `strategySchema` takes the network catalog, and a document whose
 * campaign has no channel can be checked only for its shape: it cannot
 * activate.
 */

/** Bump when a document's shape advances. The agent's start-up reprojection is
 *  stamped by this and by `upgrade.ts`'s code, so an edit there reprojects too. */
export const STRATEGY_SCHEMA_VERSION = 6;

/** Stable ids a patch can address: step ids, binding ids. */
const stableId = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]{0,63}$/,
    "lowercase letters, digits and underscores, starting with a letter",
  );
/** An opaque reference to an asset, profile or record that lives elsewhere. */
const reference = z.string().min(1).max(200);
const positiveInt = z.number().int().min(1);

const actionMode = z.enum(ACTION_MODES);
const bindingMode = z.enum(["off", "on", "review", "auto"]);

const capShape = {
  publish_comment: actionMode.optional(),
  public_reply: actionMode.optional(),
  room_reply: actionMode.optional(),
  like_target: actionMode.optional(),
  invite: actionMode.optional(),
  accept_invite: actionMode.optional(),
  dm: actionMode.optional(),
  followup: actionMode.optional(),
} satisfies Record<ModeKey, z.ZodTypeAny>;
/** The most each action may be, per key. Absent is no cap. */
const capsSchema = z.object(capShape).strict();

const rollingBudget = z.number().int().min(0).nullable();
const rollingBudgetShape = {
  like_target: rollingBudget,
  invite: rollingBudget,
  accept_invite: rollingBudget,
  dm: rollingBudget,
  followup: rollingBudget,
} satisfies Record<BudgetedModeKey, z.ZodTypeAny>;
/** Every key is required and nullable: a ceiling the owner has not set is
 *  written as null, never left out, so "unset" cannot be read as "unlimited".
 *  Follow-ups count against both the DM and the follow-up budget. */
const budgetsSchema = z
  .object({
    max_outbound_dms_per_person_per_30d: z.number().int().min(0).nullable(),
    action_budgets_per_rolling_24h: z.object(rollingBudgetShape).strict(),
  })
  .strict();

const localTime = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/, "HH:MM on a 24-hour clock");

/** ISO weekdays, Monday = 1. A window never crosses midnight: an overnight
 *  window is two windows, split explicitly. */
const windowSchema = z
  .object({
    weekdays: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .refine((days) => new Set(days).size === days.length, "each weekday once"),
    start_local: localTime,
    end_local: localTime,
  })
  .strict()
  .refine((window) => window.end_local > window.start_local, {
    message:
      "end_local must follow start_local; split an overnight window into two",
    path: ["end_local"],
  });

/** An IANA zone name — not an offset, not an abbreviation the runtime happens
 *  to accept. Daylight saving comes from the zone. */
function isIanaZone(zone: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(zone)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** When external actions may go out. No window set leaves the channel's
 *  active hours the only ones (`withinWindows`); empty calendar coverage
 *  claims no availability at all. */
const scheduleSchema = z
  .object({
    timezone: z.string().refine(isIanaZone, "an IANA time zone, e.g. Europe/London"),
    allowed_windows: z.array(windowSchema),
    booking_link_id: reference.nullable(),
    calendar_coverage_ids: z.array(reference),
  })
  .strict();

const uniqueList = <T extends z.ZodTypeAny>(item: T) =>
  z
    .array(item)
    .refine(
      (values) => new Set(values).size === values.length,
      "each value once",
    );

const observationSchema = z
  .object({
    source_scopes: uniqueList(
      z.enum(["own_comments", "explicitly_adopted_comments", "room"]),
    ).refine((scopes) => scopes.length > 0, "at least one source scope"),
    direct_replies_only: z.literal(true),
    replay_lookback_hours: z.number().int().min(0),
    catchup_requires_review: z.boolean(),
  })
  .strict();

const eligibilitySchema = z
  .object({
    neutral_relevant: z.enum(["eligible", "review", "skip"]),
    negative: z.enum(["skip", "review"]),
    spam: z.literal("skip"),
    unknown: z.literal("review"),
    exclusion_set_id: reference.nullable(),
  })
  .strict();

const inviteSchema = z
  .object({
    note_required: z.boolean(),
    no_repeat_invite: z.literal(true),
  })
  .strict();

const dmSchema = z
  .object({
    outgoing_acceptance: z.enum(["wait_for_interest", "contextual_opener"]),
    incoming_linked_opener: z.boolean(),
  })
  .strict();

const ctaSchema = z
  .object({
    after_relevant_exchanges: positiveInt,
    cta_asset_id: reference,
  })
  .strict();

const followupSchema = z
  .object({
    max_count: z.union([z.literal(0), z.literal(1)]),
    delay_hours: positiveInt,
    requires_explicit_interest: z.literal(true),
  })
  .strict();

/** The spec's style controls. A null profile id is the campaign's own voice
 *  (`campaigns.voice_id`, itself null for the org default) and a null sentence
 *  target leaves length to that voice — the seed writes both, so the document
 *  does not become a second answer to which voice a campaign uses. */
const voiceSchema = z
  .object({
    voice_profile_id: reference.nullable(),
    casing: z.enum(["sentence", "preserve_user"]),
    capital_i: z.boolean(),
    sentence_target: positiveInt.nullable(),
    random_typos: z.literal(false),
  })
  .strict();

const retentionSchema = z
  .object({ content_days: positiveInt, audit_days: positiveInt })
  .strict();

const safetySchema = z
  .object({
    human_takeover_blocks_send: z.literal(true),
    fresh_check_required: z.literal(true),
    unknown_send: z.literal("reconcile_only"),
  })
  .strict();

export const MEMORY_SLOTS = [
  "goal_audience",
  "preferences_voice",
  "business_knowledge",
  "relationship_memory",
  "run_state",
  "permissions",
  "outcome_evidence",
] as const;

const memoryBindingSchema = z
  .object({
    slot: z.enum(MEMORY_SLOTS),
    scope: z.enum(["account", "campaign", "step", "person"]),
    access: z.enum(["read", "write"]),
  })
  .strict()
  .refine((binding) => binding.slot !== "permissions" || binding.access === "read", {
    message:
      "permissions are protected records, never a memory the model can write",
    path: ["access"],
  });

const stepBudgetSchema = z
  .object({
    iterations_per_wake: positiveInt,
    tool_actions_per_wake: positiveInt,
    elapsed_seconds_per_wake: positiveInt,
    tokens_per_wake: positiveInt,
  })
  .strict();

export const ENTRY_EVENTS = [
  "campaign_wake",
  "explicit_start",
  "candidate_matched",
  "lead_served",
  "comment_posted",
  "direct_reply",
  "room_member_spotted",
  "invitation_status",
  "inbound_dm",
  "outcome_evidence",
] as const;

/** What the scheduler enforces before a step is entered (INV-32). A link
 *  between steps is advisory; these are not. */
const barrierSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("requires_step"), step_id: stableId }).strict(),
  z.object({ type: z.literal("requires_read"), step_id: stableId, action_binding_id: stableId }).strict(),
  z.object({ type: z.literal("wait"), hours: positiveInt }).strict(),
  z.object({ type: z.literal("approval") }).strict(),
  z
    .object({ type: z.literal("evidence"), evidence: z.string().min(1).max(200) })
    .strict(),
]);

const stepSchema = z
  .object({
    step_id: stableId,
    /** Which of the catalog's steps this is — what the Add step picker
     *  offered, and what tells two rows of one kind apart. */
    catalog_step: z.enum(CATALOG_STEP_IDS),
    worker: z.enum(STRATEGY_WORKERS),
    label: z.string().trim().min(1).max(80),
    objective: z.string().trim().min(1).max(500),
    instructions: z.string().max(4000),
    context_refs: uniqueList(z.enum(CONTEXT_TYPE_IDS)),
    allowed_tools: uniqueList(z.enum(CAPABILITY_IDS)),
    action_binding_refs: uniqueList(stableId),
    output_schema: z.literal("AgentStepResult.v1"),
    /** Inherits the configured provider when null; it can never enlarge
     *  authority. */
    model_override: z.string().min(1).max(120).nullable(),
    budget: stepBudgetSchema,
    on_missing_context: z.enum(["wait", "review", "wait_or_review", "stop"]),
    on_no_progress: z.enum(["wait", "stop", "escalate"]),
    entry: z.object({ event: z.enum(ENTRY_EVENTS) }).strict(),
    barriers: z.array(barrierSchema),
  })
  .strict();

export const CONDITION_PREDICATES = [
  "relevant_reply",
  "engaged_first",
  "expressed_interest",
  "verified_linked",
  "not_connected",
] as const;

const intentCeilingShape = {
  asking: actionMode.optional(),
  has_problem: actionMode.optional(),
  topic_only: actionMode.optional(),
} satisfies Record<ScoutIntent, z.ZodTypeAny>;
/** The most an opener may be, per intent. Absent is the intent's default
 *  (`INTENT_CEILING_DEFAULTS`), and the field is written only when the owner
 *  changes a ceiling. */
const intentCeilingsSchema = z.object(intentCeilingShape).strict();

/** A small action inside a step. `mode` is the action's one mode — absent is
 *  Off, and an action that takes no mode (Record outcome) carries none.
 *  `target` and `condition` are overrides of the catalog row: absent aims
 *  where the row aims, whenever it fits. `intent_ceilings` belongs to one
 *  action only, the Comment of a step that answers the leads Scout found
 *  (`takesIntentCeilings`). */
const bindingSchema = z
  .object({
    action_binding_id: stableId,
    owner_step_id: stableId,
    capability_ref: z.enum(CAPABILITY_IDS),
    mode: bindingMode.optional(),
    intent_ceilings: intentCeilingsSchema.optional(),
    target: z.enum(TARGET_TYPES).optional(),
    condition: z
      .object({ predicate: z.enum(CONDITION_PREDICATES), expect: z.boolean() })
      .strict()
      .optional(),
  })
  .strict();

/** Canvas metadata. The runtime never reads it (INV-32). */
const presentationSchema = z
  .object({
    positions: z
      .record(stableId, z.object({ x: z.number(), y: z.number() }).strict())
      .optional(),
    collapsed: uniqueList(stableId).optional(),
  })
  .strict();

/** The document's shape alone, before any rule that needs more than one field.
 *  Exported for one reader: a patch addresses its paths (`patch.ts`), and a
 *  path this shape has no field for is one no patch may name. */
export const strategyShape = z
  .object({
    schema_version: z.literal(STRATEGY_SCHEMA_VERSION),
    capability_groups: uniqueList(z.enum(CAPABILITY_GROUPS)).refine(
      (groups) => groups.length > 0,
      "at least one capability group",
    ),
    /** Null on the account default. */
    campaign_id: z.number().int().positive().nullable(),
    version: positiveInt,
    previous_version: positiveInt.nullable(),
    /** UTC ISO instant. */
    effective_at: z.string().datetime(),
    /** Retired: read by nothing since migrations 0338 and 0339 folded it into
     *  the steps, and accepted only so a version stored before still parses. */
    max_mode: capsSchema.optional(),
    grants: uniqueList(z.enum(GRANT_IDS)),
    steps: z.array(stepSchema).optional(),
    action_bindings: z.array(bindingSchema).optional(),
    observation: observationSchema.optional(),
    eligibility: eligibilitySchema.optional(),
    invite: inviteSchema.optional(),
    dm: dmSchema.optional(),
    cta: ctaSchema.optional(),
    followup: followupSchema.optional(),
    budgets: budgetsSchema.optional(),
    schedule: scheduleSchema.optional(),
    voice: voiceSchema,
    knowledge_profile_id: reference.nullable(),
    retention: retentionSchema,
    safety: safetySchema,
    memory_bindings: z.array(memoryBindingSchema),
    presentation: presentationSchema.optional(),
  })
  .strict();

export type CampaignAgentStrategy = z.infer<typeof strategyShape>;
export type StrategyStep = NonNullable<CampaignAgentStrategy["steps"]>[number];
export type ActionBinding = NonNullable<
  CampaignAgentStrategy["action_bindings"]
>[number];

/** Whether a document holds a step of this catalog step. */
export function holdsStep(
  document: Pick<CampaignAgentStrategy, "steps">,
  catalogStep: CatalogStepId,
): boolean {
  return (document.steps ?? []).some((step) => step.catalog_step === catalogStep);
}

/** Whether a binding is the one action that takes `intent_ceilings`: the
 *  Comment of Comment on posts on a campaign that finds leads, where an
 *  opener is written to each lead by what their words show. Pure. */
export function takesIntentCeilings(
  document: Pick<CampaignAgentStrategy, "steps">,
  step: Pick<StrategyStep, "catalog_step">,
  binding: Pick<ActionBinding, "capability_ref">,
): boolean {
  return (
    step.catalog_step === "comment_on_posts" &&
    binding.capability_ref === "publish_comment" &&
    holdsStep(document, "find_leads")
  );
}

/**
 * Each key's mode across a campaign's steps, for a summary that names an
 * action by its key rather than by its step: the loosest of the bindings
 * that send it — any of them may act at that mode — and absent for a key no
 * step binds. A summary's word for a campaign, never what decides a send.
 * Pure.
 */
export function modesByKey(
  document: Pick<CampaignAgentStrategy, "action_bindings">,
): Partial<Record<ModeKey, ActionMode>> {
  const out: Partial<Record<ModeKey, ActionMode>> = {};
  for (const binding of document.action_bindings ?? []) {
    const key = modeKeyOf(binding.capability_ref);
    if (key === null) continue;
    const mode = (binding.mode ?? "off") as ActionMode;
    const held = out[key];
    out[key] = held !== undefined && ACTION_MODES.indexOf(held) >= ACTION_MODES.indexOf(mode) ? held : mode;
  }
  return out;
}

/** Why a document failed beyond its shape — carried on the issue's
 *  `params.code` so a caller can branch without parsing prose. */
export type StrategyIssueCode =
  | "account_default_only"
  | "required_on_account_default"
  | "campaign_only"
  | "required_on_campaign"
  | "group_fields_required"
  | "group_not_enabled"
  | "duplicate_id"
  | "unknown_step"
  | "unknown_binding"
  | "binding_owner_mismatch"
  | "step_worker_mismatch"
  | "not_owned_by_worker"
  | "not_bindable"
  | "not_allowed_on_step"
  | "not_on_network"
  | "not_in_step"
  | "target_not_allowed"
  | "mode_not_allowed"
  | "takes_no_mode"
  | "intent_ceilings_not_allowed"
  | "entry_not_allowed"
  | "one_scout_step"
  | "version_order";

/** The groups whose policy fields a document must carry when they are on —
 *  and must leave out when they are off. */
const GROUP_FIELDS = {
  conversation: ["observation", "eligibility", "invite", "dm", "followup"],
  conversion: ["cta"],
} as const satisfies Partial<
  Record<CapabilityGroup, readonly (keyof CampaignAgentStrategy)[]>
>;

/** The modes each effect class admits, whatever the network. A draft is
 *  never bound — it is a supporting tool — so it admits none. */
const EFFECT_MODES: Record<EffectClass, readonly BindingMode[] | null> = {
  read: READ_MODES,
  send: ACTION_MODES,
  draft: null,
  none: null,
};

/** The exposure fields only the account default may carry (INV-28). */
const ACCOUNT_ONLY_FIELDS = ["budgets", "schedule"] as const;
/** The fields only a campaign carries: its strategy and canvas. */
const CAMPAIGN_ONLY_FIELDS = [
  "steps",
  "action_bindings",
  "presentation",
] as const;

export type StrategyContext = {
  /** The campaign's channel's network catalog, or null when the campaign has
   *  no channel: only the shape and the network-independent rules apply. */
  network: NetworkCatalog | null;
};

/** The contract, bound to one network's rows. */
export function strategySchema(context: StrategyContext) {
  return strategyShape.superRefine((doc, ctx) =>
    checkStrategy(doc, context, (code, path, message) =>
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message,
        params: { code },
      }),
    ),
  );
}

/** A stored or proposed document, read as the current schema
 *  (`upgradeStrategy`) and checked against the contract. */
export function parseStrategy(input: unknown, context: StrategyContext) {
  return strategySchema(context).safeParse(upgradeStrategy(input));
}

/**
 * Every step whose start `after` CHANGES to one its catalog step cannot take
 * (`STEP_ENTRIES`). A change only: the document's shape admits any start, and
 * a step that keeps the start it was stored with — one designed before the
 * list, say — keeps it until the owner picks another. A step `after` adds
 * has no start to change.
 */
export function entryChangeIssues(
  before: CampaignAgentStrategy,
  after: CampaignAgentStrategy,
): Array<{ stepId: string; code: "entry_not_allowed"; message: string }> {
  const prior = new Map((before.steps ?? []).map((step) => [step.step_id, step.entry.event]));
  return (after.steps ?? []).flatMap((step) => {
    const was = prior.get(step.step_id);
    const allowed = STEP_ENTRIES[step.catalog_step];
    if (was === undefined || was === step.entry.event || allowed.includes(step.entry.event)) return [];
    return [
      {
        stepId: step.step_id,
        code: "entry_not_allowed" as const,
        message: `${CATALOG_STEPS[step.catalog_step].label} starts on ${allowed.join(" or ")}, never ${step.entry.event}`,
      },
    ];
  });
}

/** The `StrategyIssueCode` of an issue this contract raised, or null for a
 *  plain shape error. */
export function strategyIssueCode(issue: z.ZodIssue): StrategyIssueCode | null {
  if (issue.code !== z.ZodIssueCode.custom) return null;
  const code = (issue.params as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? (code as StrategyIssueCode) : null;
}

type Report = (
  code: StrategyIssueCode,
  path: (string | number)[],
  message: string,
) => void;

function checkStrategy(
  doc: CampaignAgentStrategy,
  context: StrategyContext,
  report: Report,
): void {
  const isAccountDefault = doc.campaign_id === null;

  if (doc.previous_version !== null && doc.previous_version >= doc.version) {
    report("version_order", ["previous_version"], "previous_version must be older than version");
  }

  if (isAccountDefault) {
    for (const field of ACCOUNT_ONLY_FIELDS) {
      if (doc[field] === undefined) {
        report("required_on_account_default", [field], `the account default carries ${field}`);
      }
    }
    for (const field of CAMPAIGN_ONLY_FIELDS) {
      if (doc[field] !== undefined) {
        report("campaign_only", [field], `${field} belongs to a campaign, not the account default`);
      }
    }
  } else {
    for (const field of ACCOUNT_ONLY_FIELDS) {
      if (doc[field] !== undefined) {
        report(
          "account_default_only",
          [field],
          `${field} is the account's: a campaign never carries a ceiling or a window`,
        );
      }
    }
    for (const field of ["steps", "action_bindings"] as const) {
      if (doc[field] === undefined) {
        report("required_on_campaign", [field], `a campaign carries ${field}`);
      }
    }
  }

  const groups = new Set(doc.capability_groups);
  for (const [group, fields] of Object.entries(GROUP_FIELDS)) {
    const enabled = groups.has(group as CapabilityGroup);
    for (const field of fields) {
      if (enabled && doc[field] === undefined) {
        report("group_fields_required", [field], `${group} is enabled, so ${field} is required`);
      } else if (!enabled && doc[field] !== undefined) {
        report("group_not_enabled", [field], `${field} belongs to ${group}, which is not enabled`);
      }
    }
  }

  const steps = doc.steps ?? [];
  const bindings = doc.action_bindings ?? [];
  const stepById = new Map<string, StrategyStep>();
  steps.forEach((step, index) => {
    if (stepById.has(step.step_id)) {
      report("duplicate_id", ["steps", index, "step_id"], `step ${step.step_id} is declared twice`);
    }
    stepById.set(step.step_id, step);
  });
  const bindingById = new Map<string, ActionBinding>();
  bindings.forEach((binding, index) => {
    if (bindingById.has(binding.action_binding_id)) {
      report(
        "duplicate_id",
        ["action_bindings", index, "action_binding_id"],
        `binding ${binding.action_binding_id} is declared twice`,
      );
    }
    bindingById.set(binding.action_binding_id, binding);
  });

  steps.forEach((step, index) => {
    const path = ["steps", index];
    const catalogWorker = CATALOG_STEPS[step.catalog_step].worker;
    if (step.worker !== catalogWorker) {
      report(
        "step_worker_mismatch",
        [...path, "worker"],
        `${step.catalog_step} is a ${catalogWorker} step`,
      );
    }
    step.allowed_tools.forEach((tool, toolIndex) => {
      const workers: readonly string[] = CAPABILITIES[tool].workers;
      if (!workers.includes(step.worker)) {
        report(
          "not_owned_by_worker",
          [...path, "allowed_tools", toolIndex],
          `${tool} is not a ${step.worker} capability`,
        );
      }
    });
    step.context_refs.forEach((context, contextIndex) => {
      const workers: readonly string[] = CONTEXT_TYPES[context].workers;
      if (!workers.includes(step.worker)) {
        report(
          "not_owned_by_worker",
          [...path, "context_refs", contextIndex],
          `${context} is not context a ${step.worker} reads`,
        );
      }
    });
    step.action_binding_refs.forEach((ref, refIndex) => {
      const binding = bindingById.get(ref);
      if (!binding) {
        report("unknown_binding", [...path, "action_binding_refs", refIndex], `no binding ${ref}`);
      } else if (binding.owner_step_id !== step.step_id) {
        report(
          "binding_owner_mismatch",
          [...path, "action_binding_refs", refIndex],
          `${ref} is owned by ${binding.owner_step_id}`,
        );
      }
    });
    step.barriers.forEach((barrier, barrierIndex) => {
      if (barrier.type === "requires_read") {
        const barrierPath = [...path, "barriers", barrierIndex];
        const dependency = stepById.get(barrier.step_id);
        const binding = bindingById.get(barrier.action_binding_id);
        if (!dependency || dependency.step_id === step.step_id) {
          report("unknown_step", [...barrierPath, "step_id"], `no other step ${barrier.step_id}`);
        } else if (!binding || binding.owner_step_id !== dependency.step_id ||
          !dependency.action_binding_refs.includes(binding.action_binding_id)) {
          report("unknown_binding", [...barrierPath, "action_binding_id"], `no binding ${barrier.action_binding_id} on ${barrier.step_id}`);
        } else if (CAPABILITIES[binding.capability_ref].effect !== "read") {
          report("not_bindable", [...barrierPath, "action_binding_id"], `${barrier.action_binding_id} is not a read`);
        }
      }
      if (
        barrier.type === "requires_step" &&
        (barrier.step_id === step.step_id || !stepById.has(barrier.step_id))
      ) {
        report(
          "unknown_step",
          [...path, "barriers", barrierIndex, "step_id"],
          `no other step ${barrier.step_id}`,
        );
      }
    });
  });

  bindings.forEach((binding, index) => {
    const path = ["action_bindings", index];
    const step = stepById.get(binding.owner_step_id);
    if (!step) {
      report("unknown_step", [...path, "owner_step_id"], `no step ${binding.owner_step_id}`);
      return;
    }
    if (!step.action_binding_refs.includes(binding.action_binding_id)) {
      report(
        "binding_owner_mismatch",
        [...path, "owner_step_id"],
        `${step.step_id} does not list ${binding.action_binding_id}`,
      );
    }
    if (binding.intent_ceilings !== undefined && !takesIntentCeilings(doc, step, binding)) {
      report(
        "intent_ceilings_not_allowed",
        [...path, "intent_ceilings"],
        "intent_ceilings belong to the Comment of Comment on posts on a campaign that finds leads",
      );
    }
    const kind = capabilityKind(binding.capability_ref);
    if (kind === null) {
      report(
        "not_bindable",
        [...path, "capability_ref"],
        `${binding.capability_ref} supports a step but is not an action a step binds`,
      );
      return;
    }
    // Layer 1: whatever the network, a worker binds only its own kinds.
    const owner = ACTION_KIND_OWNERS[kind];
    if (owner !== step.worker) {
      report(
        "not_owned_by_worker",
        [...path, "capability_ref"],
        `${binding.capability_ref} is the ${owner}'s, not the ${step.worker}'s`,
      );
      return;
    }
    if (!groups.has(ACTION_KIND_GROUPS[kind])) {
      report(
        "group_not_enabled",
        [...path, "capability_ref"],
        `${binding.capability_ref} needs the ${ACTION_KIND_GROUPS[kind]} group`,
      );
    }
    if (!step.allowed_tools.includes(binding.capability_ref)) {
      report(
        "not_allowed_on_step",
        [...path, "capability_ref"],
        `${step.step_id} does not allow ${binding.capability_ref}`,
      );
    }
    const checkMode = (allowed: readonly BindingMode[] | null, name: string): boolean => {
      if (binding.mode === undefined) return false;
      if (allowed === null) {
        report("takes_no_mode", [...path, "mode"], `${name} takes no mode`);
        return true;
      }
      if (allowed.includes(binding.mode)) return false;
      report(
        "mode_not_allowed",
        [...path, "mode"],
        `${name} is ${allowed.join(" / ")}, never ${binding.mode}`,
      );
      return true;
    };
    // A read is On / Off and a send Off / Ask me / Automatic on every network,
    // so the effect class decides — a document with no network to check
    // against still cannot store Research as Ask me.
    const modeRefused = checkMode(
      EFFECT_MODES[CAPABILITIES[binding.capability_ref].effect],
      binding.capability_ref,
    );
    // Layer 2: the network's row for this kind on this step.
    if (!context.network) return;
    const row = networkActionFor(context.network, binding.capability_ref, step.catalog_step);
    if (!row.ok) {
      report(
        row.reason,
        [...path, "capability_ref"],
        row.reason === "not_on_network"
          ? `${context.network.network} has no ${kind} action`
          : `${context.network.network} offers ${kind} on another step, not ${step.catalog_step}`,
      );
      return;
    }
    const target = binding.target ?? row.action.defaultTarget;
    if (!row.action.targets.includes(target)) {
      report(
        "target_not_allowed",
        [...path, "target"],
        `${row.action.label} targets ${row.action.targets.join(" or ")}, never ${target}`,
      );
    }
    if (!modeRefused) checkMode(row.action.modes, row.action.label);
  });

  for (const stepId of Object.keys(doc.presentation?.positions ?? {})) {
    if (!stepById.has(stepId)) {
      report("unknown_step", ["presentation", "positions", stepId], `no step ${stepId}`);
    }
  }
  (doc.presentation?.collapsed ?? []).forEach((stepId, index) => {
    if (!stepById.has(stepId)) {
      report("unknown_step", ["presentation", "collapsed", index], `no step ${stepId}`);
    }
  });
}
