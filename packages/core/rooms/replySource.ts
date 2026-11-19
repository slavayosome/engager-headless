import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import { campaigns, candidateResearch, channels, discoveredPosts, roomMembers, roomSnapshots, type Message, type RoomReplyTargetJson, type RoomSourcedReplyTarget } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { readLeadReplySource, type LeadReplySource } from "../leads/replySource";
import { assertPostUrn, normalizePostUrn } from "../linkedin/postUrn";
import { memberId } from "../people/key";
import { lockRoomEvidence, ROOM_RETENTION_MS } from "./eligibility";
import { selectRoomPeople } from "./room";

export type RoomReplySelection = RoomSourcedReplyTarget["selectedBy"];

/** Declining an unattempted step proposal closes that opportunity, not the
 * owner's ability to write their own reply later. Attempted sends stay closed. */
export function canOwnerReplyAfterSkip(message: Message): boolean {
  return message.kind === "room_reply" && message.status === "rejected" && message.workerRunId !== null &&
    message.roomReplyTarget?.selectedBy === "worker" && message.externalUrn === null && message.lastAttemptAt === null;
}

/** A frozen target for one public reply. The displayed name never binds it.
 * Keep this minimum separately from expiring comment text once work exists. */
export type RoomReplySource = RoomSourcedReplyTarget & {
  organizationId: string;
  channelId: number;
  campaignId: number;
};

/** What the reply gate saves, queues and sends against: a comment read from a
 *  room, or from the thread read that found a lead. */
export type ReplySource = RoomReplySource | LeadReplySource;

function unavailable(code: string, detail: string): never {
  throw new AppError(code, detail, 409);
}

/** Resolve the exact comment the composer selected before creating durable
 * work. This reads only stored evidence. Send-time authorization and the
 * provider's fresh identity check remain separate requirements. */
export async function readRoomReplySource(
  tx: Tx,
  input: { roomMemberId: number; parentCommentUrn: string },
  // selectedBy comes from the authorized surface, never a model/tool payload.
  options: { selectedBy?: RoomReplySelection; now?: number } = {},
): Promise<RoomReplySource> {
  const now = options.now ?? Date.now();
  const selectedBy = options.selectedBy ?? "worker";
  if (!Number.isSafeInteger(input.roomMemberId) || input.roomMemberId <= 0 || !input.parentCommentUrn.trim()) {
    unavailable("room_target_invalid", "Select the person and the exact comment to answer.");
  }
  await lockRoomEvidence(tx);
  const [source] = await tx.select({ member: roomMembers, snapshot: roomSnapshots, post: discoveredPosts,
    campaign: campaigns, channel: channels, research: candidateResearch })
    .from(roomMembers)
    .innerJoin(roomSnapshots, eq(roomSnapshots.id, roomMembers.snapshotId))
    .innerJoin(discoveredPosts, eq(discoveredPosts.id, roomMembers.discoveredPostId))
    .innerJoin(campaigns, eq(campaigns.id, discoveredPosts.campaignId))
    .innerJoin(channels, eq(channels.id, campaigns.channelId))
    .innerJoin(candidateResearch, eq(candidateResearch.discoveredPostId, discoveredPosts.id))
    .where(eq(roomMembers.id, input.roomMemberId));
  if (!source) unavailable("room_target_missing", "That person or room is no longer available.");
  const { member, snapshot, post, campaign, channel, research } = source;
  if (snapshot.campaignId !== campaign.id || snapshot.discoveredPostId !== post.id) {
    unavailable("room_source_mismatch", "That room does not belong to this campaign.");
  }
  const account = channel.externalAccountId?.trim();
  if (!account || (channel.executionAccountId && channel.executionAccountId !== account)) {
    unavailable("room_account_unavailable", "Reconnect the LinkedIn account before choosing this reply target.");
  }
  const comment = member.comments.find((entry) => entry.commentUrn === input.parentCommentUrn);
  if (!comment || memberId(comment.memberUrn) === null || comment.memberUrn !== member.memberUrn) {
    unavailable("room_author_unresolved", "Research needs to identify the author of this exact comment.");
  }
  if (comment.isOwner || comment.authorIsCompany || comment.authorProfileId === account || member.memberUrn === account) {
    unavailable("room_author_not_eligible", "Choose another person's comment to answer.");
  }
  if (snapshot.readAt <= now - ROOM_RETENTION_MS || member.ownerSkippedAt !== null) {
    unavailable("room_evidence_unavailable", "This room evidence expired or was skipped. Read the room again.");
  }
  const people = await selectRoomPeople(tx, campaign, {
    postUrn: post.postUrn, fullText: post.contentText ?? "", counts: { comments: member.comments.length, reactions: 0, reposts: 0 },
    comments: member.comments,
  }, post.authorProfileId);
  const person = people.find((entry) => entry.memberUrn === member.memberUrn &&
    entry.comments.some((entryComment) => entryComment.commentUrn === comment.commentUrn));
  if (!person) unavailable("room_person_excluded", "This person cannot be contacted from the room.");
  if (selectedBy !== "owner" && (member.fit !== "fits" || snapshot.audienceRevision !== campaign.audienceRevision ||
    research.roomSnapshotId !== snapshot.id || research.verdict !== "confirmed")) {
    unavailable("room_evidence_stale", "Research needs to check this person against the current Audience.");
  }
  if (selectedBy !== "owner" && research.joinLens === "author_maybe") {
    unavailable("room_left_to_owner", "Research left this post to the owner; only the owner can join its room.");
  }
  const postUrn = normalizePostUrn(post.postUrn);
  assertPostUrn(postUrn);
  return {
    organizationId: campaign.organizationId, channelId: channel.id, accountProfileId: account,
    campaignId: campaign.id, discoveredPostId: post.id, postUrn, parentCommentUrn: comment.commentUrn,
    personKey: person.personKey, profileId: person.profileId, memberUrn: comment.memberUrn!, roomMemberId: member.id,
    snapshotId: snapshot.id, audienceRevision: snapshot.audienceRevision, evidenceReadAt: snapshot.readAt, selectedBy,
  };
}

/** A frozen target read again from where its comment was read: its room, or
 *  the lead's signal. Every save, queue and send asks this again. */
export function readReplySource(tx: Tx, target: RoomReplyTargetJson, options: { now?: number } = {}): Promise<ReplySource> {
  return target.source === "lead"
    ? readLeadReplySource(tx, target.signalId, options)
    : readRoomReplySource(tx, { roomMemberId: target.roomMemberId, parentCommentUrn: target.parentCommentUrn },
      { selectedBy: target.selectedBy, now: options.now });
}

/** Whether two targets name the same lead's same signal; never for a room's. */
export function sameLeadSignal(a: RoomReplyTargetJson, b: RoomReplyTargetJson): boolean {
  return a.source === "lead" && b.source === "lead" && a.leadId === b.leadId && a.signalId === b.signalId;
}

/** Campaigns share one account's reply to a comment. A length-delimited JSON
 * tuple avoids separator collisions, and excludes text and campaign identity. */
export function roomReplyKey(target: Pick<RoomReplyTargetJson, "accountProfileId" | "postUrn" | "parentCommentUrn">): string {
  return `room_reply:${createHash("sha256").update(JSON.stringify([
    target.accountProfileId, normalizePostUrn(target.postUrn), target.parentCommentUrn,
  ])).digest("hex")}`;
}

export function roomReplyDraftKey(campaignId: number, replyKey: string): string {
  return createHash("sha256").update(JSON.stringify([campaignId, replyKey])).digest("hex");
}
