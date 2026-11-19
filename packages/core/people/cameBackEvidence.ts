import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { incomingComments, conversationEvents, conversations, type ConversationEventType } from "@engager/database/schema";

export const CAME_BACK_CONVERSATION_EVENTS = [
  "invitation_accepted",
  "inbound_message_observed",
] as const satisfies readonly ConversationEventType[];

/** Activity and search yield credit the same observed replies and receipts. */
export function cameBackRepliesSince(since: number, ids: number[] | null) {
  return and(
    eq(incomingComments.source, "our_comment_thread"),
    isNull(incomingComments.removedAt),
    gte(incomingComments.receivedAt, since),
    sql`not exists (select 1 from messages parent
      where parent.id = ${incomingComments.parentMessageId} and parent.kind = 'room_reply'
        and (parent.status <> 'posted' or nullif(parent.external_urn, '') is null))`,
    ids ? inArray(incomingComments.campaignId, ids) : undefined,
  );
}

/** Read joined to the conversation; a room-origin accept needs a confirmed invite. */
export function cameBackEventsSince(since: number, ids: number[] | null) {
  return and(
    inArray(conversationEvents.type, [...CAME_BACK_CONVERSATION_EVENTS]),
    gte(conversationEvents.occurredAt, since),
    sql`(${conversations.openedFrom} is null or ${conversationEvents.type} <> 'invitation_accepted'
      or exists (select 1 from actions invitation
        where invitation.conversation_id = ${conversations.id} and invitation.kind = 'invite' and invitation.status = 'confirmed'))`,
    ids ? inArray(conversations.owningCampaignId, ids) : undefined,
  );
}
