import { and, eq, isNull, sql } from "drizzle-orm";
import { incomingComments, conversationEvents, conversations, messages, roomMembers, stepRuns } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { untrusted } from "../ai/prompts";
import type { LoadedStrategy } from "../agentStep/select";
import { modeFor } from "../strategy/mode";
import { roomReplyKey } from "./replySource";
import { roomThreadReceipt } from "./thread";

/** A room invitation follows an eligible answer to our confirmed reply and
 * Reply when they answer's achieved checkpoint. A spotted event alone earns none. */
export async function roomInviteExchange(tx: Tx, input: {
  campaignId: number; conversationId: number; eventId: number; strategy: LoadedStrategy;
}) {
  const [event] = await tx.select().from(conversationEvents).where(and(eq(conversationEvents.id, input.eventId),
    eq(conversationEvents.conversationId, input.conversationId)));
  if (!event || !["reply_observed", "reply_edited"].includes(event.type) ||
    event.decision?.decision !== "eligible" || event.sourceRef.incomingCommentId === undefined) return null;
  const [newer] = await tx.select({ id: conversationEvents.id }).from(conversationEvents).where(eq(conversationEvents.supersedesEventId, event.id));
  if (newer) return null;
  const [conversation] = await tx.select().from(conversations).where(eq(conversations.id, input.conversationId));
  const [incoming] = await tx.select().from(incomingComments).where(and(
    eq(incomingComments.id, event.sourceRef.incomingCommentId), eq(incomingComments.campaignId, input.campaignId),
    isNull(incomingComments.removedAt)));
  if (!conversation || !incoming || incoming.authorProfileId !== conversation.authorProfileId) return null;
  const receipt = await roomThreadReceipt(tx, incoming);
  if (!receipt) return null;
  const [root] = await tx.select().from(messages).where(and(eq(messages.campaignId, input.campaignId),
    eq(messages.kind, "room_reply"), eq(messages.status, "posted"), eq(messages.externalUrn, receipt),
    eq(messages.targetProfileId, conversation.authorProfileId)));
  if (!root?.roomReplyTarget) return null;
  const initial = await tx.select().from(conversationEvents).where(and(eq(conversationEvents.conversationId, conversation.id),
    eq(conversationEvents.type, "room_member_spotted")));
  const selected = initial.find((entry) => entry.sourceRef.room?.campaignId === input.campaignId &&
    entry.sourceRef.room.channelId === conversation.channelId &&
    roomReplyKey(entry.sourceRef.room.target) === root.dedupeKey &&
    entry.sourceRef.room.target.profileId === conversation.authorProfileId);
  if (!selected?.sourceRef.room) return null;
  const handle = input.strategy.document.steps?.find((step) => step.catalog_step === "handle_reply");
  if (!handle) return null;
  const [achieved] = await tx.select({ id: stepRuns.id }).from(stepRuns).where(and(
    eq(stepRuns.campaignId, input.campaignId), eq(stepRuns.conversationId, conversation.id),
    eq(stepRuns.eventId, event.id), eq(stepRuns.stepId, handle.step_id), eq(stepRuns.status, "achieved")));
  if (!achieved) return null;
  const [member] = await tx.select().from(roomMembers).where(eq(roomMembers.id, selected.sourceRef.room.target.roomMemberId));
  const original = member?.comments.find((comment) => comment.commentUrn === root.roomReplyTarget!.parentCommentUrn &&
    comment.memberUrn === root.roomReplyTarget!.memberUrn);
  if (!original) return null;
  return { event, root, text: [untrusted("THEIR ORIGINAL COMMENT", original.text),
    untrusted("OUR CONFIRMED ROOM REPLY", root.finalText ?? root.proposedText),
    untrusted("THEIR VERIFIED ANSWER", incoming.text)].join("\n\n") };
}

/** An enabled Connect owns Invite. Otherwise Meet can own this handoff,
 * irrespective of either step's visual position on the canvas. */
export async function roomInviteOwner(tx: Tx, campaignId: number, strategy: LoadedStrategy, now = Date.now()) {
  for (const catalog of ["connect", "meet_the_room"] as const) {
    const step = strategy.document.steps?.find((entry) => entry.catalog_step === catalog);
    if (!step) continue;
    const mode = (await modeFor(tx, { campaignId, capability: "send_invitation", stepId: step.step_id, now })).effective;
    if (mode === "review" || mode === "auto") return step;
  }
  return null;
}

export async function conversationHasRoomWork(tx: Tx, conversationId: number, campaignId: number) {
  const [room] = await tx.select({ id: conversationEvents.id }).from(conversationEvents).where(and(
    eq(conversationEvents.conversationId, conversationId), eq(conversationEvents.type, "room_member_spotted"),
    sql`${conversationEvents.sourceRef}->'room'->>'campaignId' = ${String(campaignId)}`)).limit(1);
  return !!room;
}
