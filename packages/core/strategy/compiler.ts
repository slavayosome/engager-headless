import { z } from "zod";
import { AppError } from "@engager/common/errors";
import {
  ACTION_MODES,
  MODE_KEYS,
  networkActionFor,
  stepName,
  type ActionMode,
  type ModeKey,
  type NetworkCatalog,
} from "./catalog";
import type { CampaignAgentStrategy } from "./contract";
import { STRATEGY_PATCH, type StrategyPatch, type PatchOp } from "./patch";

/**
 * THE INSTRUCTION COMPILER — the owner's words in chat ("not all lowercase",
 * "only message people who show interest", "at the reply step, keep it
 * shorter") made into a `strategy.patch` (spec §09, R03).
 *
 * The owner's model contributes exactly ONE thing: a recognized instruction
 * against the closed schema below — a known intent, its typed arguments, and
 * whether the scope was ambiguous. In chat that is the model's own tool
 * argument (`patch_strategy`): the owner's agent is already the one
 * talking, and the broker runs no second inference inside its turn.
 * `parseRecognition` holds it to the schema. Everything after is deterministic
 * and pure: `compileInstruction` maps the intent, at the scope it is said at,
 * onto the document's own paths. An instruction whose intent is unknown
 * compiles to nothing, and the turn says so.
 *
 * THE WORDS ARE DATA. A post pasted into the instruction can change nothing the
 * recognized intent does not name: the ops come from the intent's enumerated
 * arguments, the recognized intent's paths are exactly those ops' paths, and
 * `preparePatch` refuses any op outside them. The instruction itself is
 * recorded on the version's provenance and never stored as policy.
 */

export const INSTRUCTION_COMPILER_VERSION = "instruction-compiler/1";

const stepId = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/, "a step id from get_campaign");

/** One known intent: its literal name, its arguments, and whether the owner
 *  left unclear what it applies to. */
const intent = <N extends string, A extends z.ZodRawShape>(name: N, args: A, describe: string) =>
  z
    .object({
      intent: z.literal(name),
      args: z.object(args).strict(),
      ambiguous_scope: z.boolean(),
    })
    .strict()
    .describe(describe);

export const RECOGNIZED_INSTRUCTION = z.discriminatedUnion("intent", [
  intent("voice.casing", {}, "Not all lowercase: ordinary sentence caps and a capital I."),
  intent(
    "eligibility.neutral_relevant",
    { value: z.enum(["eligible", "review", "skip"]) },
    "What happens to a relevant reply that is neither positive nor negative.",
  ),
  intent(
    "cta.after_relevant_exchanges",
    {
      exchanges: z.number().int().min(1).max(5),
      sentence_target: z.number().int().min(1).max(8).nullable(),
    },
    "Get to the point: ask whether they want to try it after N relevant exchanges.",
  ),
  intent(
    "dm.outgoing_acceptance",
    { value: z.enum(["wait_for_interest", "contextual_opener"]) },
    "What an accepted outgoing invitation allows before they show interest.",
  ),
  intent(
    "person.exclude",
    { profile_id: z.string().trim().min(1).max(200) },
    "Stop contacting this person, by the profile id the owner means.",
  ),
  intent(
    "step.instructions.edit",
    { step_id: stepId, instructions: z.string().max(4000) },
    "Rewrite one step's instructions; `instructions` is the whole new text.",
  ),
  intent(
    "action.mode",
    { action: z.enum(MODE_KEYS), mode: z.enum(ACTION_MODES) },
    "Set one send to off, review (Ask me) or auto (Automatic).",
  ),
  intent("unknown", {}, "None of these."),
]);
export type RecognizedInstruction = z.infer<typeof RECOGNIZED_INSTRUCTION>;
export type InstructionIntent = RecognizedInstruction["intent"];

export const INSTRUCTION_INTENTS = RECOGNIZED_INSTRUCTION.options.map(
  (option) => option.shape.intent.value,
) as [InstructionIntent, ...InstructionIntent[]];

/** Not one of the known changes, or not with these arguments. */
export class UnrecognizedInstructionError extends AppError {
  readonly recovery: string;

  constructor(issues: z.ZodIssue[]) {
    super("instruction_unrecognized", "that is not one of the known changes with its arguments", 400);
    this.recovery = `Nothing was proposed. ${issues
      .map((issue) => `${issue.path.join(".") || "recognized"}: ${issue.message}`)
      .join("; ")}. Send one intent with exactly its arguments, or intent unknown.`;
  }
}

/** The closed schema's reading of a recognition — the one thing the owner's
 *  model contributes. */
