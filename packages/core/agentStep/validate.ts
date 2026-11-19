import { createHash } from "node:crypto";
import type { ActionKind } from "@engager/database/schema";
import {
  CAPABILITIES,
  type CapabilityId,
  type ContextTypeId,
  type GrantId,
  type TargetType,
} from "../strategy/catalog";
import type { CampaignAgentStrategy, StrategyStep } from "../strategy/contract";
import type { ResolvedAction } from "../strategy/resolve";
import type { ProposedToolCall } from "./result";

/**
 * THE GATE BETWEEN A MODEL'S PROPOSAL AND THE SERVER'S ACT (INV-3, INV-26).
 * Every tool call an `AgentStepResult` proposes is judged here, one verdict
 * each, before anything is dispatched; a call that fails is DISCARDED with its
 * reason, never clamped into one that would pass. Pure.
 *
 * Authority is judged before shape, in this order, and the first rule a call
 * fails names it:
 *
 *   unknown_tool        no catalog capability by that id
 *   version_mismatch    the catalog's capability is another version
 *   outside_grants      not in the step's `allowed_tools`, or a send whose
 *                       grant the campaign does not hold
 *   mode_off            a send whose effective mode for this step is Off —
 *                       a send the step binds no action for is Off too
 *                       (INV-28)
 *   target_mismatch     a send the step binds above Off, aimed at an action target
 *                       its binding's selector does not name: a Like reply
 *                       proposed at the post. The server aims a send by the
 *                       binding, never by the proposal (`actions/likeTarget.ts`)
 *   write_unavailable   a send whose mode is not Off, of a kind a wake does
 *                       not queue — Accept invite, which the invitations
 *                       read reserves itself, never a model
 *   reply_off           a public reply drafted on a live campaign whose step
 *                       holds its Reply Off: live, the draft IS the Reply
 *                       waiting for the owner's yes, and Off leaves it none
 *   unbound_input       an input bound to a context the step does not name,
 *                       an item that context does not carry, an output no
 *                       dispatched call produced, or a memory slot — no tool
 *                       takes one; a required input
 *                       missing — a Reply, a DM and a Follow-up name the
 *                       draft they send; or a CTA asset on any send but a DM
 *   target_unavailable  an action target kind the capability does not take, or a ref
 *                       this conversation does not have
 *   duplicate_call      a call this checkpoint already dispatched
 *   over_budget         past the wake's tool-action budget
 *
 * A permitted call is a read or a draft, which the server dispatches, or a
 * send whose mode is above Off: a Like, an Invite, a DM or a Follow-up the
 * server RESERVES on the action ledger (`actions/ledger.ts`) — for the
 * owner's yes at Ask me, to go out on its own at Automatic — never a click:
 * only the dispatch gate clicks (`execution/actionGate.ts`), and the account's
 * ceiling binds it there; a Reply it PROPOSES on `messages`, where the draft
 * it names already waits and only the owner's yes reaches the action ledger.
 *
 * One send is neither: a Like of their reply at Ask me that the step
 * proposes while it answers that same reply — a `draft_comment` or
 * `reply_public` of this iteration at the same target, or one this checkpoint
 * already dispatched — FOLDS into the answer (`dispatch.ts` `foldLikeCall`),
 * where the server already put it when it drafted the answer. It is the
 * Reply's own like, on the Reply's yes and in the Reply's visit, never a
 * second row waiting beside it. At Automatic the server liked the reply on
 * sight, or held a like back, so the step's like is reserved — for a yes.
 */

export const DISCARD_REASONS = [
  "unknown_tool",
  "version_mismatch",
  "outside_grants",
  "mode_off",
  "target_mismatch",
  "write_unavailable",
  "reply_off",
  "unbound_input",
  "target_unavailable",
  "duplicate_call",
  "over_budget",
  "input_version_mismatch",
] as const;
export type DiscardReason = (typeof DISCARD_REASONS)[number];

/** What a tool takes, by input name: whether it must be bound, and the
 *  contexts and earlier calls' outputs it may be bound to. */
type InputSpecs = Readonly<
  Record<
    string,
    {
      required: boolean;
      contexts: readonly ContextTypeId[];
      outputs: readonly CapabilityId[];
    }
  >
>;

/** The tools a conversation wake can dispatch, the action targets each one serves
 *  here, and the inputs each one takes. A draft is answered to the person in
 *  front of the step: their reply, or their one DM thread. */
