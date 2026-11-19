import { createHash } from "node:crypto";
import { AppError } from "@engager/common/errors";
import type { Campaign, ProductFact } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import type { LLM } from "../ai/client";
import { readIncoming, sensitivityOf } from "../ai/reading";
import { writingStepRevision } from "../ai/writingInstructions";
import { writeConversationWords } from "../dispatcher/conversationWords";
import type { CampaignAgentStrategy, StrategyStep } from "../strategy/contract";
import { strategyRegister, draftingVoiceId } from "../strategy/draftingVoice";
import { getProfile } from "../profile";
import { prepareRoomReplyWords } from "../rooms/replyDrafting";
import type { RoomReplySource } from "../rooms/replySource";
import { resolveCampaignVoice } from "../voice";
import { productEvidenceFacts } from "../workers/evidenceReview";

export async function prepareStepRoomReply(tx: Tx, input: {
  source: RoomReplySource; campaign: Campaign; voice: CampaignAgentStrategy["voice"];
  step: Pick<StrategyStep, "step_id" | "instructions">; facts: ProductFact[];
}) {
  const prepared = await prepareRoomReplyWords(tx, input.source, "reply", input.step.step_id);
  const voice = strategyRegister(await resolveCampaignVoice(tx,
    { voiceId: draftingVoiceId(input.voice, input.campaign) }, await getProfile(tx), "reply"), input.voice);
  const facts = input.facts.map((fact) => fact.content);
  const products = prepared.context.ownerFacts.products.map(product => ({ ...product, facts: [] }));
  const context = { ...prepared.context, voice,
    ownerFacts: { ...prepared.context.ownerFacts, products, facts } };
  const evidence = { ...prepared.evidence, productFacts: [...facts, ...productEvidenceFacts(products)] };
  const contextRevision = createHash("sha256").update(JSON.stringify({ source: input.source, context: { ...context, stepInstructions: writingStepRevision(context.stepInstructions) }, evidence })).digest("hex");
  return { source: input.source, campaign: input.campaign, context, evidence, contextRevision };
}

export type PreparedStepRoomReply = Awaited<ReturnType<typeof prepareStepRoomReply>>;

/** A reply under the selected comment, planned, written and judged by the
 * dispatcher. The caller renews its lease and rechecks current room authority
 * before each model call; a changed context cannot reach the next one. */
export async function writeStepRoomReply(prepared: PreparedStepRoomReply, opts: {
  organizationId: string; llm: LLM; beforeCall: () => Promise<boolean>;
}) {
  const { context } = prepared;
  // Their comment is read first, and words a person must see first are not answered.
  if (sensitivityOf(await readIncoming(context.recipient.comment, "comment", opts.llm)).hold) {
    throw new AppError("room_sensitive_hold", "Their comment needs your eyes first, so no reply was drafted.", 409);
  }
  const words = await writeConversationWords({
    organizationId: opts.organizationId,
    campaign: prepared.campaign,
    llm: opts.llm,
    surface: "room_reply",
    conversation: {
      post: { discoveredPostId: null, authorName: context.recipient.name, postedAt: null, text: context.recipient.comment, mediaText: null },
      turns: context.post.opening ? [{ speaker: "other", name: context.post.authorName ?? null, text: context.post.opening }] : [],
    },
    query: context.recipient.comment,
    headline: context.recipient.headline,
    products: context.ownerFacts.products,
    facts: context.ownerFacts.facts,
    room: prepared.evidence.room,
    step: context.stepInstructions,
    firstTouch: true,
    maxChars: context.maxCharacters,
    continueRun: opts.beforeCall,
  });
  if (words === null) throw new AppError("room_work_changed", "The selected room work changed.", 409);
  return words.text;
}
