import { and, eq } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import { campaigns, channels, jobs, messages, roomReplyDrafts, type Message } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { scopedStop } from "../actions/stops";
import { getSystemState } from "../ratelimit/killswitch";
import { roomReplyDraftKey } from "./replySource";
import { readRoomReplyReview, type RoomReplyReview } from "./replyReview";

export type RoomReplyDelivery = Pick<Message, "id" | "status" | "externalUrn" | "redraftRequestVersion" | "publishOrigin"> & {
  text: string;
  scheduledAt: number | null;
  reason: string | null;
};

/** A queued send keeps its actual schedule or named hold. A source's expiry
 * is not a delivery hold: already-selected owner intent has its own gates. */
export async function roomReplyDelivery(tx: Tx, input: {
  message: Message;
  campaign: typeof campaigns.$inferSelect;
  channel: typeof channels.$inferSelect;
  holdReason?: string | null;
}): Promise<RoomReplyDelivery> {
  const { message, campaign, channel } = input;
  const [job] = message.status === "approved" ? await tx.select({ nextRunAt: jobs.nextRunAt, lastError: jobs.lastError })
    .from(jobs).where(and(eq(jobs.organizationId, campaign.organizationId), eq(jobs.idempotencyKey, `post:${message.id}`),
      eq(jobs.status, "queued"))) : [];
  const hold = message.status === "approved" ? input.holdReason ?? (!channel.writesEnabled
    ? "Account sending is off. Your reply stays queued." : message.publishOrigin !== "owner" && campaign.status === "paused"
      ? "Waiting for this campaign to resume." : null) : null;
  const scheduledAt = hold || message.scheduledAt === null ? null : Math.max(message.scheduledAt, job?.nextRunAt ?? 0);
  return {
    id: message.id, status: message.status, externalUrn: message.externalUrn, publishOrigin: message.publishOrigin,
    redraftRequestVersion: message.redraftRequestVersion, text: message.finalText ?? message.proposedText,
    scheduledAt, reason: hold ?? message.error ?? job?.lastError ?? (message.status === "approved" && scheduledAt === null
      ? "Waiting for an available account slot." : null),
  };
}

export type RoomReplyReceipt = {
  delivery: RoomReplyDelivery;
  savedAt: number;
  receiptUrl: string | null;
  draft: { text: string } | null;
  checkUnavailableReason: string | null;
  review?: RoomReplyReview;
};

/** A message owns the minimum receipt binding independently of expiring
 * room evidence. This read cannot recreate a person, a draft or a send. */
export async function readRoomReplyReceipt(tx: Tx, messageId: number): Promise<RoomReplyReceipt> {
  if (!Number.isSafeInteger(messageId) || messageId <= 0) {
    throw new AppError("room_reply_invalid", "Choose the saved reply to review.", 400);
  }
  const [row] = await tx.select({ message: messages, campaign: campaigns, channel: channels }).from(messages)
    .innerJoin(campaigns, eq(campaigns.id, messages.campaignId)).innerJoin(channels, eq(channels.id, campaigns.channelId))
    .where(and(eq(messages.id, messageId), eq(messages.kind, "room_reply")));
  if (!row?.message.roomReplyTarget) throw new AppError("room_reply_missing", "That reply is no longer available.", 404);
  const { message, campaign, channel } = row;
  const target = message.roomReplyTarget!;
  const accountMatches = channel.externalAccountId === target.accountProfileId &&
    (!channel.executionAccountId || channel.executionAccountId === target.accountProfileId);
  const checkUnavailableReason = accountMatches ? null : "Reconnect the account that made this reply so Engager can finish recording what happened to it.";
  const stopped = (await getSystemState(tx))?.killSwitch || await scopedStop(tx, { channelId: channel.id,
    campaignId: campaign.id, profileId: target.profileId, origin: message.publishOrigin });
  const [draft] = message.dedupeKey ? await tx.select({ text: roomReplyDrafts.text }).from(roomReplyDrafts)
    .where(and(eq(roomReplyDrafts.campaignId, campaign.id), eq(roomReplyDrafts.targetKey, roomReplyDraftKey(campaign.id, message.dedupeKey)))) : [];
  const holdReason = checkUnavailableReason ?? (stopped ? "Sending is stopped. Your reply stays queued."
    : campaign.status === "archived" ? "This campaign is archived." : null);
  const review = await readRoomReplyReview(tx, message.id);
  return { delivery: await roomReplyDelivery(tx, { message, campaign, channel, holdReason }), savedAt: message.createdAt,
    receiptUrl: message.status === "posted" && message.externalUrn
      ? `https://www.linkedin.com/feed/update/${encodeURIComponent(target.postUrn)}?commentUrn=${encodeURIComponent(message.externalUrn)}` : null,
    draft: draft ?? null, checkUnavailableReason, ...(review ? { review } : {}) };
}
