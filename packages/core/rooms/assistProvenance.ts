import { and, desc, eq, gt, sql } from "drizzle-orm";
import { retentionWindow } from "@engager/common/text-provenance";
import { roomReplyAssists } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { ROOM_RETENTION_MS } from "./eligibility";
import { roomReplyDraftKey, roomReplyKey, type RoomReplySource } from "./replySource";

export type RoomAssistDeliverable = "reply" | "invite_note";

/** Invite provenance follows the exact account, campaign and person even
 * when their public profile was resolved after a member-only request. */
export async function roomInviteAssistTexts(tx: Tx, source: {
  campaign: { id: number }; channelId: number; accountProfileId: string; member: { memberUrn: string | null };
}): Promise<string[]> {
  if (!source.member.memberUrn) return [];
  const rows = await tx.select({ texts: roomReplyAssists.texts }).from(roomReplyAssists).where(and(
    eq(roomReplyAssists.campaignId, source.campaign.id), eq(roomReplyAssists.channelId, source.channelId),
    eq(roomReplyAssists.deliverable, "invite_note"), gt(roomReplyAssists.evidenceExpiresAt, Date.now()),
    sql`${roomReplyAssists.target} ->> 'accountProfileId' = ${source.accountProfileId}`,
    sql`${roomReplyAssists.target} ->> 'memberUrn' = ${source.member.memberUrn}`,
  )).orderBy(desc(roomReplyAssists.updatedAt)).limit(20);
  return retentionWindow(rows.flatMap((row) => row.texts));
}

export async function roomAssistTexts(tx: Tx, source: RoomReplySource, deliverable: RoomAssistDeliverable): Promise<string[]> {
  const [row] = await tx.select().from(roomReplyAssists).where(and(
    eq(roomReplyAssists.targetKey, roomReplyDraftKey(source.campaignId, roomReplyKey(source))),
    eq(roomReplyAssists.deliverable, deliverable),
  ));
  return row && row.target.memberUrn === source.memberUrn && row.evidenceExpiresAt > Date.now() ? row.texts : [];
}

/** Caller holds the room evidence lock. Offers never write an owner draft. */
export async function recordRoomAssist(tx: Tx, source: RoomReplySource, deliverable: RoomAssistDeliverable, text: string) {
  const texts = retentionWindow([text, ...await roomAssistTexts(tx, source, deliverable)]);
  const { organizationId, channelId, campaignId, ...target } = source;
  const values = { target, texts, evidenceExpiresAt: source.evidenceReadAt + ROOM_RETENTION_MS, updatedAt: Date.now() };
  await tx.insert(roomReplyAssists).values({ organizationId, channelId, campaignId, ...values, deliverable,
    targetKey: roomReplyDraftKey(campaignId, roomReplyKey(source)) }).onConflictDoUpdate({
    target: [roomReplyAssists.organizationId, roomReplyAssists.targetKey, roomReplyAssists.deliverable], set: values,
  });
}
