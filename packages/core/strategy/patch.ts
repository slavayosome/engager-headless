import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { AppError } from "@engager/common/errors";
import {
  campaignStrategies,
  campaigns,
  channels,
  messages,
  type CampaignStrategyRow,
  type Channel,
  type StrategyProvenance,
  type ScoutIntent,
  type SearchDepth,
  type StoredSearchDepth,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { refuseStepVoice } from "../campaigns/oneEach";
import { recordedLiveChecks } from "../liveChecks/records";
import { setCampaignStatusOp } from "../operations/campaigns";
import { activateStrategy, readAccountDefault, type ActivationOutcome } from "./activate";
import {
  STEP_SETTINGS,
  describeAction,
  modeWords,
  policyRows,
  said,
  type CardRow,
} from "./cardWords";
import {
  CAPABILITIES,
  CEILING_INTENTS,
  GRANT_IDS,
  INTENT_CEILING_DEFAULTS,
  INTENT_LABELS,
  NETWORK_CATALOGS,
  intentCeilingsOf,
  rankOf,
  stepName,
  type ActionMode,
  type BindingMode,
  type GrantId,
  type LiveChecks,
  type NetworkCatalog,
  type TargetType,
} from "./catalog";
import {
  strategyIssueCode,
  strategyShape,
  entryChangeIssues,
  holdsStep,
  parseStrategy,
  type ActionBinding,
  type CampaignAgentStrategy,
  type StrategyIssueCode,
  type StrategyStep,
} from "./contract";
import { documentChanges } from "./flip";
import { resolveStrategy, type ResolvedAction } from "./resolve";
import {
  currentSearchDepth,
  depthActor,
  readsDeep,
  SEARCH_DEPTH_LABELS,
  searchDepthOf,
  settleSearchDepth,
} from "./searchDepth";
import { currentDocument } from "./upgrade";

/**
 * `strategy.patch` — THE ONE OWNER-FACING WAY TO CHANGE A CAMPAIGN'S
 * STRATEGY (INV-25, INV-26).
 *
 * A patch names the version it was written against, the paths it changes and
 * the values it sets, when it takes effect, the voice / knowledge / memory
 * versions it was composed from, any grant it asks for, and where it came from.
 * The server applies it to a copy of that version, re-validates the WHOLE
 * result through the contract (37), resolves every action, and only then
 * decides what it is:
 *
 *   confirm — it widens authority: an action's mode or ceiling rises (the
 *             Comment's ceiling for an intent's opener too), a grant, a
 *             capability group or an action kind arrives, a step gains a send
 *             or a sending step's entry moves, the audience widens, a barrier
 *             or a budget loosens. It waits for the owner's click on a
 *             displayed diff.
 *   apply   — it narrows, or it is style. It becomes a new version at once,
 *             with a visible diff and an undo.
 *
 * COMPARE-AND-SWAP. `expectedBaseVersion` must still be the active version,
 * both when the patch is drawn and when it lands; a competing edit answers
 * `strategy_conflict` with a fresh diff against the version now in force and
 * writes nothing. Applying writes exactly one table — a new
 * `campaign_strategies` row, plus an undo's cancellations — and activation
 * (`activate.ts`) projects the rest. Undo is another new version; no row is
 * ever rewritten or deleted.
 *
 * THE TEXT IS DATA. `provenance.instruction` is recorded, never read: what
 * changes is the typed ops, and only at paths the recognized intent names and
 * within the scope it states. A quoted post in the instruction can therefore
 * move nothing the intent did not name. A change to who the campaign reaches
 * with no stated scope is refused `clarify`, never guessed.
 *
 * A campaign's channel is not a path: the binding is the campaign row's, fixed
 * for its life (INV-34). Nor are a version's stamps, which the server writes,
 * or its grants, which change only through `requestedGrants` so each one is
 * named on the card.
 */

export const STRATEGY_PATCH = "strategy.patch";

/** Provenance a server-composed undo carries. */
export const UNDO_COMPILER_VERSION = "strategy-undo/1";

/** Provenance a server-composed Start of a draft carries. */
export const START_COMPILER_VERSION = "strategy-start/1";

const SEGMENT = "[a-z][a-z0-9_]{0,63}";

/** A JSON pointer into the document. Steps and bindings are addressed by their
 *  stable id, never by position, so a patch means the same thing whatever was
 *  inserted before it; every other list is replaced whole. */
const pointer = z
  .string()
  .max(240)
  .regex(
    new RegExp(`^(?:/${SEGMENT})+$`),
    "a JSON pointer such as /action_bindings/comment/mode or /steps/handle_reply/instructions",
  );

/** What an op sets. The contract, not this, decides whether it fits. */
const jsonValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.unknown()),
  z.record(z.unknown()),
]);

const patchOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("replace"), path: pointer, value: jsonValue }).strict(),
  z.object({ op: z.literal("add"), path: pointer, value: jsonValue }).strict(),
  z.object({ op: z.literal("remove"), path: pointer }).strict(),
  z
    .object({
      op: z.literal("move"),
      path: pointer,
      index: z.number().int().min(0).max(63),
    })
    .strict(),
]);
export type PatchOp = z.infer<typeof patchOp>;

const dependencyVersion = z.number().int().min(0).nullable();
const grantList = z.array(z.enum(GRANT_IDS)).max(GRANT_IDS.length);

export const strategyPatchSchema = z
  .object({
    kind: z.literal(STRATEGY_PATCH),
    campaignId: z.number().int().positive(),
    expectedBaseVersion: z
      .number()
      .int()
      .positive()
      .describe(
        "The ACTIVE version this patch was written against (get_campaign). If another version replaced it, the patch answers strategy_conflict with a fresh diff and writes nothing.",
      ),
    ops: z
      .array(patchOp)
      .max(64)
      .describe(
        "JSON-patch ops in order: replace, add (a field, or a step or binding at /steps/<step_id> or /action_bindings/<id>), remove, move (a step, to an index). Empty only on an undo, or to start a campaign as its draft stands.",
      ),
    undoVersion: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Undo instead of ops: writes a NEW version and cancels every scheduled one.",
      ),
    effectiveAt: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe("ISO 8601; omit for now."),
    dependencyVersions: z
      .object({
        voice: dependencyVersion,
        knowledge: dependencyVersion,
        memory: dependencyVersion,
      })
      .strict()
      .describe(
        "Voice, knowledge and memory versions this patch was composed from; null if unused.",
      ),
    requestedGrants: z
      .object({ add: grantList, remove: grantList })
      .strict()
      .optional()
      .describe(
        "Grant changes, never in ops. Adding one widens authority.",
      ),
    provenance: z
      .object({
        instruction: z
          .string()
          .max(4000)
          .describe("The owner's words, verbatim. Recorded only."),
        recognizedIntent: z
          .object({
            summary: z.string().trim().min(1).max(500),
            paths: z
              .array(pointer)
              .max(32)
              .describe("Every op sits at or under one of these."),
          })
          .strict(),
        scope: z
          .object({ stepId: z.string().regex(new RegExp(`^${SEGMENT}$`)).nullable() })
          .strict()
          .nullable()
          .describe(
            "{ stepId: null } for the whole campaign, a step id for one step; null if unstated (refused with clarify if the patch changes who it reaches).",
          ),
        compilerVersion: z.string().trim().min(1).max(120),
      })
      .strict(),
  })
  .strict();
export type StrategyPatch = z.infer<typeof strategyPatchSchema>;

export type PatchIssueCode =
  | "unknown_path"
  | "not_patchable"
  | "channel_fixed"
  | "outside_intent"
  | "outside_scope"
  | "id_mismatch"
  | "duplicate_id"
  | "invalid_index"
  | "grant_missing"
  | "empty_patch";

export type PatchIssue = {
  path: string;
  code: PatchIssueCode | StrategyIssueCode | null;
  message: string;
};

export type StrategyPatchRefusal =
  | "campaign_not_found"
  | "strategy_not_activatable"
  | "strategy_conflict"
  | "strategy_patch_invalid"
  | "clarify"
  | "not_undoable"
  | "find_posts_retired"
  | "proposal_is_a_no_op";

export class StrategyPatchError extends AppError {
  constructor(
    code: StrategyPatchRefusal,
    message: string,
    readonly recovery: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(
      code,
      message,
      code === "campaign_not_found" ? 404 : code === "strategy_patch_invalid" ? 400 : 409,
    );
  }
}