const DISPATCHABLE = {
  read_thread: { targets: ["their_reply", "post", "room_comment"], inputs: {} },
  read_profile: { targets: ["person"], inputs: {} },
  draft_comment: {
    targets: ["their_reply", "room_comment"],
    inputs: {
      thread: { required: true, contexts: ["verified_thread", "room_thread"], outputs: ["read_thread"] },
      facts: { required: false, contexts: ["product_facts"], outputs: [] },
      voice: { required: false, contexts: ["campaign_voice"], outputs: [] },
    },
  },
  draft_dm: {
    targets: ["dm_thread"],
    inputs: {
      // The exchange under our comment, or their conversation with the
      // account: a DM answers whichever the person is in.
      thread: { required: true, contexts: ["verified_thread", "dm_thread"], outputs: ["read_thread"] },
      facts: { required: false, contexts: ["product_facts"], outputs: [] },
      voice: { required: false, contexts: ["campaign_voice"], outputs: [] },
    },
  },
} as const satisfies Partial<
  Record<CapabilityId, { targets: readonly TargetType[]; inputs: InputSpecs }>
>;
export type DispatchableTool = keyof typeof DISPATCHABLE;

export function isDispatchable(tool: string): tool is DispatchableTool {
  return Object.hasOwn(DISPATCHABLE, tool);
}

/** The sends a wake reserves on the action ledger, and the ledger kind each
 *  becomes. A like and an invitation take no inputs: the action target is the whole
 *  of a like, and an invitation's note is the server's draft from the
 *  verified exchange (`agentStep/dispatch.ts`), never the model's text. */
const RESERVABLE = {
  like_target: "like_target",
  send_invitation: "invite",
  send_dm: "dm",
  followup: "followup",
} as const satisfies Partial<Record<CapabilityId, ActionKind>>;
export type ReservableTool = keyof typeof RESERVABLE;

/** The reserved sends that carry words, and where the words come from: the
 *  draft a `draft_dm` call of the step wrote, which the call names. */
const RESERVABLE_INPUTS: Partial<Record<ReservableTool, InputSpecs>> = {
  send_dm: { draft: { required: true, contexts: [], outputs: ["draft_dm"] } },
  followup: { draft: { required: true, contexts: [], outputs: ["draft_dm"] } },
};

/** The one send that may name a CTA asset: a DM making the offer, which the
 *  server holds to the campaign's approved asset (`actions/dm.ts`). */
const OFFERS: ReadonlySet<CapabilityId> = new Set(["send_dm"]);

export function isReservable(tool: string): tool is ReservableTool {
  return Object.hasOwn(RESERVABLE, tool);
}

export function ledgerKindOf(tool: ReservableTool): ActionKind {
  return RESERVABLE[tool];
}

/** The sends a wake proposes on `messages`, which they never leave for the
 *  action ledger (INV-27), and the inputs each takes: a Reply sends the draft
 *  a `draft_comment` call of its step wrote, and names it. */
const PROPOSABLE = {
  reply_to_comment: {
    draft: { required: true, contexts: [], outputs: ["draft_comment"] },
  },
  reply_public: {
    draft: { required: true, contexts: [], outputs: ["draft_comment"] },
  },
} as const satisfies Partial<Record<CapabilityId, InputSpecs>>;
export type ProposableTool = keyof typeof PROPOSABLE;

export function isProposable(tool: string): tool is ProposableTool {
  return Object.hasOwn(PROPOSABLE, tool);
}

export type ValidationContext = {
  step: StrategyStep;
  /** The campaign's grants: the account holds none of its own (INV-28). */
  grants: readonly GrantId[];
  /** The step's actions, resolved against the channel at this instant. */
  actions: readonly ResolvedAction[];
  /** What this conversation can aim at, by kind. */
  targets: Readonly<Partial<Record<TargetType, readonly string[]>>>;
  /** The contexts the step was handed, each with the item ids it carries. */
  context: Readonly<Partial<Record<ContextTypeId, readonly string[]>>>;
  /** Calls this checkpoint dispatched, by call id, and their digests. */
  outputs: ReadonlyMap<string, CapabilityId>;
  dispatched: ReadonlySet<string>;
  /** The replies this checkpoint already answers: the `their_reply` refs a
   *  `draft_comment` or `reply_public` of it dispatched at. */
  answering: ReadonlySet<string>;
  /** How many more calls the wake's budget admits. */
  remainingActions: number;
};