export function parseRecognition(value: unknown): RecognizedInstruction {
  const parsed = RECOGNIZED_INSTRUCTION.safeParse(value);
  if (!parsed.success) throw new UnrecognizedInstructionError(parsed.error.issues);
  return parsed.data;
}

/** What a correction is said about (R04): one reply, one step, the campaign,
 *  or every conversation on the account. */
export const SCOPE_LEVELS = ["message", "step", "campaign", "account"] as const;
export type ScopeLevel = (typeof SCOPE_LEVELS)[number];
export type InstructionScope =
  | { level: "message" | "campaign" | "account" }
  | { level: "step"; stepId: string };

/** The owner-facing name of each scope, which is also the answer they click. */
export const SCOPE_LABELS: Record<ScopeLevel, string> = {
  message: "This reply only",
  step: "This step",
  campaign: "This campaign",
  account: "All conversations",
};

/** The scopes each intent compiles to ops at. What the owner may also mean
 *  that this campaign's strategy cannot hold is answered, not compiled. */
const SCOPES: Record<InstructionIntent, readonly ScopeLevel[]> = {
  "voice.casing": ["campaign"],
  "eligibility.neutral_relevant": ["campaign"],
  "cta.after_relevant_exchanges": ["campaign"],
  "dm.outgoing_acceptance": ["campaign"],
  "person.exclude": ["account"],
  "step.instructions.edit": ["step"],
  "action.mode": ["campaign", "step"],
  unknown: [],
};

/**
 * What to ask when an intent's scope is unclear, or unstated — an instruction
 * that names no scope asks rather than guessing (R04, R09). A correction to
 * how drafts sound or how replies are handled could mean this reply only, this
 * campaign or all conversations; a send's mode, this step or the campaign.
 * Only answers the intent can be said at are offered. Empty for the two
 * intents whose own argument is their scope: the person excluded is the
 * account's, and an instruction edit names its step.
 */
const ASK: Record<InstructionIntent, readonly ScopeLevel[]> = {
  "voice.casing": ["message", "campaign", "account"],
  "eligibility.neutral_relevant": ["message", "campaign", "account"],
  "cta.after_relevant_exchanges": ["message", "campaign", "account"],
  "dm.outgoing_acceptance": ["message", "campaign", "account"],
  "person.exclude": [],
  "step.instructions.edit": [],
  "action.mode": ["step", "campaign"],
  unknown: [],
};

/** Why a campaign-scoped intent is not compiled at the account's scope: the
 *  account-wide change is a separate choice on its own page. */
const ACCOUNT_ELSEWHERE: Partial<Record<InstructionIntent, string>> = {
  "voice.casing": "How you sound everywhere is your voice, changed on Voice — a separate choice from this campaign's.",
};
const ACCOUNT_POLICY =
  "What every conversation on the account allows is the account's own policy, set on Channels → LinkedIn — a separate choice from this campaign's.";

/** A change to one reply is an edit to that draft, never the campaign's
 *  policy (R04: one message is not evidence of a durable preference). */
const NOT_POLICY =
  "A change to this reply only is an edit to that draft, not to the campaign — edit the draft itself.";

export type ScopeOption = { label: string; scope: InstructionScope };

export type CompiledInstruction =
  | {
      kind: "ops";
      intent: InstructionIntent;
      ops: PatchOp[];
      /** The recognized intent's paths: exactly the paths the ops write. */
      paths: string[];
      stepId: string | null;
      summary: string;
    }
  /** "Stop contacting this person": the account's do-not-engage list, which
   *  is not a strategy path (`do_not_engage.add`). */
  | { kind: "exclusion"; profileId: string; summary: string }
  | { kind: "clarify"; question: string; options: ScopeOption[] }
  | { kind: "nothing"; reason: string };

const nothing = (reason: string): CompiledInstruction => ({ kind: "nothing", reason });

/** The answers an intent's scope question offers: its `ASK` levels, this
 *  step only when the conversation is about one. */
function askable(name: InstructionIntent, stepInScope: string | null): ScopeOption[] {
  return ASK[name].flatMap((level): ScopeOption[] =>
    level === "step"
      ? stepInScope
        ? [{ label: SCOPE_LABELS.step, scope: { level, stepId: stepInScope } }]
        : []
      : [{ label: SCOPE_LABELS[level], scope: { level } }],
  );
}

const clarify = (options: ScopeOption[]): CompiledInstruction => ({
  kind: "clarify",
  question: "Which should this apply to?",
  options,
});

/**
 * Compile one recognized instruction at one scope against the document it
 * would change. Pure. `scope` is what the owner stated or the page they were
 * on says (a selected step); null when neither did.
 */