function invalidPatch(issues: PatchIssue[]): StrategyPatchError {
  return new StrategyPatchError(
    "strategy_patch_invalid",
    `This patch does not make a valid strategy, so nothing was written: ${issues
      .map((issue) => `${issue.path} — ${issue.message}`)
      .join("; ")}.`,
    "Fix the named paths against get_campaign and send the patch again.",
    { issues },
  );
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** The lists a patch addresses by stable id, and the field that is the id. */
const KEYED_LISTS = { steps: "step_id", action_bindings: "action_binding_id" } as const;
type KeyedList = keyof typeof KEYED_LISTS;

const isKeyedList = (key: string | number | undefined): key is KeyedList =>
  typeof key === "string" && Object.hasOwn(KEYED_LISTS, key);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The stamps every version carries, which the server writes. */
export const STAMPED_FIELDS: ReadonlySet<string> = new Set([
  "schema_version",
  "campaign_id",
  "version",
  "previous_version",
  "effective_at",
]);

const segmentsOf = (path: string): string[] => path.split("/").slice(1);

/** `path` is `prefix` or sits beneath it, segment by segment. */
const under = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(`${prefix}/`);

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let node = schema;
  for (;;) {
    if (node instanceof z.ZodOptional || node instanceof z.ZodNullable) node = node.unwrap();
    else if (node instanceof z.ZodEffects) node = node.innerType();
    else return node;
  }
}

/** Whether the document's shape has a field at these segments: an object's
 *  key, a record's entry, or a step or binding by id — never a position. */
function shapeHas(segments: readonly string[]): boolean {
  let node: z.ZodTypeAny = strategyShape;
  for (let i = 0; i < segments.length; i += 1) {
    node = unwrap(node);
    if (node instanceof z.ZodObject) {
      const next = (node.shape as Record<string, z.ZodTypeAny | undefined>)[segments[i]!];
      if (!next) return false;
      node = next;
    } else if (node instanceof z.ZodRecord) {
      node = node.valueSchema as z.ZodTypeAny;
    } else if (node instanceof z.ZodArray && i === 1 && isKeyedList(segments[0])) {
      node = node.element as z.ZodTypeAny;
    } else {
      return false;
    }
  }
  return true;
}

/** Whether an op stays inside one step: the step itself, a binding it owns
 *  (before or after the op), or its place on the canvas. */
function withinStep(op: PatchOp, stepId: string, base: CampaignAgentStrategy): boolean {
  const [root, id, field] = segmentsOf(op.path);
  if (root === "steps") return id === stepId;
  if (root === "presentation") return id === "positions" && field === stepId;
  if (root !== "action_bindings" || id === undefined) return false;
  const owner =
    base.action_bindings?.find((binding) => binding.action_binding_id === id)?.owner_step_id ??
    ("value" in op && isRecord(op.value) && segmentsOf(op.path).length === 2
      ? op.value.owner_step_id
      : undefined);
  return owner === stepId;
}

