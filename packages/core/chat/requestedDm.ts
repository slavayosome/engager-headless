import { eq } from "drizzle-orm";
import { z } from "zod";
import { campaigns, dmThreads, conversations } from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import type { LLM } from "../ai/client";
import { conversationConversation } from "../agentStep/input";
import { loadStrategy } from "../agentStep/select";
import { conversationSource } from "../agentStep/writing";
import type { BoxWords, ComposerAsk, RequestedDmWords } from "./requestedDraft";
import { runSpokenWords } from "./requestedWords";

/**
 * WORDS FOR A DM THE OWNER IS WRITING — Messages' Draft for me, in the box at
 * the foot of a person's conversation. Their own agent, in the chat dock,
 * writes one message from the conversation as it stands, and the words go
 * back to the box as the turn's last text: raw material, written nowhere. No
 * draft, no action, no request, no step or wake records them. What goes out
 * is only what the owner presses Send on (`sendOwnerDm`), measured there for
 * how much of these words it kept.
 *
 * The dispatcher writes it as it writes a step's DM, from the conversation
 * that DM is drafted from, in the voice the conversation's campaign writes in
 * (`conversationSource`).
 */

export const RequestedDmText = z.object({ text: z.string().trim().min(1).max(1250) }).strict();

/** What a first message is worded from: no messages either way yet. */
const NO_MESSAGES_YET = "No messages yet: this is the first message to them.";

/** The conversation to word a DM in, for the owner's own box; refused, each
 *  for what it is, where the box takes no words: a conversation closed, one
 *  the owner took over, someone the last read shows not connected, or one the
 *  inbox list held for the owner, which no draft of anyone's reads. A
 *  connection with no conversation bound yet is worded a first message, the
 *  opener the owner's send opens one with (`dmOpenTargetFor`). Nothing is
 *  filed. */
export async function prepareDmWords(tx: Tx, request: RequestedDmWords) {
  const [conversation] = await tx.select().from(conversations).where(eq(conversations.id, request.conversationId));
  if (!conversation || conversation.closedReason !== null || conversation.owningCampaignId === null) {
    throw new Error("dm_request_closed");
  }
  if (conversation.opsStatus === "human_owned") throw new Error("dm_conversation_taken_over");
  const threadId = conversation.canonicalDmThreadId;
  if (threadId === null && conversation.relationship !== "connected") throw new Error("dm_not_connected");
  if (threadId !== null) {
    const [thread] = await tx.select({ heldAt: dmThreads.ownerHeldAt }).from(dmThreads).where(eq(dmThreads.id, threadId));
    if (thread?.heldAt != null) throw new Error("dm_thread_held");
  }
  const [campaign] = await tx.select().from(campaigns).where(eq(campaigns.id, conversation.owningCampaignId));
  const strategy = campaign ? await loadStrategy(tx, campaign) : null;
  if (!campaign || !strategy) throw new Error("dm_campaign_missing");
  const dmHistory = threadId === null ? NO_MESSAGES_YET : await conversationConversation(tx, conversation);
  if (dmHistory === null) throw new Error("dm_thread_unbound");
  const source = await conversationSource(tx, {
    conversation,
    campaign,
    dmHistory,
    // The owner answers what is there, their words or our own unanswered; a
    // first message is the opener an acceptance starts.
    eventType: threadId === null ? "invitation_accepted" : "inbound_message_observed",
    voice: strategy.document.voice,
    now: Date.now(),
  });
  return { campaign, source };
}

/**
 * The owner's-box workflow for a DM: read the conversation, have the
 * dispatcher write one message through the owner's agent, and hand the words
 * back as the turn's last text. Nothing is delivered — what the owner sends is
 * theirs, measured at the send for how much of these words it kept. An angle
 * the composer asked for (`ask`) rides beside the conversation.
 */
export async function runDmWords(deps: {
  organizationId: string;
  request: RequestedDmWords;
  llm: LLM;
  progress: (text: string) => void;
  active?: () => Promise<void>;
  ask?: ComposerAsk;
}): Promise<BoxWords> {
  deps.progress("Reading the conversation and your voice…");
  await deps.active?.();
  const { campaign, source } = await withOrg(deps.organizationId, (tx) => prepareDmWords(tx, deps.request));
  return runSpokenWords({
    ...deps,
    text: RequestedDmText,
    input: {
      campaign,
      surface: source.purpose === "followup" ? "followup" : "dm",
      conversation: { post: { discoveredPostId: null, authorName: source.name, postedAt: null, text: source.conversation, mediaText: null }, turns: [] },
      query: source.conversation,
      products: source.products,
      firstTouch: source.purpose === "opener",
      rules: [source.interest ? "Interest is evidenced by their quoted words; claim no further commitment." : "Do not claim they expressed interest in an offer."],
    },
  });
}
