import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import { campaigns, channels, discoveredPosts, messages, roomMembers, roomReplyDrafts } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { scopedStop } from "../actions/stops";
import { boxKey, composerFor, type ComposerAngle } from "../composer/drafts";
import { firstSendPending } from "../strategy/catalog";
import { recordedLiveChecks } from "../liveChecks/records";
import { getSystemState } from "../ratelimit/killswitch";
import { canOwnerReplyAfterSkip, readRoomReplySource, roomReplyDraftKey, roomReplyKey } from "./replySource";
import { roomReplyDelivery, type RoomReplyDelivery } from "./replyReceipt";
import { readRoomReplyReview, type RoomReplyReview } from "./replyReview";

export type RoomReplyTarget = { roomMemberId: number; parentCommentUrn: string };
export type RoomReplyComposer = {
  key: string;
  /** The reply box's composer key, the one its asks name, and the angles in
   *  its bar: the agent's drafts for this comment, one each. */
  box: string;
  angles: ComposerAngle[];
  draft: { id: number; revision: number; text: string } | null;
  message: RoomReplyDelivery | null;
  readOnlyReason: string | null;
  firstSendPending: boolean;
  review?: RoomReplyReview;
  canReplyAfterSkip?: true;
};

/** Read saved words even when a Stop now holds the composer. The action target key
 * belongs to the account and campaign; a display name never selects a draft. */
export async function readRoomReplyComposer(tx: Tx, input: RoomReplyTarget): Promise<RoomReplyComposer> {
  const [row] = await tx.select({ member: roomMembers, campaign: campaigns, channel: channels, post: discoveredPosts })
    .from(roomMembers).innerJoin(discoveredPosts, eq(discoveredPosts.id, roomMembers.discoveredPostId))
    .innerJoin(campaigns, eq(campaigns.id, discoveredPosts.campaignId))
    .innerJoin(channels, eq(channels.id, campaigns.channelId)).where(eq(roomMembers.id, input.roomMemberId));
  if (!row || !row.member.comments.some((comment) => comment.commentUrn === input.parentCommentUrn)) {
    throw new AppError("room_target_missing", "That comment is no longer available. Read the room again.", 404);
  }
  const replyKey = roomReplyKey({ accountProfileId: row.channel.externalAccountId ?? "", postUrn: row.post.postUrn,
    parentCommentUrn: input.parentCommentUrn });
  const targetKey = roomReplyDraftKey(row.campaign.id, replyKey);
  const box = boxKey({ kind: "room", targetKey });
  const { angles } = (await composerFor(tx, [box])).get(box)!;
  const [draft] = await tx.select().from(roomReplyDrafts).where(and(eq(roomReplyDrafts.campaignId, row.campaign.id),
    eq(roomReplyDrafts.targetKey, targetKey)));
  const [message] = await tx.select().from(messages).where(eq(messages.dedupeKey, replyKey));
  let readOnlyReason: string | null = null;
  try {
    await readRoomReplySource(tx, input, { selectedBy: "owner" });
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    readOnlyReason = error.message;
  }
  if (draft?.erasedAt != null) readOnlyReason = "This person's discovery evidence was forgotten. Your saved words remain here.";
  if (draft?.target && draft.target.memberUrn !== row.member.memberUrn) {
    readOnlyReason = "The author of this comment changed. Review the room again before replying.";
  }
  if (row.campaign.status === "archived") readOnlyReason = "This campaign is archived. Your saved words remain here.";
  if ((await getSystemState(tx))?.killSwitch || await scopedStop(tx, { channelId: row.channel.id,
    campaignId: row.campaign.id, profileId: row.member.profileId, origin: "owner" })) {
    readOnlyReason = "Sending is stopped. Your saved reply is read-only.";
  }
  if (message && message.campaignId !== row.campaign.id) {
    readOnlyReason = "Another campaign already has this reply. Review it in that conversation.";
  }
  const review = message?.campaignId === row.campaign.id ? await readRoomReplyReview(tx, message.id) : null;
  return {
    key: createHash("sha256").update(JSON.stringify([row.campaign.organizationId, targetKey])).digest("hex"),
    box,
    angles,
    draft: draft ? { id: draft.id, revision: draft.revision, text: draft.text } : null,
    message: message && message.campaignId === row.campaign.id
      ? await roomReplyDelivery(tx, { message, campaign: row.campaign, channel: row.channel, holdReason: readOnlyReason }) : null,
    readOnlyReason,
    firstSendPending: firstSendPending("room_reply", await recordedLiveChecks(tx, row.channel.id)),
    ...(review ? { review } : {}),
    ...(message?.campaignId === row.campaign.id && canOwnerReplyAfterSkip(message) ? { canReplyAfterSkip: true as const } : {}),
  };
}