/** Why a path is not one this patch may name, or null when it is. */
function pathIssue(op: PatchOp, base: CampaignAgentStrategy, patch: StrategyPatch): PatchIssue | null {
  const segments = segmentsOf(op.path);
  const root = segments[0]!;
  const refuse = (code: PatchIssueCode, message: string): PatchIssue => ({ path: op.path, code, message });
  if (segments.some((segment) => segment === "channel" || segment === "channel_id")) {
    return refuse(
      "channel_fixed",
      "a campaign's channel is its campaign row's, fixed for the campaign's life — moving a campaign is duplicating it onto another channel",
    );
  }
  if (STAMPED_FIELDS.has(root)) return refuse("not_patchable", "the server stamps this on every version");
  if (root === "grants") {
    return refuse("not_patchable", "grants change through requestedGrants, so the card names each one");
  }
  if (root === "max_mode") {
    return refuse(
      "not_patchable",
      "a campaign keeps no mode of its own: each step's mode is what happens, so change that step's mode at /action_bindings/<id>/mode",
    );
  }
  if (!shapeHas(segments)) return refuse("unknown_path", "the strategy has no such field");
  if (op.op === "move" && !(root === "steps" && segments.length === 2)) {
    return refuse("not_patchable", "only a step moves, as /steps/<step_id>");
  }
  if (!patch.provenance.recognizedIntent.paths.some((path) => under(op.path, path))) {
    return refuse("outside_intent", "the recognized intent does not name this path");
  }
  const stepId = patch.provenance.scope?.stepId;
  if (stepId && !withinStep(op, stepId, base)) {
    return refuse("outside_scope", `the stated scope is the step ${stepId}`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Applying ops — pure
// ---------------------------------------------------------------------------

/**
 * Apply ops to a copy of a document, in order. Pure. Stops at the first op
 * that cannot apply, because every later op was written against its result.
 * Whether the result is a strategy is the contract's question, not this.
 */
export function applyPatchOps(
  document: CampaignAgentStrategy,
  ops: readonly PatchOp[],
): { ok: true; document: Record<string, unknown> } | { ok: false; issues: PatchIssue[] } {
  const next = structuredClone(document) as Record<string, unknown>;
  for (const op of ops) {
    const failed = applyOp(next, op);
    if (failed) return { ok: false, issues: [failed] };
  }
  forgetRemovedSteps(document, next);
  return { ok: true, document: next };
}

/**
 * A step the ops removed takes its place on the canvas with it. Where a step
 * sits and whether it is folded are written by the canvas alone (INV-32),
 * never by whoever removes the step — so without this, the first drag of a
 * step would leave every later patch removing it refused by the contract,
 * over a position for a step that is gone. Only steps the base had and the
 * result has not: a position the ops wrote for a step that never existed is
 * still the contract's to refuse.
 */
function forgetRemovedSteps(base: CampaignAgentStrategy, next: Record<string, unknown>): void {
  const kept = new Set(stepIdsOf(next));
  const removed = new Set(stepIdsOf(base).filter((stepId) => !kept.has(stepId)));
  const presentation = next.presentation;
  if (removed.size === 0 || !isRecord(presentation)) return;
  if (isRecord(presentation.positions)) {
    for (const stepId of removed) delete presentation.positions[stepId];
  }
  if (Array.isArray(presentation.collapsed)) {
    presentation.collapsed = presentation.collapsed.filter((stepId) => !removed.has(stepId as string));
  }
}

/** A document's step ids, in strategy order — from a result the contract has
 *  not read yet as readily as from a version. */
function stepIdsOf(doc: Record<string, unknown> | CampaignAgentStrategy): string[] {
  return (Array.isArray(doc.steps) ? (doc.steps as unknown[]) : []).flatMap((step) =>
    isRecord(step) && typeof step.step_id === "string" ? [step.step_id] : [],
  );
}

function applyOp(doc: Record<string, unknown>, op: PatchOp): PatchIssue | null {
  const segments = segmentsOf(op.path);
  const missing = (depth: number): PatchIssue => ({
    path: op.path,
    code: "unknown_path",
    message: `nothing at /${segments.slice(0, depth).join("/")}`,
  });
  if (segments.length === 2 && isKeyedList(segments[0])) return applyToItem(doc, segments[0], segments[1]!, op);

  const list = isKeyedList(segments[0]) ? segments[0] : null;
  let node: unknown = doc;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i]!;
    node =
      Array.isArray(node) && i === 1 && list
        ? node.find((item) => isRecord(item) && item[KEYED_LISTS[list]] === segment)
        : isRecord(node)
          ? node[segment]
          : undefined;
    if (node === undefined) return missing(i + 1);
  }
  if (!isRecord(node)) return missing(segments.length - 1);
  const key = segments[segments.length - 1]!;
  switch (op.op) {
    case "replace":
      if (!Object.hasOwn(node, key)) {
        return { path: op.path, code: "unknown_path", message: "nothing there to replace; add sets a field that is absent" };
      }
      node[key] = structuredClone(op.value);
      return null;
    case "add":
      node[key] = structuredClone(op.value);
      return null;
    case "remove":
      if (!Object.hasOwn(node, key)) return missing(segments.length);
      delete node[key];
      return null;
    case "move":
      return { path: op.path, code: "not_patchable", message: "only a step moves" };
  }
}

/** An op on one step or binding, addressed by its id. */
function applyToItem(
  doc: Record<string, unknown>,
  list: KeyedList,
  id: string,
  op: PatchOp,
): PatchIssue | null {
  const idField = KEYED_LISTS[list];
  const items = doc[list];
  if (!Array.isArray(items)) {
    return { path: op.path, code: "unknown_path", message: `nothing at /${list}` };
  }
  const index = items.findIndex((item) => isRecord(item) && item[idField] === id);
  const absent: PatchIssue = { path: op.path, code: "unknown_path", message: `no ${idField} ${id}` };
  switch (op.op) {
    case "replace":
    case "add": {
      if (!isRecord(op.value) || op.value[idField] !== id) {
        return { path: op.path, code: "id_mismatch", message: `the value must carry ${idField} "${id}"` };
      }
      if (op.op === "replace") {
        if (index === -1) return absent;
        items[index] = structuredClone(op.value);
      } else {
        if (index !== -1) return { path: op.path, code: "duplicate_id", message: `${id} is already there` };
        items.push(structuredClone(op.value));
      }
      return null;
    }
    case "remove":
      if (index === -1) return absent;
      items.splice(index, 1);
      return null;
    case "move": {
      if (index === -1) return absent;
      if (op.index >= items.length) {
        return { path: op.path, code: "invalid_index", message: `there are ${items.length} steps` };
      }
      const [item] = items.splice(index, 1);
      items.splice(op.index, 0, item);
      return null;
    }
  }
}

function withGrants(
  document: Record<string, unknown>,
  requested: StrategyPatch["requestedGrants"],
): Record<string, unknown> {
  if (!requested) return document;
  const held = (Array.isArray(document.grants) ? document.grants : []) as GrantId[];
  const kept = held.filter((grant) => !requested.remove.includes(grant));
  return { ...document, grants: [...kept, ...requested.add.filter((grant) => !kept.includes(grant))] };
}

/** A contract issue's path in the patch's own terms: a step or a binding by its
 *  id rather than its position in the list. */
function issuePath(path: readonly (string | number)[], document: Record<string, unknown>): string {
  const [root, index] = path;
  const segments = path.map(String);
  if (isKeyedList(root) && typeof index === "number") {
    const item = (document[root] as unknown[] | undefined)?.[index];
    const id = isRecord(item) ? item[KEYED_LISTS[root]] : undefined;
    if (typeof id === "string") segments[1] = id;
  }
  return `/${segments.join("/")}`;
}

/** A step's sends need the campaign's grants for them: a tool the campaign was
 *  never granted is a contradiction, refused with its path rather than left to
 *  resolve Off. */
export function grantIssues(document: CampaignAgentStrategy): PatchIssue[] {
  const granted = new Set<string>(document.grants);
  return (document.steps ?? []).flatMap((step) =>
    step.allowed_tools.flatMap((tool): PatchIssue[] => {
      const grant = CAPABILITIES[tool].grant;
      return grant === null || granted.has(grant)
        ? []
        : [
            {
              path: `/steps/${step.step_id}/allowed_tools`,
              code: "grant_missing",
              message: `${tool} needs ${grant}, which this campaign does not grant — ask for it in requestedGrants or leave the tool out`,
            },
          ];
    }),
  );
}

/** The paths that decide who a campaign reaches, and how far it goes with
 *  them: who is watched and eligible, who is invited and messaged and how
 *  often. A change to one needs a stated scope; a whole binding set at once
 *  counts when it carries an action target or a condition. */
const AUDIENCE_ROOTS = ["/observation", "/eligibility", "/invite", "/dm", "/followup"];

export function touchesAudience(op: PatchOp): boolean {
  if (AUDIENCE_ROOTS.some((root) => under(op.path, root))) return true;
  const [root, id, field] = segmentsOf(op.path);
  if (root !== "action_bindings") return false;
  if (field !== undefined) return field === "target" || field === "condition";
  if (op.op !== "add" && op.op !== "replace") return false;
  const items = id === undefined ? (Array.isArray(op.value) ? op.value : []) : [op.value];
  return items.some((item) => isRecord(item) && ("target" in item || "condition" in item));
}

// ---------------------------------------------------------------------------
// Classification — pure
// ---------------------------------------------------------------------------

/** Why a patch needs the owner's confirmation. Each is a way authority grows. */
export type Widening =
  | {
      kind: "mode_rises";
      actionBindingId: string;
      of: "requested" | "effective";
      from: BindingMode | null;
      to: BindingMode | null;
    }
  | { kind: "ceiling_rises"; actionBindingId: string; from: BindingMode | null; to: BindingMode | null }
  /** An opener to leads of this intent may go out at a higher mode: the
   *  Comment's ceiling for it rises, whatever mode the step holds today. */
  | { kind: "intent_ceiling_rises"; actionBindingId: string; intent: ScoutIntent; from: ActionMode; to: ActionMode }
  | { kind: "new_action_kind"; actionKind: string }
  | { kind: "grant_added"; grant: string }
  | { kind: "group_added"; group: string }
  | { kind: "send_tool_added"; stepId: string; tool: string }
  | { kind: "audience_widens"; path: string }
  | { kind: "barrier_relaxed"; stepId: string }
  | { kind: "entry_widened"; stepId: string }
  | { kind: "budget_rises"; stepId: string; field: string }
  | { kind: "memory_write_added"; slot: string }
  /** Scout's Find posts becomes Find leads: it reads each passing person's
   *  profile, from the account's profile reads. */
  /** The first version of a campaign created on its strategy: landing it
   *  starts the campaign, and its workers wake. */
  | { kind: "campaign_starts" };

/** A document and every action it binds, resolved. */
export type PatchSide = {
  document: CampaignAgentStrategy;
  actions: readonly ResolvedAction[];
};

const ELIGIBILITY = {
  neutral_relevant: ["skip", "review", "eligible"],
  negative: ["skip", "review"],
} as const;

/**
 * Every way `after` lets the campaign do more than `before`, over the resolved
 * values and the policy fields that bound who is reached. Pure. An empty
 * answer is a narrowing or a style change.
 *
 * The REQUESTED mode counts as well as the effective one. An Automatic held at
 * Ask me by a null ceiling is authority waiting for a number: the day the owner
 * sets the ceiling it goes out unattended, and the patch that asked for it is
 * the only moment anyone was shown the diff.
 */
export function patchWidensAuthority(before: PatchSide, after: PatchSide): Widening[] {
  const out: Widening[] = [];
  const was = new Map(before.actions.map((action) => [action.action_binding_id, action]));
  const kinds = new Set(before.actions.map((action) => action.kind));
  for (const action of after.actions) {
    const prior = was.get(action.action_binding_id);
    for (const mode of ["requested", "effective"] as const) {
      if (rankOf(action[mode]) > rankOf(prior?.[mode])) {
        out.push({
          kind: "mode_rises",
          actionBindingId: action.action_binding_id,
          of: mode,
          from: prior?.[mode] ?? null,
          to: action[mode],
        });
      }
    }
    if (prior && rankOf(action.ceiling) > rankOf(prior.ceiling)) {
      out.push({
        kind: "ceiling_rises",
        actionBindingId: action.action_binding_id,
        from: prior.ceiling,
        to: action.ceiling,
      });
    }
    // Like the mode, counted by what is stored: a ceiling raised above a step
    // that holds the opener lower is authority waiting for the step's mode.
    for (const intent of CEILING_INTENTS) {
      const [from, to] = [prior?.intent_ceilings?.[intent] ?? INTENT_CEILING_DEFAULTS[intent], action.intent_ceilings?.[intent]];
      if (to !== undefined && rankOf(to) > rankOf(from)) {
        out.push({ kind: "intent_ceiling_rises", actionBindingId: action.action_binding_id, intent, from, to });
      }
    }
    if (!kinds.has(action.kind)) {
      out.push({ kind: "new_action_kind", actionKind: action.kind });
      kinds.add(action.kind);
    }
  }

  const doc = { before: before.document, after: after.document };
  for (const grant of doc.after.grants) {
    if (!doc.before.grants.includes(grant)) out.push({ kind: "grant_added", grant });
  }
  for (const group of doc.after.capability_groups) {
    if (!doc.before.capability_groups.includes(group)) out.push({ kind: "group_added", group });
  }

  const priorSteps = new Map((doc.before.steps ?? []).map((step) => [step.step_id, step]));
  for (const step of doc.after.steps ?? []) {
    const prior = priorSteps.get(step.step_id);
    for (const tool of step.allowed_tools) {
      if (CAPABILITIES[tool].effect === "send" && !prior?.allowed_tools.includes(tool)) {
        out.push({ kind: "send_tool_added", stepId: step.step_id, tool });
      }
    }
    if (!prior) continue;
    if (barriersRelaxed(prior.barriers, step.barriers)) {
      out.push({ kind: "barrier_relaxed", stepId: step.step_id });
    }
    // What wakes a step decides how often its sends are attempted — a reply
    // step entered on every campaign wake reaches people no reply ever
    // brought. Any move of a sending step's entry is shown and confirmed.
    if (
      prior.entry.event !== step.entry.event &&
      step.allowed_tools.some((tool) => CAPABILITIES[tool].effect === "send")
    ) {
      out.push({ kind: "entry_widened", stepId: step.step_id });
    }
    for (const field of Object.keys(step.budget) as (keyof StrategyStep["budget"])[]) {
      if (step.budget[field] > prior.budget[field]) {
        out.push({ kind: "budget_rises", stepId: step.step_id, field });
      }
    }
  }

  out.push(
    ...audienceWidenings(before, after).map((path): Widening => ({ kind: "audience_widens", path })),
  );
  for (const binding of doc.after.memory_bindings) {
    const held = doc.before.memory_bindings.some(
      (prior) => prior.slot === binding.slot && prior.scope === binding.scope && prior.access === "write",
    );
    if (binding.access === "write" && !held) out.push({ kind: "memory_write_added", slot: binding.slot });
  }
  return out;
}

export function classifyPatch(widenings: readonly Widening[]): "confirm" | "apply" {
  return widenings.length > 0 ? "confirm" : "apply";
}

/**
 * Whether a widening patch only lets Scout read more — every way it widens is
 * a read turned on, or a read's kind new to the campaign — and lets nothing
 * send that could not before: what a card says first (US-LME-12). False for a
 * patch that does not widen. Pure.
 */
export function widensReadsOnly(widenings: readonly Widening[], after: PatchSide): boolean {
  const reads = (action: ResolvedAction | undefined) => action !== undefined && CAPABILITIES[action.capability].effect === "read";
  const byBinding = new Map(after.actions.map((action) => [action.action_binding_id, action]));
  return (
    widenings.length > 0 &&
    widenings.every((widening) =>
      widening.kind === "mode_rises" || widening.kind === "ceiling_rises"
        ? reads(byBinding.get(widening.actionBindingId))
        : widening.kind === "new_action_kind" &&
          after.actions.filter((action) => action.kind === widening.actionKind).every(reads),
    )
  );
}

/** A barrier the step had is gone — or a wait got shorter. A new barrier, or
 *  a longer wait, only narrows. */
function barriersRelaxed(
  before: StrategyStep["barriers"],
  after: StrategyStep["barriers"],
): boolean {
  return before.some((barrier) =>
    barrier.type === "wait"
      ? !after.some((next) => next.type === "wait" && next.hours >= barrier.hours)
      : !after.some((next) => JSON.stringify(next) === JSON.stringify(barrier)),
  );
}

/** The policy paths along which `after` reaches more people, or reaches them
 *  sooner, than `before`. A group that was off has no `before` to compare:
 *  turning it on is its own widening. */
function audienceWidenings(before: PatchSide, after: PatchSide): string[] {
  const out: string[] = [];
  const [a, b] = [before.document, after.document];
  if (!a.observation && b.observation?.source_scopes.includes("room")) {
    out.push("/observation/source_scopes");
  }
  if (a.observation && b.observation) {
    if (b.observation.source_scopes.some((scope) => !a.observation!.source_scopes.includes(scope))) {
      out.push("/observation/source_scopes");
    }
    if (b.observation.replay_lookback_hours > a.observation.replay_lookback_hours) {
      out.push("/observation/replay_lookback_hours");
    }
    if (a.observation.catchup_requires_review && !b.observation.catchup_requires_review) {
      out.push("/observation/catchup_requires_review");
    }
  }
  if (a.eligibility && b.eligibility) {
    for (const field of ["neutral_relevant", "negative"] as const) {
      const ladder: readonly string[] = ELIGIBILITY[field];
      if (ladder.indexOf(b.eligibility[field]) > ladder.indexOf(a.eligibility[field])) {
        out.push(`/eligibility/${field}`);
      }
    }
    if (a.eligibility.exclusion_set_id !== null && b.eligibility.exclusion_set_id !== a.eligibility.exclusion_set_id) {
      out.push("/eligibility/exclusion_set_id");
    }
  }
  if (a.dm && b.dm) {
    if (a.dm.outgoing_acceptance === "wait_for_interest" && b.dm.outgoing_acceptance !== "wait_for_interest") {
      out.push("/dm/outgoing_acceptance");
    }
    if (!a.dm.incoming_linked_opener && b.dm.incoming_linked_opener) out.push("/dm/incoming_linked_opener");
  }
  if (a.followup && b.followup) {
    if (b.followup.max_count > a.followup.max_count) out.push("/followup/max_count");
    if (b.followup.delay_hours < a.followup.delay_hours) out.push("/followup/delay_hours");
  }
  if (a.invite?.note_required && b.invite && !b.invite.note_required) out.push("/invite/note_required");
  const targets = new Map(before.actions.map((action) => [action.action_binding_id, action.target]));
  for (const action of after.actions) {
    const prior = targets.get(action.action_binding_id);
    if (prior !== undefined && prior !== action.target) {
      out.push(`/action_bindings/${action.action_binding_id}/target`);
    }
  }
  const conditions = new Map(
    (a.action_bindings ?? []).map((binding) => [binding.action_binding_id, binding.condition]),
  );
  for (const binding of b.action_bindings ?? []) {
    const prior = conditions.get(binding.action_binding_id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(binding.condition)) {
      out.push(`/action_bindings/${binding.action_binding_id}/condition`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The card — pure
// ---------------------------------------------------------------------------

/** One line of the diff the owner reads: old → new. */
export type PatchRow = CardRow;

/** A step's action, named once where the step is named for its one action
 *  ("Find posts", never "Find posts · Find posts"). */
function actionName(step: string, action: string): string {
  return step === action ? step : `${step} · ${action}`;
}

/** The voice values the owner's own instructions move (`compiler.ts`), said
 *  the way the owner would set them. */
const VOICE_COPY: Readonly<Record<string, { label: string; value: (value: unknown) => string }>> = {
  "voice.casing": {
    label: "Capitalisation",
    value: (value) =>
      value === "sentence" ? "Sentence case" : value === "preserve_user" ? "As you write it" : said(value),
  },
  "voice.capital_i": {
    label: "Capital I",
    value: (value) => (value === true ? "On" : value === false ? "Off" : said(value)),
  },
  "voice.sentence_target": {
    label: "Sentences per draft",
    value: (value) => (value === null || value === undefined ? "Left to the voice" : said(value)),
  },
  "voice.voice_profile_id": {
    label: "Voice",
    value: (value) =>
      value === null || value === undefined
        ? "Your default voice"
        : typeof value === "string" && value.startsWith("voice:")
          ? `Voice #${value.slice("voice:".length)}`
          : said(value),
  },
};

const TARGET_COPY: Readonly<Record<TargetType, string>> = {
  room_comment: "Their comment in the room",
  audience: "The campaign's audience",
  post: "The original post",
  their_reply: "Their reply",
  replied_comment: "The comment they replied to",
  person: "The person",
  invitation: "Their invitation",
  dm_thread: "The DM thread",
  outcome: "The outcome",
};

const CONDITION_COPY: Readonly<Record<NonNullable<ActionBinding["condition"]>["predicate"], string>> = {
  relevant_reply: "the reply is relevant",
  engaged_first: "they engaged first",
  expressed_interest: "they showed interest",
  verified_linked: "it links to a real exchange",
  not_connected: "you're not connected",
};

function conditionWords(condition: ActionBinding["condition"]): string {
  if (!condition) return "Always";
  return `${condition.expect ? "When" : "Unless"} ${CONDITION_COPY[condition.predicate]}`;
}

/** A step's instructions in quotes, or None. */
function quoted(instructions: string): string {
  return instructions ? `“${said(instructions)}”` : "None";
}

/** A document's steps by name, in its order. */
function stepNames(document: CampaignAgentStrategy): string {
  const steps = document.steps ?? [];
  // A room step branches; the stored order is not its path through the canvas.
  const separator = steps.some((step) => step.catalog_step === "meet_the_room") ? " · " : " → ";
  return steps.length > 0 ? steps.map(stepName).join(separator) : "None";
}

/**
 * Every stored value that moved, in the owner's words (`cardWords.ts`):
 * `primary` rows a card always shows, and `secondary` ones — the record
 * behind what the action rows already say — for a card with nothing else to
 * say. A value that is neither is never a row of its own: no path, and no
 * stored object printed whole.
 */
function storedRows(
  changes: StrategyProvenance["changes"],
  before: CampaignAgentStrategy,
  after: CampaignAgentStrategy,
  context: {
    stepLabel: (stepId: string) => string;
    actions: ReadonlyMap<string, ResolvedAction>;
    said: ReadonlySet<string>;
  },
): { primary: PatchRow[]; secondary: PatchRow[] } {
  const primary: PatchRow[] = [];
  const roots = new Set<string>();
  const settings = new Map<string, { stepId: string; field: string }>();
  const aims = new Map<string, { bindingId: string; field: "target" | "condition" }>();
  const openers = new Set<string>();
  let stepList = false;
  const named = (bindingId: string): string => {
    const action = context.actions.get(bindingId);
    return action ? actionName(context.stepLabel(action.step_id), action.label) : "An action";
  };
  for (const change of changes) {
    const [root = "", id, field, ...deeper] = change.path.split(".");
    roots.add(root);
    const voice = VOICE_COPY[change.path];
    if (voice) {
      primary.push({ label: voice.label, before: voice.value(change.old), after: voice.value(change.new) });
    } else if (root === "action_bindings" && id && field === "mode" && deeper.length === 0) {
      // Said once: on the action's own row above, where its effective mode moved.
      if (!context.said.has(id)) {
        primary.push({ label: named(id), before: modeWords(change.old), after: modeWords(change.new) });
      }
    } else if (root === "action_bindings" && id && (field === "target" || field === "condition")) {
      aims.set(`${id}.${field}`, { bindingId: id, field });
    } else if (root === "action_bindings" && id && field === "intent_ceilings") {
      openers.add(id);
    } else if (root === "steps") {
      // A step added, removed or moved changes the list of steps; a setting of
      // one that stays is that setting's row.
      if (!id || !field || change.path === "steps.order") stepList = true;
      else if (field in STEP_SETTINGS) settings.set(`${id}.${field}`, { stepId: id, field });
    }
  }
  if (stepList) {
    const [was, now] = [stepNames(before), stepNames(after)];
    if (was !== now) primary.push({ label: "Steps", before: was, after: now });
  }
  for (const { stepId, field } of settings.values()) {
    const [was, now] = [before, after].map((document) => document.steps?.find((step) => step.step_id === stepId));
    if (!was || !now) continue;
    const setting = STEP_SETTINGS[field]!;
    const bindingLabel = (id: string) => context.actions.get(id)?.label ?? "Read";
    const [from, to] = [setting.say(was, context.stepLabel, bindingLabel), setting.say(now, context.stepLabel, bindingLabel)];
    if (from === to) continue;
    // What Find leads is told reads as the words themselves (US-LME-12).
    primary.push(
      field === "instructions" && now.catalog_step === "find_leads"
        ? { label: `Instructions · ${context.stepLabel(stepId)}`, before: quoted(was.instructions), after: quoted(now.instructions) }
        : { label: `${context.stepLabel(stepId)} · ${setting.label}`, before: from, after: to },
    );
  }
  for (const { bindingId, field } of aims.values()) {
    const [was, now] = [before, after].map((document) =>
      document.action_bindings?.find((binding) => binding.action_binding_id === bindingId),
    );
    if (!was || !now) continue;
    const [from, to] =
      field === "target"
        ? [was, now].map((binding) => (binding.target ? TARGET_COPY[binding.target] : "Inherited"))
        : [conditionWords(was.condition), conditionWords(now.condition)];
    if (from !== to) {
      primary.push({ label: `${named(bindingId)} · ${field === "target" ? "aims at" : "when"}`, before: from!, after: to! });
    }
  }
  for (const bindingId of openers) {
    const ceilings = (document: CampaignAgentStrategy) =>
      intentCeilingsOf(document.action_bindings?.find((binding) => binding.action_binding_id === bindingId)?.intent_ceilings);
    const [was, now] = [ceilings(before), ceilings(after)];
    for (const intent of CEILING_INTENTS) {
      if (was[intent] === now[intent]) continue;
      primary.push({
        label: `${named(bindingId)} · Opener to ${INTENT_LABELS[intent]}`,
        before: modeWords(was[intent]),
        after: modeWords(now[intent]),
      });
    }
  }
  const policy = policyRows(before, after, roots);
  return {
    primary: [...primary, ...policy.primary],
    secondary: [
      ...policy.secondary,
      ...(roots.has("presentation") ? [{ label: "Canvas layout", before: "As it was", after: "Rearranged" }] : []),
    ],
  };
}

/** What a card needs to say a campaign's search depth where a patch moves
 *  Find leads' Company page read: the Quick or Standard stored either side of
 *  it, and the account's profile reads a day that read spends from. */
export type DepthRowContext = {
  stored: { before: StoredSearchDepth; after: StoredSearchDepth };
  profileReadsPerDay: number;
};

/** The depth a Find leads campaign reads either side of a patch, as rows: the
 *  move, and what Deep adds to the reads. None where the depth stays, or
 *  neither side finds leads. */
function depthRows(before: PatchSide, after: PatchSide, depth: DepthRowContext): PatchRow[] {
  if (!holdsStep(before.document, "find_leads") && !holdsStep(after.document, "find_leads")) return [];
  const from = searchDepthOf(depth.stored.before, readsDeep(before.document, before.actions));
  const to = searchDepthOf(depth.stored.after, readsDeep(after.document, after.actions));
  if (from === to) return [];
  return [
    { label: "Search depth", before: SEARCH_DEPTH_LABELS[from], after: SEARCH_DEPTH_LABELS[to] },
    ...(to === "deep"
      ? [
          {
            label: "Reads",
            before: "A profile read for each lead",
            after: `Adds a company page read for each lead, from the same ${depth.profileReadsPerDay} profile reads a day.`,
          },
        ]
      : []),
  ];
}

/** The diff: every bound action whose effective value moved, by its catalog
 *  label on its step, then every stored value that moved, in the owner's
 *  words. A change only to the record behind them says so in one line, so a
 *  card never stands empty and never prints what is stored. With `depth`, the
 *  Company page read that is Find leads' Deep is said as the search depth it
 *  moves. */
export function patchRows(before: PatchSide, after: PatchSide, depth?: DepthRowContext): PatchRow[] {
  const labels = new Map(
    [...(before.document.steps ?? []), ...(after.document.steps ?? [])].map((step) => [step.step_id, stepName(step)]),
  );
  const stepLabel = (stepId: string) => labels.get(stepId) ?? stepId;
  const was = new Map(before.actions.map((action) => [action.action_binding_id, action]));
  const now = new Map(after.actions.map((action) => [action.action_binding_id, action]));
  const rows: PatchRow[] = [];
  const said = new Set<string>();
  for (const id of new Set([...now.keys(), ...was.keys()])) {
    const [old, next] = [was.get(id), now.get(id)];
    const [from, to] = [describeAction(old), describeAction(next)];
    if (from === to) continue;
    const action = (next ?? old)!;
    said.add(id);
    if (depth && action.capability === "read_company") continue;
    rows.push({ label: actionName(stepLabel(action.step_id), action.label), before: from, after: to });
  }
  if (depth) rows.push(...depthRows(before, after, depth));
  const changes = strategyChanges(before.document, after.document);
  const stored = storedRows(changes, before.document, after.document, {
    stepLabel,
    actions: new Map([...was, ...now]),
    said,
  });
  rows.push(...stored.primary);
  if (rows.length > 0 || changes.length === 0) return rows;
  return stored.secondary.length > 0
    ? stored.secondary
    : [{ label: "Advanced settings", before: "As they were", after: "Changed" }];
}

/**
 * Every stored value that differs, by path (`flip.ts`'s `documentChanges`) —
 * and the order of the strategy's steps, which that walk cannot see: it reads
 * steps by id, so a reorder alone would otherwise be a patch that changed
 * nothing. Pure.
 */
export function strategyChanges(
  before: Record<string, unknown> | CampaignAgentStrategy,
  after: Record<string, unknown> | CampaignAgentStrategy,
): StrategyProvenance["changes"] {
  const changes = documentChanges(before as Record<string, unknown>, after as Record<string, unknown>);
  const [was, now] = [stepIdsOf(before), stepIdsOf(after)];
  const kept = (ids: string[], other: string[]) => ids.filter((id) => other.includes(id)).join(",");
  return kept(was, now) === kept(now, was)
    ? changes
    : [...changes, { path: "steps.order", old: was, new: now }];
}

// ---------------------------------------------------------------------------
// Reading, preparing, applying
// ---------------------------------------------------------------------------

/** Everything a patch is checked against, read once. */
export type PatchState = {
  campaign: { id: number; name: string; searchDepth: StoredSearchDepth };
  versions: CampaignStrategyRow[];
  /** The version patches are written against: the one in force — or, on a
   *  campaign not started yet, the draft its design starts from. */
  active: CampaignStrategyRow;
  base: CampaignAgentStrategy;
  /** Created on its strategy and never activated: Paused, with only its
   *  draft. The patch that lands on it is the campaign's Start
   *  (`applyStrategyPatch`). */
  notStarted: boolean;
  network: NetworkCatalog;
  /** The account the campaign lives on (INV-34), as the join reads it. */
  channel: Pick<Channel, "id" | "network" | "displayName" | "dailyProfileReadCap"> & {
    connector: Channel["connector"] | null;
  };
  accountDefault: { version: number; document: CampaignAgentStrategy } | null;
  /** The first sends and live checks recorded on the account; absent,
   *  none. */
  liveChecks?: LiveChecks;
};

/**
 * The campaign's versions, the one patches are written against parsed, its
 * channel and network, and the account default it inherits from. `lock` takes
 * the campaign row first — the lock activation takes — so two patches landing
 * on one campaign serialize and the compare-and-swap is never raced.
 */
export async function readPatchState(
  tx: Tx,
  campaignId: number,
  options: { lock: boolean },
): Promise<PatchState> {
  if (options.lock) {
    await tx.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.id, campaignId)).for("update");
  }
  const [campaign] = await tx
    .select({
      id: campaigns.id,
      name: campaigns.name,
      searchDepth: campaigns.searchDepth,
      channelId: campaigns.channelId,
      network: channels.network,
      connector: channels.connector,
      displayName: channels.displayName,
      dailyProfileReadCap: channels.dailyProfileReadCap,
    })
    .from(campaigns)
    .leftJoin(channels, eq(channels.id, campaigns.channelId))
    // A deleted campaign takes no further version: deleting it is final.
    .where(and(eq(campaigns.id, campaignId), isNull(campaigns.deletedAt)));
  if (!campaign) {
    throw new StrategyPatchError(
      "campaign_not_found",
      `campaign ${campaignId} not found`,
      "Call list_campaigns and retry with an id from this organization.",
    );
  }
  const versions = await tx
    .select()
    .from(campaignStrategies)
    .where(eq(campaignStrategies.campaignId, campaignId));
  const notStarted = !versions.some((version) => version.status === "active");
  // Before its first start a campaign has only drafts, and its newest is the
  // design in hand; a channel-less seed is a draft too, refused below.
  const active = notStarted
    ? versions
        .filter((version) => version.status === "draft")
        .sort((a, b) => b.version - a.version)[0]
    : versions.find((version) => version.status === "active");
  if (!active || !campaign.network || campaign.channelId === null) {
    throw new StrategyPatchError(
      "strategy_not_activatable",
      "This campaign has no active strategy on a channel, so there is nothing to patch.",
      "A campaign is bound to its channel when one exists; connect the account first.",
    );
  }
  const network = NETWORK_CATALOGS[campaign.network];
  const parsed = parseStrategy(active.document, { network });
  if (!parsed.success) {
    throw invalidPatch(
      parsed.error.issues.map((issue) => ({
        path: issuePath(issue.path, active.document),
        code: strategyIssueCode(issue),
        message: `the active version: ${issue.message}`,
      })),
    );
  }
  return {
    campaign: {
      id: campaign.id,
      name: campaign.name,
      searchDepth: campaign.searchDepth,
    },
    versions,
    active,
    base: parsed.data,
    notStarted,
    network,
    channel: {
      id: campaign.channelId,
      network: campaign.network,
      connector: campaign.connector,
      displayName: campaign.displayName,
      dailyProfileReadCap: campaign.dailyProfileReadCap ?? 0,
    },
    accountDefault: await readAccountDefault(tx, campaign.channelId, { network }),
    liveChecks: await recordedLiveChecks(tx, campaign.channelId),
  };
}

/**
 * What a competing edit did, and what this patch would do now: the conflict's
 * fresh diff. Null while the patch's base is still the active version.
 */
export function conflictWith(state: PatchState, patch: StrategyPatch): Record<string, unknown> | null {
  if (state.active.version === patch.expectedBaseVersion) return null;
  const expected = state.versions.find((version) => version.version === patch.expectedBaseVersion);
  const rebased =
    patch.undoVersion === undefined ? applyPatchOps(state.base, patch.ops) : null;
  return {
    expectedBaseVersion: patch.expectedBaseVersion,
    activeVersion: state.active.version,
    changedSince: expected
      ? strategyChanges(currentDocument(expected.document), currentDocument(state.active.document))
      : null,
    ...(rebased === null
      ? {}
      : rebased.ok
        ? {
            wouldChange: strategyChanges(
              currentDocument(state.active.document),
              withGrants(rebased.document, patch.requestedGrants),
            ),
          }
        : { wouldNotApply: rebased.issues }),
  };
}

function conflictError(details: Record<string, unknown>): StrategyPatchError {
  return new StrategyPatchError(
    "strategy_conflict",
    `This patch was written against version ${String(details.expectedBaseVersion)}, and version ${String(details.activeVersion)} replaced it, so nothing was written.`,
    "Read `changedSince` (what the other edit did) and `wouldChange` (what this one would do now), then send it again with expectedBaseVersion set to the active version if it still says what the owner asked.",
    details,
  );
}

export type PreparedPatch = {
  state: PatchState;
  /** The new version's number and its stamped, validated document. */
  version: number;
  document: CampaignAgentStrategy;
  effectiveAt: number;
  level: "confirm" | "apply";
  widenings: Widening[];
  /** Every widening is a read turned on (`widensReadsOnly`). */
  readsOnly: boolean;
  changes: StrategyProvenance["changes"];
  title: string;
  rows: PatchRow[];
  /** The versions not yet in force that an undo cancels. */
  cancels: CampaignStrategyRow[];
};

/**
 * Validate a patch against the version in force and say what it would be.
 * Writes nothing. Refuses — with the path, the code and nothing written —
 * every patch that is stale, outside its intent or scope, ambiguous about who
 * it reaches, or that would not make a valid strategy.
 */
export async function preparePatch(
  tx: Tx,
  patch: StrategyPatch,
  options: { now: number; lock: boolean } & NotStartedLanding & Pick<DepthLanding, "searchDepth">,
): Promise<PreparedPatch> {
  const prepared = preparePatchOn(await readPatchState(tx, patch.campaignId, options), patch, options.now, options);
  await refuseStepVoice(tx, patch.campaignId, prepared.state.base, prepared.document);
  return prepared;
}

/**
 * How a patch lands on a campaign NOT STARTED yet. By default it is the
 * Start: whatever it changes, its yes activates the campaign. `draft` keeps
 * it a draft instead — the workspace's own edits, which build a strategy step
 * by step before anything wakes — and then nothing it says is in force, so it
 * applies without a card and the Start that follows confirms all of it. On a
 * campaign that has started, `draft` changes nothing.
 */
export type NotStartedLanding = { draft?: boolean };

/**
 * What a landing does to the campaign's search depth (`settleSearchDepth`).
 * Every landing tells a change to the depth the campaign reads, whatever moved
 * it. `searchDepth` is the Quick or Standard a depth's own patch stores beside
 * the Research it says, written with it so the change is told once.
 * `reportedDepth` is a depth its create already told, which the create's own
 * Research is not told again.
 */
export type DepthLanding = { searchDepth?: StoredSearchDepth; reportedDepth?: SearchDepth };

/** `preparePatch` over state already read. Pure: no I/O, and `now` is the only
 *  clock it reads. */
export function preparePatchOn(
  state: PatchState,
  patch: StrategyPatch,
  now: number,
  landing: NotStartedLanding & Pick<DepthLanding, "searchDepth"> = {},
): PreparedPatch {
  const conflict = conflictWith(state, patch);
  if (conflict) throw conflictError(conflict);
  const drafting = state.notStarted && landing.draft === true;
  // An empty patch on a campaign not started is its Start, as its draft
  // stands: there is nothing to change, only a yes to give.
  const startsDraft =
    state.notStarted &&
    !drafting &&
    patch.undoVersion === undefined &&
    patch.ops.length === 0 &&
    !patch.requestedGrants;
  if (startsDraft && (state.base.steps ?? []).length === 0) {
    throw invalidPatch([
      {
        path: "/steps",
        code: "empty_patch",
        message: "a campaign with no steps has nothing to start: add a step or design it first",
      },
    ]);
  }
  if (state.notStarted && patch.undoVersion !== undefined) {
    throw new StrategyPatchError(
      "not_undoable",
      "This campaign has not started, so no version of it has taken effect to undo.",
      "Propose the design again with patch_strategy; until the owner starts it, nothing runs.",
    );
  }
  if (state.notStarted && patch.effectiveAt) {
    throw invalidPatch([
      { path: "/", code: "not_patchable", message: "the patch that starts a campaign takes effect when the owner starts it, not at an instant" },
    ]);
  }

  let edited: Record<string, unknown>;
  let cancels: CampaignStrategyRow[] = [];
  if (patch.undoVersion !== undefined) {
    if (patch.ops.length > 0 || patch.requestedGrants || patch.effectiveAt) {
      throw invalidPatch([
        { path: "/", code: "not_patchable", message: "an undo carries no ops, grants or effectiveAt: it takes effect now" },
      ]);
    }
    ({ document: edited, cancels } = undoTarget(state, patch.undoVersion));
    // A version from before migration 0339 may carry the campaign's retired
    // cap. It is read by nothing, so it is not put back; what its steps say
    // is classified against the version in force like any change.
    delete edited.max_mode;
  } else {
    if (patch.ops.length === 0 && !patch.requestedGrants && !startsDraft) {
      throw invalidPatch([{ path: "/", code: "empty_patch", message: "a patch carries at least one op" }]);
    }
    const issues = patch.ops.flatMap((op) => pathIssue(op, state.base, patch) ?? []);
    if (patch.requestedGrants && (patch.requestedGrants.add.length > 0 || patch.requestedGrants.remove.length > 0)) {
      if (!patch.provenance.recognizedIntent.paths.some((path) => under("/grants", path))) {
        issues.push({ path: "/grants", code: "outside_intent", message: "the recognized intent does not name /grants" });
      } else if (patch.provenance.scope?.stepId) {
        issues.push({ path: "/grants", code: "outside_scope", message: "grants are the campaign's, not one step's" });
      }
    }
    if (issues.length > 0) throw invalidPatch(issues);
    if (patch.provenance.scope === null && patch.ops.some(touchesAudience)) {
      throw new StrategyPatchError(
        "clarify",
        "This changes who the campaign reaches, and the instruction did not say how far it applies.",
        "Ask the owner whether it is for this whole campaign or one step, then send it again with provenance.scope set.",
        { paths: patch.ops.filter(touchesAudience).map((op) => op.path) },
      );
    }
    const applied = applyPatchOps(state.base, patch.ops);
    if (!applied.ok) throw invalidPatch(applied.issues);
    edited = withGrants(applied.document, patch.requestedGrants);
  }

  const effectiveAt = Math.max(patch.effectiveAt ? Date.parse(patch.effectiveAt) : now, now);
  const version = Math.max(...state.versions.map((row) => row.version)) + 1;
  const stamped = {
    ...edited,
    schema_version: state.base.schema_version,
    campaign_id: state.base.campaign_id,
    version,
    previous_version: state.active.version,
    effective_at: new Date(effectiveAt).toISOString(),
  };
  const parsed = parseStrategy(stamped, { network: state.network });
  if (!parsed.success) {
    throw invalidPatch(
      parsed.error.issues.map((issue) => ({
        path: issuePath(issue.path, stamped),
        code: strategyIssueCode(issue),
        message: issue.message,
      })),
    );
  }
  const grants = grantIssues(parsed.data);
  if (grants.length > 0) throw invalidPatch(grants);
  // An undo puts back what a version said, starts and all; any other change
  // moves a step only onto a start its catalog step takes.
  if (patch.undoVersion === undefined) {
    const entries = entryChangeIssues(state.base, parsed.data);
    if (entries.length > 0) {
      throw invalidPatch(
        entries.map(({ stepId, code, message }) => ({ path: `/steps/${stepId}/entry`, code, message })),
      );
    }
  }

  const changes = strategyChanges(currentDocument(state.active.document), parsed.data);
  if (changes.length === 0 && patch.undoVersion === undefined && !startsDraft) {
    throw new StrategyPatchError(
      "proposal_is_a_no_op",
      "this change would move nothing",
      "Nothing was written. The active version already says this; tell the owner so, or propose a value that differs from it.",
    );
  }
  const resolve = (document: CampaignAgentStrategy): PatchSide => ({
    document,
    actions: resolveStrategy({
      accountDefault: state.accountDefault?.document ?? null,
      campaign: document,
      network: state.network,
      connector: null,
      liveChecks: state.liveChecks,
    }),
  });
  const starts = state.notStarted && !drafting;
  // Nothing of a campaign not started is in force, so what its Start wakes is
  // measured from nothing — every action its draft holds — while an edit to
  // its draft is measured from the draft.
  const before = resolve(starts ? { ...state.base, steps: [], action_bindings: [] } : state.base);
  const after = resolve(parsed.data);
  // Whatever it changes, a patch that lands on a campaign not started yet —
  // other than on its draft — starts it, so it is never less than a widening
  // the owner confirms.
  const widenings: Widening[] = [
    ...(starts ? [{ kind: "campaign_starts" } as const] : []),
    ...patchWidensAuthority(before, after),
  ];
  return {
    state,
    version,
    document: parsed.data,
    effectiveAt,
    // An edit to a draft is in force nowhere; the Start confirms all of it.
    level: drafting ? "apply" : classifyPatch(widenings),
    widenings,
    readsOnly: widensReadsOnly(widenings, after),
    changes,
    title: starts
      ? `Start ${state.campaign.name}`
      : drafting
        ? `Change the draft of ${state.campaign.name}`
        : patch.undoVersion === undefined
          ? `Change what ${state.campaign.name} does`
          : `Undo version ${patch.undoVersion} of ${state.campaign.name}`,
    rows: [
      ...(starts ? [{ label: "Campaign", before: "Paused · not started", after: "Active" }] : []),
      ...(patch.undoVersion === undefined ? [] : undoRows(state, patch.undoVersion, cancels)),
      ...(patch.effectiveAt ? [{ label: "Takes effect", before: "now", after: patch.effectiveAt }] : []),
      ...patchRows(before, after, {
        stored: { before: state.campaign.searchDepth, after: landing.searchDepth ?? state.campaign.searchDepth },
        profileReadsPerDay: state.channel.dailyProfileReadCap,
      }),
    ],
    cancels,
  };
}

/**
 * What an undo restores. The active version gives way to the one it replaced;
 * a version not yet in force simply never takes effect, so the document stays
 * the active one's. Either way every version waiting to take effect is
 * cancelled — each was written against a base the undo replaces, so each would
 * only conflict. History — an archived or cancelled version — is never
 * undone: a change back from there is a new patch.
 */
function undoTarget(
  state: PatchState,
  undoVersion: number,
): { document: Record<string, unknown>; cancels: CampaignStrategyRow[] } {
  const target = state.versions.find((row) => row.version === undoVersion);
  const pending = state.versions.filter((row) => row.status === "draft" || row.status === "pending_review");
  if (target?.status === "active") {
    const prior = state.versions.find((row) => row.version === target.baseVersion);
    if (!prior) {
      throw new StrategyPatchError(
        "not_undoable",
        `Version ${undoVersion} is this campaign's first, so there is nothing before it to restore.`,
        "Change it forward with patch_strategy instead.",
      );
    }
    return { document: structuredClone(currentDocument(prior.document)), cancels: pending };
  }
  if (target?.status === "draft" || target?.status === "pending_review") {
    return { document: structuredClone(currentDocument(state.active.document)), cancels: pending };
  }
  throw new StrategyPatchError(
    "not_undoable",
    target
      ? `Version ${undoVersion} is ${target.status}: history, which is never rewritten.`
      : `This campaign has no version ${undoVersion}.`,
    "Undo applies to the active version or one not yet in force; read them with get_campaign. A change back from further is a new patch.",
  );
}

function undoRows(state: PatchState, undoVersion: number, cancels: readonly CampaignStrategyRow[]): PatchRow[] {
  const target = state.versions.find((row) => row.version === undoVersion)!;
  return [
    {
      label: "Undo",
      before: `version ${state.active.version} in force`,
      after:
        target.status === "active"
          ? `version ${target.baseVersion} restored`
          : `version ${undoVersion} never takes effect`,
    },
    ...cancels.map((row) => ({
      label: `Version ${row.version}`,
      before: row.status === "draft" ? "scheduled" : "waiting for review",
      after: "cancelled",
    })),
  ];
}

/** The drafts waiting for a yes or scheduled to go out on this campaign: the
 *  approvals that reference the version a patch replaces. */
async function approvalsUnder(tx: Tx, campaignId: number): Promise<number[]> {
  const rows = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.campaignId, campaignId), inArray(messages.status, ["proposed", "approved"])))
    .orderBy(messages.id);
  return rows.map((row) => row.id);
}

