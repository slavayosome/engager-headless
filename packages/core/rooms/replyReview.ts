import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import { campaigns, channels, messageDraftRevisions, messages, roomMembers } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { scopedStop } from "../actions/stops";
import { loadStrategy } from "../agentStep/select";
import { firstSendPending, type BindingMode } from "../strategy/catalog";
import { modeFor } from "../strategy/mode";
import { recordedLiveChecks } from "../liveChecks/records";
import { getSystemState } from "../ratelimit/killswitch";
import { readRoomReplySource, roomReplyKey } from "./replySource";

export type RoomReplyReview = {
  key: string;
  messageId: number;
  expectedRequestVersion: number;
  text: string;
  draftedAt: number;
  mode: BindingMode | null;
  why: string | null;
  likeWithSend: boolean;
  firstSendPending: boolean;
  readOnlyReason: string | null;
  redraftPending: boolean;
  redraftError?: string | null;
};

/** The draft remains reviewable after discovery expires; only current
 * Research may supply its explanation or authorize an approval. */
export async function readRoomReplyReview(tx: Tx, messageId: number, now = Date.now()): Promise<RoomReplyReview | null> {
  const [row] = await tx.select({ message: messages, campaign: campaigns, channel: channels }).from(messages)
    .innerJoin(campaigns, eq(campaigns.id, messages.campaignId))
    .innerJoin(channels, eq(channels.id, campaigns.channelId)).where(eq(messages.id, messageId));
  // Only a step's draft is reviewed: a reply under a lead's comment is the
  // owner's own, pressed on Leads, and never a step's.
  if (!row || row.message.kind !== "room_reply" || row.message.status !== "proposed" || row.message.workerRunId === null ||
    row.message.roomReplyTarget?.selectedBy !== "worker") return null;
  const target = row.message.roomReplyTarget;
  const { message, campaign, channel } = row;
  let why: string | null = null;
  let readOnlyReason: string | null = target ? null : "This draft's original comment is no longer available.";
  if (target) {
    try {
      const source = await readRoomReplySource(tx, { roomMemberId: target.roomMemberId,
        parentCommentUrn: target.parentCommentUrn }, { selectedBy: target.selectedBy, now });
      if (source.campaignId !== campaign.id || source.memberUrn !== target.memberUrn ||
        source.profileId !== message.targetProfileId || roomReplyKey(source) !== message.dedupeKey) {
        throw new AppError("room_reply_target_changed", "Review the recipient and exact comment again.", 409);
      }
      const [member] = await tx.select({ reason: roomMembers.reason }).from(roomMembers).where(eq(roomMembers.id, target.roomMemberId));
      why = member?.reason ?? null;
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      readOnlyReason = error.message;
    }
  }
  if ((await getSystemState(tx))?.killSwitch || await scopedStop(tx, { channelId: channel.id,
    campaignId: campaign.id, profileId: message.targetProfileId, origin: message.publishOrigin })) {
    readOnlyReason = "Sending is stopped. This draft is still here.";
  }
  if (campaign.status === "archived") readOnlyReason = "This campaign is archived.";
  const strategy = await loadStrategy(tx, campaign);
  const step = strategy?.document.steps?.find((entry) => entry.catalog_step === "meet_the_room");
  const mode = strategy && step ? (await modeFor(tx, { campaignId: campaign.id, capability: "reply_to_comment", target: "room_comment", stepId: step.step_id, now })).effective ?? "off" : "off";
  const [revision] = await tx.select({ createdAt: messageDraftRevisions.createdAt }).from(messageDraftRevisions)
    .where(and(eq(messageDraftRevisions.messageId, message.id), inArray(messageDraftRevisions.source, ["initial", "redraft", "variant_swap"])))
    .orderBy(desc(messageDraftRevisions.revision)).limit(1);
  return { key: createHash("sha256").update(JSON.stringify([campaign.organizationId, message.id])).digest("hex"),
    messageId: message.id, expectedRequestVersion: message.redraftRequestVersion,
    text: message.finalText ?? message.proposedText, draftedAt: revision?.createdAt ?? message.createdAt, mode, why,
    likeWithSend: message.likeWithSend ?? true,
    firstSendPending: firstSendPending("room_reply", await recordedLiveChecks(tx, channel.id)),
    readOnlyReason, redraftPending: message.redraftRequestId !== null, redraftError: message.error };
}
