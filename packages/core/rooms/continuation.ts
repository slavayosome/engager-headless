import { eq } from "drizzle-orm";
import { campaigns, channels, engagedProfiles, incomingComments, conversations, profileIdKey, type IncomingComment, type ConversationEventRow } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { candidateRefusal } from "../actions/ledger";
import { inheritedStrategies } from "../strategy/inherit";
import { perProfileCapRefusal } from "../ratelimit/ledger";
import { excludedRoomKeys } from "./retention";
import { isRoomThreadReply, roomThreadReceipt } from "./thread";
import { currentRoomWork } from "../agentStep/roomWork";

/** Only the campaign's own confirmed scope admits room conversations. An
 * account default or the ordinary Reply mode cannot widen it implicitly. */
export async function observesRoomReplies(tx: Tx, campaignId: number): Promise<boolean> {
  const [campaign] = await tx.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.id, campaignId));
  if (!campaign) return false;
  const strategy = (await inheritedStrategies(tx, [campaignId])).get(campaignId)?.campaign?.document;
  return strategy?.observation?.source_scopes.includes("room") === true;
}

/** The pre-model and post-model check for a continuation. Ordinary replies
 * keep their existing rules; room exchanges retain their per-person caps. */
export async function roomContinuationRefusal(
  tx: Tx,
  incoming: IncomingComment,
  campaignId: number,
  now: number,
  requireScope = true,
): Promise<string | null> {
  if (!await isRoomThreadReply(tx, incoming)) return null;
  if (incoming.campaignId !== campaignId || !await roomThreadReceipt(tx, incoming)) return "room_receipt_missing";
  if (requireScope && !await observesRoomReplies(tx, campaignId)) return "room_scope_off";
  if (incoming.authorProfileId) {
    const [person] = await tx.select({ excluded: engagedProfiles.doNotEngage }).from(engagedProfiles)
      .where(eq(engagedProfiles.profileId, incoming.authorProfileId));
    if (person?.excluded || (await excludedRoomKeys(tx)).has(`p.${profileIdKey(incoming.authorProfileId)}`)) return "excluded";
  }
  const [channel] = await tx.select({ channel: channels }).from(campaigns)
    .innerJoin(channels, eq(channels.id, campaigns.channelId)).where(eq(campaigns.id, campaignId));
  if (!channel) return "room_account_missing";
  return (await perProfileCapRefusal(tx, channel.channel, incoming.authorProfileId, now, incoming.authorMemberUrn))?.reason ?? null;
}

export async function roomEventRefusal(
  tx: Tx,
  event: Pick<ConversationEventRow, "id" | "conversationId" | "sourceRef">,
  campaignId: number,
  now: number,
  generationSeen: number,
): Promise<string | null> {
  if (event.sourceRef.room) {
    const current = await currentRoomWork(tx, event, campaignId, generationSeen, now);
    return current.kind === "held" ? current.reason : null;
  }
  if (event.sourceRef.incomingCommentId === undefined) return null;
  const [incoming] = await tx.select().from(incomingComments).where(eq(incomingComments.id, event.sourceRef.incomingCommentId));
  if (!incoming) return "reply_gone";
  if (!await isRoomThreadReply(tx, incoming)) return null;
  const refused = await roomContinuationRefusal(tx, incoming, campaignId, now);
  if (refused) return refused;
  const [conversation] = await tx.select().from(conversations).where(eq(conversations.id, event.conversationId));
  if (!conversation) return "conversation_gone";
  return candidateRefusal(tx, { channelId: conversation.channelId, campaignId, conversationId: conversation.id,
    authorProfileId: conversation.authorProfileId, generationSeen });
}