export type PatchApplied = {
  campaignId: number;
  version: number;
  baseVersion: number;
  level: "confirm" | "apply";
  /** `draft` for a version written to a campaign not started, which nothing
   *  activates until its Start. */
  activation: ActivationOutcome | { status: "draft"; version: number };
  changes: StrategyProvenance["changes"];
  cancelled: number[];
  /** The campaign was not started, and this patch started it. */
  started: boolean;
};

/**
 * Land a patch: validate it again under the campaign's lock, write its version
 * with its provenance, and hand it to activation — now, or at its instant.
 * The only writer of a patched version; projections are activation's.
 *
 * On a campaign created on its strategy and not started yet, landing a
 * patch IS the Start: the draft it was designed from is archived, the new
 * version activates, and the campaign turns Active through its one status
 * writer — whose wake projection then arms the workers its steps hired — all
 * in the caller's one transaction. Nothing else ever starts one, so a
 * campaign designed in chat sits Paused with its draft until the owner's yes.
 *
 * Unless it lands as `draft` (`NotStartedLanding`): then it is the campaign's
 * new draft, the one it was drawn from is archived, and nothing activates —
 * no projection, no worker, no wake — until a Start.
 *
 * Either way its effect on the campaign's search depth is settled last
 * (`DepthLanding`): the depth it reads before the landing, under the lock,
 * against the one it reads after.
 */