export function compileInstruction(
  recognized: RecognizedInstruction,
  scope: InstructionScope | null,
  base: CampaignAgentStrategy,
  network: NetworkCatalog,
): CompiledInstruction {
  if (recognized.intent === "unknown") {
    return nothing("That is not a change this campaign has a setting for, so nothing was proposed.");
  }
  // Never this person again is the account's, whatever scope it is said at.
  if (recognized.intent === "person.exclude") {
    return {
      kind: "exclusion",
      profileId: recognized.args.profile_id,
      summary: "Stop contacting this person from this account",
    };
  }
  const name = recognized.intent;
  const stepInScope =
    scope?.level === "step"
      ? scope.stepId
      : recognized.intent === "step.instructions.edit"
        ? recognized.args.step_id
        : null;
  const options = askable(name, stepInScope);
  // Unclear or unstated, it asks — unless only one answer is possible.
  if (options.length > 1 && (recognized.ambiguous_scope || scope === null)) return clarify(options);

  const allowed = SCOPES[name];
  const level: ScopeLevel = scope?.level ?? options[0]?.scope.level ?? allowed[0]!;
  if (level === "message") return nothing(NOT_POLICY);
  if (!allowed.includes(level)) {
    if (level === "account") return nothing(ACCOUNT_ELSEWHERE[name] ?? ACCOUNT_POLICY);
    // A step was in scope for a change that is the campaign's: ask, rather
    // than widen it to every step without a word.
    if (options.length > 1) return clarify(options);
    return nothing("That change belongs to one step — say which.");
  }

  const replace = (path: string, value: string | number | boolean | null): PatchOp => ({
    op: "replace",
    path,
    value,
  });
  const ops = (summary: string, list: PatchOp[], stepIdOf: string | null = null): CompiledInstruction => ({
    kind: "ops",
    intent: name,
    ops: list,
    paths: [...new Set(list.map((op) => op.path))],
    stepId: stepIdOf,
    summary,
  });

  switch (recognized.intent) {
    case "voice.casing":
      return ops("Ordinary sentence capitals and a capital I", [
        replace("/voice/casing", "sentence"),
        replace("/voice/capital_i", true),
      ]);
    case "eligibility.neutral_relevant":
      if (!base.eligibility) return nothing(NO_REPLY_HANDLING);
      return ops(`Neutral relevant replies: ${recognized.args.value}`, [
        replace("/eligibility/neutral_relevant", recognized.args.value),
      ]);
    case "cta.after_relevant_exchanges": {
      if (!base.cta) {
        return nothing("This campaign has no offer to ask about yet — design it with an offer first.");
      }
      const { exchanges, sentence_target } = recognized.args;
      return ops(`Ask to try after ${exchanges} relevant exchange${exchanges === 1 ? "" : "s"}`, [
        replace("/cta/after_relevant_exchanges", exchanges),
        ...(sentence_target === null ? [] : [replace("/voice/sentence_target", sentence_target)]),
      ]);
    }
    case "dm.outgoing_acceptance":
      if (!base.dm) return nothing(NO_REPLY_HANDLING);
      return ops(`After an accepted invitation: ${recognized.args.value.replaceAll("_", " ")}`, [
        replace("/dm/outgoing_acceptance", recognized.args.value),
      ]);
    case "step.instructions.edit": {
      const id = scope?.level === "step" ? scope.stepId : recognized.args.step_id;
      if (id !== recognized.args.step_id) {
        return nothing(`The instruction names ${recognized.args.step_id}, but this conversation is about ${id} — say which step.`);
      }
      const step = (base.steps ?? []).find((item) => item.step_id === id);
      if (!step) return nothing(`This campaign has no step ${id}.`);
      return ops(`${stepName(step)} · instructions`, [
        replace(`/steps/${id}/instructions`, recognized.args.instructions),
      ], id);
    }
    case "action.mode":
      return actionMode(recognized.args, level === "step" ? stepInScope : null, base, network, ops);
  }
}

const NO_REPLY_HANDLING =
  "This campaign does not handle replies yet, so there is no reply policy to change — switch on Reply when they answer first.";

/** One send's mode, set on every binding of it — in the campaign, or in the
 *  one step the instruction is about. A send no step binds has nothing to
 *  set. */
