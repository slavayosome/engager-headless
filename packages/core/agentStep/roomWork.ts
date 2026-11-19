import { createHash } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { campaigns, discoveredPosts, conversationEvents, conversations, roomMembers, stepRuns, type ConversationEventRow,
  type RoomWorkBinding } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { evaluateEligibility, DEFAULT_DM_POLICY, DEFAULT_ELIGIBILITY } from "../conversations/eligibility";
import { audienceProfile } from "../audience/model";
import { openRoomConversation } from "../conversations/record";
import { inspectRoomOpportunity, type RoomOpportunityCheck } from "../rooms/opportunities";
import { roomReplyKey, type RoomReplySource } from "../rooms/replySource";
import type { ConversationItem } from "./select";

const digestOf = (source: RoomReplySource) => createHash("sha256")
  .update(JSON.stringify(["room_member_spotted", roomReplyKey(source)])).digest("hex");

/** A model can only work the immutable room selection written on its event.
 * Refreshing Research never silently changes that selection. */
export async function currentRoomWork(
  tx: Tx,
  event: Pick<ConversationEventRow, "id" | "conversationId" | "sourceRef">,
  campaignId: number,
  generationSeen: number,
  now = Date.now(),
  options: { sendingMessageId?: number; redraftingMessageId?: number } = {},
): Promise<RoomOpportunityCheck> {
  const binding = event.sourceRef.room;
  if (!binding || binding.campaignId !== campaignId) return { kind: "held", reason: "room_work_missing" };
  const [checkpoint] = await tx.select({ id: stepRuns.id }).from(stepRuns)
    .where(and(eq(stepRuns.conversationId, event.conversationId), eq(stepRuns.eventId, event.id),
      eq(stepRuns.stepId, binding.stepId), eq(stepRuns.workKey, `event:${event.id}`)));
  const current = await inspectRoomOpportunity(tx, { campaignId, roomMemberId: binding.target.roomMemberId,
    parentCommentUrn: binding.target.parentCommentUrn, generationSeen, existingStepRunId: checkpoint?.id,
    sendingMessageId: options.sendingMessageId, redraftingMessageId: options.redraftingMessageId }, now);
  if (current.kind === "held") return current;
  const { source, stepId, strategyVersion, painId, conversationId } = current.opportunity;
  const { organizationId: _org, campaignId: _campaign, channelId, ...target } = source;
  const sameTarget = Object.entries(binding.target).every(([key, value]) =>
    target[key as keyof typeof target] === value);
  if (!sameTarget || channelId !== binding.channelId || stepId !== binding.stepId ||
    strategyVersion !== binding.strategyVersion || painId !== binding.painId || conversationId !== event.conversationId ||
    binding.evidenceHash !== await roomEvidenceHash(tx, source, painId)) {
    return { kind: "held", reason: "room_work_changed" };
  }
  return current;
}

async function roomEvidenceHash(tx: Tx, source: RoomReplySource, painId: string) {
  const [row] = await tx.select({ member: roomMembers, post: discoveredPosts, campaign: campaigns }).from(roomMembers)
    .innerJoin(discoveredPosts, eq(discoveredPosts.id, roomMembers.discoveredPostId))
    .innerJoin(campaigns, eq(campaigns.id, discoveredPosts.campaignId)).where(eq(roomMembers.id, source.roomMemberId));
  if (!row) return null;
  const comment = row.member.comments.find((entry) => entry.commentUrn === source.parentCommentUrn);
  const pain = audienceProfile(row.campaign).pains.find((entry) => entry.id === painId && entry.status === "active");
  return createHash("sha256").update(JSON.stringify({ source, comment, name: row.member.name,
    headline: row.member.headline, why: row.member.reason, pain,
    post: [row.post.authorName, row.post.contentText] })).digest("hex");
}

/** Existing work first, then current fits. Conversation + event commit together;
 * an existing conversation does not mean the person was contacted. The checkpoint
 * and its message own all later outcomes, including an explicit Skip. */