export async function applyStrategyPatch(
  tx: Tx,
  patch: StrategyPatch,
  options: { approver: string | null; now: number } & NotStartedLanding & DepthLanding,
): Promise<PatchApplied> {
  const prepared = await preparePatch(tx, patch, {
    now: options.now,
    lock: true,
    draft: options.draft,
    searchDepth: options.searchDepth,
  });
  const { active, notStarted } = prepared.state;
  const drafting = notStarted && options.draft === true;
  const depthBefore = options.reportedDepth ?? (await currentSearchDepth(tx, patch.campaignId));
  const settleDepth = async () => {
    if (options.searchDepth) {
      await tx
        .update(campaigns)
        .set({ searchDepth: options.searchDepth, updatedAt: options.now })
        .where(eq(campaigns.id, patch.campaignId));
    }
    await settleSearchDepth(tx, patch.campaignId, depthBefore, depthActor(options.approver));
  };
  if (prepared.cancels.length > 0) {
    await tx
      .update(campaignStrategies)
      .set({ status: "cancelled" })
      .where(inArray(campaignStrategies.id, prepared.cancels.map((row) => row.id)));
  }
  await tx.insert(campaignStrategies).values({
    campaignId: patch.campaignId,
    channelId: null,
    version: prepared.version,
    status: "draft",
    baseVersion: active.version,
    document: prepared.document,
    patchProvenance: {
      source: patch.undoVersion === undefined ? "patch" : "undo",
      instruction: patch.provenance.instruction,
      intent: patch.provenance.recognizedIntent.summary,
      intentPaths: patch.provenance.recognizedIntent.paths,
      scope: { campaignId: patch.campaignId, stepId: patch.provenance.scope?.stepId ?? null },
      changes: prepared.changes,
      compilerVersion: patch.provenance.compilerVersion,
      approver: options.approver,
      dependencyVersions: patch.dependencyVersions,
      ...(patch.requestedGrants ? { requestedGrants: patch.requestedGrants } : {}),
      ...(patch.undoVersion === undefined
        ? {}
        : { undoes: patch.undoVersion, cancelled: prepared.cancels.map((row) => row.version) }),
      approvals: { baseVersion: active.version, messageIds: await approvalsUnder(tx, patch.campaignId) },
    },
    effectiveAt: prepared.effectiveAt,
    createdAt: options.now,
  });
  if (drafting) {
    // The draft it was drawn from is replaced, and never takes effect.
    await tx
      .update(campaignStrategies)
      .set({ status: "archived" })
      .where(eq(campaignStrategies.id, active.id));
    await settleDepth();
    return {
      campaignId: patch.campaignId,
      version: prepared.version,
      baseVersion: active.version,
      level: prepared.level,
      activation: { status: "draft", version: prepared.version },
      changes: prepared.changes,
      cancelled: [],
      started: false,
    };
  }
  const activation = await activateStrategy(
    tx,
    { campaignId: patch.campaignId, version: prepared.version },
    options.now,
  );
  if (notStarted) {
    // The draft it was designed from never took effect, and now never will.
    await tx
      .update(campaignStrategies)
      .set({ status: "archived" })
      .where(eq(campaignStrategies.id, active.id));
    await setCampaignStatusOp(tx, patch.campaignId, "active", options.now);
  }
  await settleDepth();
  // A version that conflicted never took effect, so it switched nothing.
  return {
    campaignId: patch.campaignId,
    version: prepared.version,
    baseVersion: active.version,
    level: prepared.level,
    activation,
    changes: prepared.changes,
    cancelled: prepared.cancels.map((row) => row.version),
    started: notStarted,
  };
}