function actionMode(
  args: { action: ModeKey; mode: ActionMode },
  stepIdOf: string | null,
  base: CampaignAgentStrategy,
  network: NetworkCatalog,
  ops: (summary: string, list: PatchOp[], stepIdOf?: string | null) => CompiledInstruction,
): CompiledInstruction {
  const steps = new Map((base.steps ?? []).map((step) => [step.step_id, step]));
  const bound = (base.action_bindings ?? []).filter((binding) => {
    const step = steps.get(binding.owner_step_id);
    if (!step || (stepIdOf !== null && step.step_id !== stepIdOf)) return false;
    const row = networkActionFor(network, binding.capability_ref, step.catalog_step);
    return row.ok && row.action.stored === args.action;
  });
  if (bound.length === 0) {
    return nothing(
      stepIdOf === null
        ? "No step in this campaign takes that action, so there is no mode to set — add the step that does first."
        : `The step ${stepIdOf} does not take that action.`,
    );
  }
  return ops(
    `${args.action.replaceAll("_", " ")}: ${args.mode}`,
    bound.map((binding) => ({
      op: "add",
      path: `/action_bindings/${binding.action_binding_id}/mode`,
      value: args.mode,
    })),
    stepIdOf,
  );
}

/**
 * The patch a compiled instruction is, against the version it was compiled
 * from. Pure. The owner's words ride on the provenance, verbatim and inert.
 */
export function instructionPatch(input: {
  campaignId: number;
  expectedBaseVersion: number;
  compiled: Extract<CompiledInstruction, { kind: "ops" }>;
  instruction: string;
}): StrategyPatch {
  const { compiled } = input;
  return {
    kind: STRATEGY_PATCH,
    campaignId: input.campaignId,
    expectedBaseVersion: input.expectedBaseVersion,
    ops: compiled.ops,
    dependencyVersions: { voice: null, knowledge: null, memory: null },
    provenance: {
      instruction: input.instruction,
      recognizedIntent: { summary: `${compiled.intent}: ${compiled.summary}`, paths: compiled.paths },
      scope: { stepId: compiled.stepId },
      compilerVersion: INSTRUCTION_COMPILER_VERSION,
    },
  };
}

/**
 * The spec's "required preview" for a change (§09): what the patch does, said
 * plainly, from the document before and after — so a card says it whoever
 * drew the patch. Pure.
 */
export function changePreview(
  before: CampaignAgentStrategy,
  after: CampaignAgentStrategy,
): string[] {
  const out: string[] = [];
  if (before.voice.casing !== after.voice.casing || before.voice.capital_i !== after.voice.capital_i) {
    out.push(
      after.voice.casing === "sentence"
        ? "Drafts use ordinary sentence capitals and a capital I — plain, not formal copy."
        : "Drafts follow the casing of your own writing.",
    );
  }
  if (before.eligibility && after.eligibility && before.eligibility.neutral_relevant !== after.eligibility.neutral_relevant) {
    out.push(
      {
        eligible: "A relevant neutral reply becomes eligible; an unrelated or negative reply is still skipped.",
        review: "A relevant neutral reply waits for your look; an unrelated or negative reply is still skipped.",
        skip: "A relevant neutral reply is skipped, like an unrelated or negative one.",
      }[after.eligibility.neutral_relevant],
    );
  }
  if (before.cta && after.cta && before.cta.after_relevant_exchanges !== after.cta.after_relevant_exchanges) {
    const n = after.cta.after_relevant_exchanges;
    out.push(
      `After ${n === 1 ? "one relevant exchange" : `${n} relevant exchanges`}, the answer meets their actual point, then asks whether they want to try it.`,
    );
  }
  if (before.voice.sentence_target !== after.voice.sentence_target) {
    out.push(
      after.voice.sentence_target === null
        ? "Draft length is left to the voice again."
        : `Drafts aim at about ${after.voice.sentence_target} sentences — a goal, never a reason to leave part of a question unanswered.`,
    );
  }
  if (before.dm && after.dm && before.dm.outgoing_acceptance !== after.dm.outgoing_acceptance) {
    const exception = `The exception is separate: a verified comment-linked incoming invitation may get one contextual opener, which is ${after.dm.incoming_linked_opener ? "on" : "off"} for this campaign.`;
    out.push(
      after.dm.outgoing_acceptance === "wait_for_interest"
        ? `An accepted invitation alone sends no sales DM — a DM waits until they show interest. ${exception}`
        : `Once an outgoing invitation is accepted, one contextual opener may follow before they show interest. ${exception}`,
    );
  }
  // A version never sets a step voice (`refuseStepVoice`); it only clears one.
  if (before.voice.voice_profile_id !== null && after.voice.voice_profile_id === null) {
    out.push("Every step writes in the campaign's voice.");
  }
  const priorSteps = new Map((before.steps ?? []).map((step) => [step.step_id, step]));
  for (const step of after.steps ?? []) {
    const prior = priorSteps.get(step.step_id);
    if (prior && prior.instructions !== step.instructions) {
      out.push(
        `Only ${stepName(step)} changes. Drafts it writes from now on follow the new instructions; anything already sent stays as it was.`,
      );
    }
  }
  return out;
}
