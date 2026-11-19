import { z } from "zod";
import { MEMORY_SLOTS } from "../strategy/contract";

/**
 * `AgentStepResult.v1` — what ONE iteration of an agent step returns through
 * the owner's agent CLI (spec §04, §07). It is a proposal and nothing more:
 * the server validates every call against the catalog, the step's grants and
 * the effective modes, dispatches the permitted ones itself and re-invokes
 * with what they returned (INV-3, INV-26). Nothing in here is a receipt —
 * `rationale_summary` is display text (INV-30), and no number in it reaches a
 * counter (INV-2).
 *
 * Every field is required and every optional value an explicit null, so the
 * shape survives each adapter's structured-output mode. `tool` and
 * `target.kind` are free text on purpose: an unknown tool is a call the
 * validator discards with a reason row, not an iteration that fails to parse.
 */

export const AGENT_STEP_STATUSES = [
  "achieved",
  "waiting",
  "needs_approval",
  "blocked",
  "budget_exhausted",
] as const;
export type AgentStepStatus = (typeof AGENT_STEP_STATUSES)[number];

/** The events a person-to-person step can wait for — the entry events a
 *  conversation produces. */
export const WAIT_EVENTS = [
  "direct_reply",
  "invitation_status",
  "inbound_dm",
  "outcome_evidence",
] as const;
export type WaitEvent = (typeof WAIT_EVENTS)[number];

/** The longest wait a step may ask for: thirty days. */
export const MAX_WAIT_HOURS = 720;

/** Where an input comes from: a context the step names, the output of a call
 *  dispatched earlier in this checkpoint, or a memory slot it is bound to.
 *  `ids` narrows a context to items in it (fact ids); empty is all of it. */
const inputBindingSchema = z
  .object({
    name: z.string().min(1).max(32),
    source: z.enum(["context", "output", "memory"]),
    ref: z.string().min(1).max(64),
    ids: z.array(z.string().min(1).max(64)).max(20),
  })
  .strict();

export const proposedToolCallSchema = z
  .object({
    /** The step's own handle for the call, which a later call names to bind
     *  this one's output. */
    call_id: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
    tool: z.string().min(1).max(64),
    version: z.number().int().min(1).max(1000),
    target: z
      .object({
        kind: z.string().min(1).max(32),
        ref: z.string().min(1).max(300),
      })
      .strict(),
    inputs: z.array(inputBindingSchema).max(8),
    /** The CTA asset a draft offers, or null. */
    cta_asset_id: z.string().min(1).max(200).nullable(),
  })
  .strict();

const memoryPatchSchema = z
  .object({
    slot: z.enum(MEMORY_SLOTS),
    scope: z.enum(["account", "campaign", "step", "person"]),
    key: z.string().min(1).max(64),
    value: z.string().max(500),
    /** The `event:<id>` holding the person's own words, when the patch is
     *  what they said; absent, it is kept as the step's inference. */
    evidence_ref: z.string().min(1).max(120).nullable().optional(),
  })
  .strict();

/**
 * What a `waiting` step waits for: `event` from the person ends it early,
 * whichever comes first of that and its time — `expires_in_hours` from now,
 * or `wake_at`, an instant the step names ("wake me then"), which takes
 * precedence. A `wake_at` rests on `evidence_refs` into the conversation it
 * was handed and, where the person named the time, `quote` — their words,
 * copied exactly. The server bounds it (`agentStep/wait.ts` `judgeWait`):
 * within {@link MAX_WAIT_HOURS}, every ref resolving, the quote theirs; one
 * that fails is discarded with its reason and the step asked again.
 */
const waitRequestSchema = z
  .object({
    event: z.enum(WAIT_EVENTS),
    expires_in_hours: z.number().int().min(1).max(MAX_WAIT_HOURS).nullable(),
    wake_at: z.string().max(40).nullable(),
    on_timeout: z.enum(["wake", "escalate"]),
    evidence_refs: z.array(z.string().min(1).max(120)).max(5),
    quote: z.string().max(300).nullable(),
  })
  .strict();

export const agentStepResultSchema = z
  .object({
    status: z.enum(AGENT_STEP_STATUSES),
    /** One or two sentences a person can read. Never chain-of-thought; the
     *  server keeps 280 characters of it and nothing else of the model's. */
    rationale_summary: z.string().max(500),
    /** Echoes of the versions the server handed over. */
    input_version: z.string().max(80),
    memory_version: z.string().max(80).nullable(),
    /** `event:<id>`, `fact:<id>`, `call:<call_id>` — refs into what the step
     *  was handed. The server keeps only the ones that resolve. */
    evidence_refs: z.array(z.string().min(1).max(120)).max(20),
    proposed_tool_calls: z.array(proposedToolCallSchema).max(8),
    memory_patches: z.array(memoryPatchSchema).max(8),
    /** What a `waiting` step waits for; null takes the step's own entry event
     *  and the default expiry. */
    wait: waitRequestSchema.nullable(),
  })
  .strict();

export type AgentStepResult = z.infer<typeof agentStepResultSchema>;
export type ProposedToolCall = z.infer<typeof proposedToolCallSchema>;
export type InputBinding = ProposedToolCall["inputs"][number];
export type MemoryPatch = AgentStepResult["memory_patches"][number];
export type WaitRequest = NonNullable<AgentStepResult["wait"]>;

/** The tags the step input prints its items under (`[event:766 · …]`,
 *  `[fact:1]`, `agentStep/input.ts`) and evidence refs keep. */
const ITEM_TAG = /^(?:event|fact):/;

/**
 * The result with every input's `ids` bare. A context carries its items as the
 * bare ids, while the input shows them tagged, so a model copies the tag into
 * `ids` as readily as into `evidence_refs`: dropped here, once, before a call
 * is judged, hashed or dispatched.
 */
export function withBareInputIds(result: AgentStepResult): AgentStepResult {
  return {
    ...result,
    proposed_tool_calls: result.proposed_tool_calls.map((call) => ({
      ...call,
      inputs: call.inputs.map((input) => ({ ...input, ids: input.ids.map((id) => id.replace(ITEM_TAG, "")) })),
    })),
  };
}

/** What the server keeps of a step's summary. */
export const RATIONALE_SUMMARY_CHARS = 280;