export type CallVerdict =
  | { call: ProposedToolCall; digest: string; outcome: "dispatch"; tool: DispatchableTool }
  | {
      call: ProposedToolCall;
      digest: string;
      outcome: "reserve";
      tool: ReservableTool;
      /** The binding that permits it, the action target its selector names and the
       *  mode it resolved to: Automatic reserves an Invite, a DM or a
       *  Follow-up to go out on its own, within the account's ceiling; Ask
       *  me — and any Like a step proposes — waits for the owner's yes. */
      binding: Pick<ResolvedAction, "action_binding_id" | "target" | "effective">;
    }
  | {
      call: ProposedToolCall;
      digest: string;
      outcome: "fold";
      tool: "like_target";
      /** The binding that permits the like: it rides with the answer to the
       *  same reply, and is reserved under this binding where it cannot. */
      binding: Pick<ResolvedAction, "action_binding_id" | "target" | "effective">;
    }
  | {
      call: ProposedToolCall;
      digest: string;
      outcome: "propose";
      tool: ProposableTool;
      /** What the Reply resolved to here: Automatic approves its draft. */
      effective: ResolvedAction["effective"];
    }
  | { call: ProposedToolCall; digest: string; outcome: "discard"; reason: DiscardReason };

/** Two calls with one digest are one call: tool, version, target and inputs,
 *  in a canonical order. */