export async function roomWork(
  tx: Tx,
  input: { campaignId: number; generationSeen: number; limit: number; taken: ReadonlySet<number> },
  now = Date.now(),
): Promise<ConversationItem[]> {
  if (input.limit <= 0) return [];
  const items: ConversationItem[] = [];
  const taken = new Set(input.taken);
  const events = await tx.select({ event: conversationEvents, conversation: conversations }).from(conversationEvents)
    .innerJoin(conversations, eq(conversations.id, conversationEvents.conversationId))
    .where(and(eq(conversationEvents.type, "room_member_spotted"),
      sql`${conversationEvents.sourceRef}->'room'->>'campaignId' = ${String(input.campaignId)}`))
    .orderBy(asc(conversationEvents.id));
  const known = new Set(events.map(({ event }) => event.digest));
  for (const { event, conversation } of events) {
    if (taken.has(conversation.id) || conversation.closedReason !== null || conversation.opsStatus !== "runnable") continue;
    const [checkpoint] = await tx.select().from(stepRuns).where(and(eq(stepRuns.conversationId, conversation.id),
      eq(stepRuns.eventId, event.id), eq(stepRuns.stepId, event.sourceRef.room!.stepId)));
    const reopenable = checkpoint?.status === "blocked" &&
      /^(guard:(held|paused):|barrier:)/.test(checkpoint.blockedReason ?? "");
    if (checkpoint && checkpoint.status !== "running" && !reopenable) continue;
    const current = await currentRoomWork(tx, event, input.campaignId, input.generationSeen, now);
    if (current.kind === "held") continue;
    items.push({ origin: "room", conversationId: conversation.id, eventId: event.id,
      stepId: current.opportunity.stepId, workKey: `event:${event.id}` });
    taken.add(conversation.id);
    if (items.length === input.limit) return items;
  }
  const members = await tx.select({ member: roomMembers }).from(roomMembers)
    .innerJoin(discoveredPosts, eq(discoveredPosts.id, roomMembers.discoveredPostId))
    .where(and(eq(discoveredPosts.campaignId, input.campaignId), eq(roomMembers.fit, "fits")))
    .orderBy(asc(roomMembers.id));
  for (const { member } of members) {
    for (const comment of member.comments) {
      const current = await inspectRoomOpportunity(tx, { campaignId: input.campaignId, roomMemberId: member.id,
        parentCommentUrn: comment.commentUrn, generationSeen: input.generationSeen }, now);
      if (current.kind === "held") continue;
      const { source, stepId, strategyVersion, painId, conversationId } = current.opportunity;
      const digest = digestOf(source);
      if (known.has(digest) || (conversationId !== null && taken.has(conversationId))) continue;
      const conversation = await openRoomConversation(tx, { campaignId: input.campaignId, channelId: source.channelId,
        profileId: source.profileId, discoveredPostId: source.discoveredPostId, now });
      const { organizationId: _org, campaignId, channelId, ...target } = source;
      const evidenceHash = await roomEvidenceHash(tx, source, painId);
      if (!evidenceHash) continue;
      const binding: RoomWorkBinding = { target, campaignId, channelId, stepId, strategyVersion, painId, evidenceHash };
      const decision = evaluateEligibility({ event: { type: "room_member_spotted", occurredAt: now },
        conversation: { relationship: conversation.relationship, relationshipCheckedAt: conversation.relationshipCheckedAt,
          opsStatus: conversation.opsStatus, opsStatusAt: conversation.opsStatusAt, closedReason: conversation.closedReason,
          hasInterest: conversation.interestEvidenceEventId !== null, invited: false },
        excluded: false, policy: { eligibility: DEFAULT_ELIGIBILITY, dm: DEFAULT_DM_POLICY } });
      const [event] = await tx.insert(conversationEvents).values({ conversationId: conversation.id, type: "room_member_spotted",
        source: "room", sourceRef: { room: binding }, digest, occurredAt: source.evidenceReadAt, observedAt: now,
        attribution: { method: "thread_read", profileId: source.profileId }, decision,
        retentionClass: "audit", expiresAt: null }).onConflictDoNothing().returning();
      if (!event) continue;
      items.push({ origin: "room", conversationId: conversation.id, eventId: event.id, stepId, workKey: `event:${event.id}` });
      known.add(digest);
      taken.add(conversation.id);
      if (items.length === input.limit) return items;
    }
  }
  return items;
}
