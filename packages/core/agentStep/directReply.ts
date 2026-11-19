import { and, eq } from "drizzle-orm";
import { incomingComments, type Campaign, type ConversationEventRow, type ConversationRow } from "@engager/database/schema";
import { withOrg } from "@engager/database/tenant";
import type { LLM } from "../ai/client";
import { readIncoming, readingOf, sensitivityOf, sensitivityRow } from "../ai/reading";
import { CAPABILITIES } from "../strategy/catalog";
import type { CampaignAgentStrategy, StrategyStep } from "../strategy/contract";
import type { ResolvedAction } from "../strategy/resolve";
import { dispatchCall, type DispatchRefusal } from "./dispatch";
import type { StepInput } from "./input";
import type { ConversationItem } from "./select";
import { callDigest } from "./validate";

/**
 * A REPLY STEP WITH ONE THING TO DO. A Reply when they answer step whose only action
 * above Off is Reply has nothing for an agent to choose: the server drafts the
 * reply itself, from the reply's stored reading, and the step run records that
 * one draft as its only tool call — no agent turn, no model call but the
 * writer's. Anything the step could do besides — a Like on the reply, a DM, an
 * invitation, memory it may write — keeps the agent loop (`wake.ts`).
 *
 * The draft lands where the loop's lands: Ask me waits for the owner's yes,
 * Automatic is approved to go out paced by the day plan. Nothing here sends, reserves or clicks.
 */

/** The Reply a step is left with, when that is all it can do with the reply
 *  it was woken by; null when an agent should decide. */
export function soleReply(
  input: {
    step: Pick<StrategyStep, "step_id" | "catalog_step">;
    actions: readonly ResolvedAction[];
    stepInput: Pick<StepInput, "incoming" | "targets">;
    memoryBindings: CampaignAgentStrategy["memory_bindings"];
    item: Pick<ConversationItem, "origin" | "workKey">;
  },
): { target: string; mode: "review" | "auto" } | null {
  const { step, stepInput, item } = input;
  // A reply as it arrived: not a wait that ran out, nor a room's comment.
  if (step.catalog_step !== "handle_reply" || item.origin !== "event" || !item.workKey.startsWith("event:")) return null;
  const target = stepInput.targets.their_reply?.[0];
  if (!target || !stepInput.incoming || input.memoryBindings.some((binding) => binding.access === "write")) return null;
  const open = input.actions.filter((action) => action.step_id === step.step_id && action.effective !== "off");
  const [only] = open;
  if (open.length !== 1 || only?.capability !== "reply_public" || only.target !== "their_reply") return null;
  return { target, mode: only.effective === "auto" ? "auto" : "review" };
}

export type DirectAnswer =
  /** The reading holds the reply for the owner: nothing was drafted. */
  | { kind: "held" }
  | { kind: "answered"; drafted: boolean }
  | { kind: "refused"; reason: DispatchRefusal; ref: string };

/**
 * Draft the reply to `stepInput.incoming` as the step's one tool call. The
 * reading it rests on is the one intake stored; a reply that has none is read
 * here, once, and stored. A held reading drafts nothing: the row is marked
 * held, and the reply waits for the owner as any sensitive reply does.
 */
export async function answerReply(input: {
  organizationId: string;
  checkpointId: number;
  runId: number;
  campaign: Campaign;
  step: StrategyStep;
  stepInput: StepInput;
  conversation: ConversationRow;
  event: ConversationEventRow;
  sole: NonNullable<ReturnType<typeof soleReply>>;
  generationSeen: number;
  strategyVersion: number;
  voice: CampaignAgentStrategy["voice"];
  llm: LLM;
  continueRun: () => Promise<boolean>;
  now: number;
}): Promise<DirectAnswer> {
  const incoming = input.stepInput.incoming!;
  let reading = readingOf(incoming);
  if (!reading) {
    reading = await readIncoming(incoming.text, "reply", input.llm);
    await withOrg(input.organizationId, (tx) =>
      tx.update(incomingComments).set({ reading }).where(eq(incomingComments.id, incoming.id)),
    );
  }
  const sensitivity = sensitivityOf(reading);
  if (sensitivity.hold || incoming.sensitivity === "hold") {
    await withOrg(input.organizationId, (tx) =>
      tx
        .update(incomingComments)
        .set(incoming.sensitivity === "hold" ? {} : sensitivityRow(sensitivity))
        .where(and(eq(incomingComments.id, incoming.id), eq(incomingComments.status, "new"))),
    );
    return { kind: "held" };
  }
  const call = {
    call_id: "reply",
    tool: "draft_comment",
    version: CAPABILITIES.draft_comment.version,
    target: { kind: "their_reply", ref: input.sole.target },
    inputs: [],
    cta_asset_id: null,
  };
  const outcome = await dispatchCall({
    organizationId: input.organizationId,
    record: { checkpoint: { id: input.checkpointId }, runId: input.runId, iteration: 0, call, digest: callDigest(call) },
    tool: "draft_comment",
    step: input.step,
    stepInput: input.stepInput,
    campaignId: input.campaign.id,
    conversation: input.conversation,
    event: input.event,
    generationSeen: input.generationSeen,
    strategyVersion: input.strategyVersion,
    voice: input.voice,
    llm: input.llm,
    continueRun: input.continueRun,
    now: input.now,
    replyMode: input.sole.mode,
  });
  return outcome.kind === "refused"
    ? { kind: "refused", reason: outcome.reason, ref: outcome.ref }
    : { kind: "answered", drafted: outcome.drafted };
}