/** The Start of a campaign not started: no ops against its draft, which the
 *  owner's yes activates as it stands. */
export function startPatchFor(campaignId: number, draftVersion: number, instruction: string): StrategyPatch {
  return {
    kind: STRATEGY_PATCH,
    campaignId,
    expectedBaseVersion: draftVersion,
    ops: [],
    dependencyVersions: { voice: null, knowledge: null, memory: null },
    provenance: {
      instruction,
      recognizedIntent: { summary: "Start the campaign as drafted", paths: [] },
      scope: { stepId: null },
      compilerVersion: START_COMPILER_VERSION,
    },
  };
}

/** The patch an undo of one version is: no ops, the active version as its
 *  base, and the server's own provenance beside the owner's words. */
export async function undoPatchFor(
  tx: Tx,
  campaignId: number,
  version: number,
  instruction: string,
): Promise<StrategyPatch> {
  const state = await readPatchState(tx, campaignId, { lock: false });
  return {
    kind: STRATEGY_PATCH,
    campaignId,
    expectedBaseVersion: state.active.version,
    ops: [],
    undoVersion: version,
    dependencyVersions: { voice: null, knowledge: null, memory: null },
    provenance: {
      instruction,
      recognizedIntent: { summary: `Undo version ${version}`, paths: [] },
      scope: { stepId: null },
      compilerVersion: UNDO_COMPILER_VERSION,
    },
  };
}