export function callDigest(call: ProposedToolCall): string {
  const inputs = [...call.inputs]
    .map((input) => ({ ...input, ids: [...input.ids].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return createHash("sha256")
    .update(
      JSON.stringify([
        call.tool,
        call.version,
        call.target.kind,
        call.target.ref,
        inputs.map((input) => [input.name, input.source, input.ref, input.ids]),
        call.cta_asset_id,
      ]),
    )
    .digest("hex");
}

/** The calls that answer their reply in public: the draft, and the Reply that
 *  sends it. */
const ANSWERS: ReadonlySet<string> = new Set<CapabilityId>(["draft_comment", "reply_public", "reply_to_comment"]);

/** Judge one iteration's calls, in the order proposed. */
export function validateCalls(
  calls: readonly ProposedToolCall[],
  ctx: ValidationContext,
): CallVerdict[] {
  const seen = new Set(ctx.dispatched);
  const answering = new Set([
    ...ctx.answering,
    ...calls
      .filter((call) => ANSWERS.has(call.tool) && ["their_reply", "room_comment"].includes(call.target.kind) && refusal(call, ctx) === null)
      .map((call) => call.target.ref),
  ]);
  let admitted = 0;
  return calls.map((call) => {
    const digest = callDigest(call);
    const reason = refusal(call, ctx);
    if (reason) return { call, digest, outcome: "discard", reason };
    if (seen.has(digest)) return { call, digest, outcome: "discard", reason: "duplicate_call" };
    if (admitted >= ctx.remainingActions) {
      return { call, digest, outcome: "discard", reason: "over_budget" };
    }
    seen.add(digest);
    admitted += 1;
    if (isReservable(call.tool)) {
      const permitted = permittingBinding(call.tool, call.target.kind, ctx)!;
      const binding = {
        action_binding_id: permitted.action_binding_id,
        target: permitted.target,
        effective: permitted.effective,
      };
      if (
        call.tool === "like_target" &&
        binding.target === "their_reply" &&
        binding.effective === "review" &&
        answering.has(call.target.ref)
      ) {
        return { call, digest, outcome: "fold", tool: call.tool, binding };
      }
      return { call, digest, outcome: "reserve", tool: call.tool, binding };
    }
    if (isProposable(call.tool)) {
      const binding = permittingBinding(call.tool, call.target.kind, ctx)!;
      return { call, digest, outcome: "propose", tool: call.tool, effective: binding.effective };
    }
    return { call, digest, outcome: "dispatch", tool: call.tool as DispatchableTool };
  });
}

function refusal(call: ProposedToolCall, ctx: ValidationContext): DiscardReason | null {
  if (!Object.hasOwn(CAPABILITIES, call.tool)) return "unknown_tool";
  const tool = call.tool as CapabilityId;
  const entry = CAPABILITIES[tool];
  if (call.version !== entry.version) return "version_mismatch";

  const allowed: readonly CapabilityId[] = ctx.step.allowed_tools;
  if (!allowed.includes(tool)) return "outside_grants";
  if (ctx.step.catalog_step === "meet_the_room" && ctx.context.room_thread &&
    !ctx.targets.room_comment?.length && tool !== "send_invitation" && CAPABILITIES[tool].effect === "send") return "outside_grants";
  const grant: GrantId | null = entry.grant;
  if (grant !== null && !ctx.grants.includes(grant)) return "outside_grants";

  if (entry.effect === "send" || entry.effect === "none") {
    // Record outcome takes no mode — the owner confirms it — so no step ever
    // proposes one into being.
    const permitted = entry.effect === "send" ? permittingBinding(tool, call.target.kind, ctx) : null;
    if (permitted === null) {
      return entry.effect === "send" && aimedElsewhere(tool, call.target.kind, ctx)
        ? "target_mismatch"
        : "mode_off";
    }
    if (!isReservable(tool) && !isProposable(tool)) return "write_unavailable";
    const inputs: InputSpecs = isProposable(tool) ? PROPOSABLE[tool] : (RESERVABLE_INPUTS[tool] ?? {});
    if ((call.cta_asset_id !== null && !OFFERS.has(tool)) || !inputsBound(inputs, call, ctx)) {
      return "unbound_input";
    }
    const refs = ctx.targets[call.target.kind as TargetType] ?? [];
    return refs.includes(call.target.ref) ? null : "target_unavailable";
  }
  if (!isDispatchable(tool)) return "outside_grants";
  // The public reply a step drafts lands waiting for the owner's yes as its
  // Reply (`dispatch.ts`), so its Reply must be above Off.
  if (
    tool === "draft_comment" &&
    permittingBinding(call.target.kind === "room_comment" ? "reply_to_comment" : "reply_public",
      call.target.kind === "room_comment" ? "room_comment" : "their_reply", ctx) === null
  ) {
    return "reply_off";
  }

  if (!inputsBound(DISPATCHABLE[tool].inputs, call, ctx)) return "unbound_input";

  const served: readonly string[] = DISPATCHABLE[tool].targets;
  if (!served.includes(call.target.kind)) return "target_unavailable";
  const refs = ctx.targets[call.target.kind as TargetType] ?? [];
  if (!refs.includes(call.target.ref)) return "target_unavailable";
  return null;
}

/** The step's binding that permits this send at this action target — the first
 *  whose effective mode is above Off — or null: a send the step binds nothing
 *  for is Off (INV-28: an absent capability is Off). */
function permittingBinding(
  tool: CapabilityId,
  targetKind: string,
  ctx: ValidationContext,
): ResolvedAction | null {
  return (
    ctx.actions.find(
      (action) =>
        action.step_id === ctx.step.step_id &&
        action.capability === tool &&
        action.target === targetKind &&
        action.effective !== "off",
    ) ?? null
  );
}

/** Whether the step binds this send above Off, but none of its bindings
 *  selects this action target. A binding at this action target that is Off is the mode's
 *  answer, not this one. */
function aimedElsewhere(tool: CapabilityId, targetKind: string, ctx: ValidationContext): boolean {
  const bound = ctx.actions.filter(
    (action) => action.step_id === ctx.step.step_id && action.capability === tool,
  );
  return (
    !bound.some((action) => action.target === targetKind) &&
    bound.some((action) => action.effective !== "off")
  );
}

function inputsBound(
  declared: InputSpecs,
  call: ProposedToolCall,
  ctx: ValidationContext,
): boolean {
  const names = new Set<string>();
  for (const input of call.inputs) {
    const spec = declared[input.name];
    if (!spec || names.has(input.name)) return false;
    names.add(input.name);
    switch (input.source) {
      case "context": {
        const contexts: readonly string[] = spec.contexts;
        if (!contexts.includes(input.ref)) return false;
        const context = ctx.step.context_refs as readonly string[];
        const items = ctx.context[input.ref as ContextTypeId];
        if (!context.includes(input.ref) || items === undefined) return false;
        if (!input.ids.every((id) => items.includes(id))) return false;
        break;
      }
      case "output": {
        const produced = ctx.outputs.get(input.ref);
        if (!produced || !spec.outputs.includes(produced) || input.ids.length > 0) {
          return false;
        }
        break;
      }
      case "memory":
        // No tool takes memory as an input: what the account remembers reaches
        // a step through its input, and binds every draft and send of the
        // step through its checkpoint (`step_runs.memory_refs`).
        return false;
    }
  }
  return Object.entries(declared).every(
    ([name, spec]) => !spec.required || names.has(name),
  );
}

/** Whether the step's memory bindings admit a patch: a binding for the slot
 *  at that scope with write access. `permissions` never has one (the
 *  contract refuses it). */
export function memoryPatchAdmitted(
  patch: { slot: string; scope: string },
  bindings: CampaignAgentStrategy["memory_bindings"],
): boolean {
  return bindings.some(
    (binding) =>
      binding.slot === patch.slot &&
      binding.scope === patch.scope &&
      binding.access === "write",
  );
}
