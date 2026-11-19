import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { campaigns, channels, discoveredPosts, messages, rateLimitLedger, roomReplyDrafts, type Message } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { FREE_WORKSPACE_LEDGER_SOURCE, hasBlockingSendHistory } from "./importedHistory";
import { normalizePostUrn } from "../linkedin/postUrn";

const LIVE_COMMENT_STATUSES: Message["status"][] = ["proposed", "approved", "posting", "posted", "needs_review"];
type RoomAccount = { channelId: number; accountProfileId: string; postUrn: string };

/** Both lanes serialize on the account until their draft batch commits.
 * One account lock also avoids opposite post orders deadlocking two batches. */
export async function lockRoomVoice(tx: Tx, room: Pick<RoomAccount, "accountProfileId">) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('room_voice:' || current_setting('app.current_org')),
    hashtext(${room.accountProfileId}))`);
}

/** A top-level comment already speaks for this account in the room. */
export async function roomHasComment(tx: Tx, room: RoomAccount): Promise<boolean> {
  const [comment] = await tx.select({ id: messages.id }).from(messages)
    .innerJoin(discoveredPosts, eq(discoveredPosts.id, messages.discoveredPostId))
    .innerJoin(campaigns, eq(campaigns.id, messages.campaignId))
    .innerJoin(channels, eq(channels.id, campaigns.channelId))
    .where(and(eq(messages.kind, "comment"), inArray(messages.status, LIVE_COMMENT_STATUSES),
      eq(discoveredPosts.postUrn, normalizePostUrn(room.postUrn)),
      or(eq(channels.id, room.channelId), eq(channels.externalAccountId, room.accountProfileId))))
    .limit(1);
  if (comment !== undefined) return true;
  // Imported uncertainty deliberately has no message row. Its account's
  // retained markers still mean a comment may be in this room, including a
  // malformed marker which the canonical safety reader keeps blocking.
  const retained = await tx.select({ media: discoveredPosts.media }).from(discoveredPosts)
    .innerJoin(campaigns, eq(campaigns.id, discoveredPosts.campaignId))
    .innerJoin(channels, eq(channels.id, campaigns.channelId))
    .where(and(eq(discoveredPosts.postUrn, normalizePostUrn(room.postUrn)),
      or(eq(channels.id, room.channelId), eq(channels.externalAccountId, room.accountProfileId))));
  if (retained.some((post) => hasBlockingSendHistory(post.media))) return true;
  // The org's one post row can belong to another account. Its words are
  // not evidence for this account, but this account's own imported meter is.
  const [imported] = await tx.select({ id: rateLimitLedger.id }).from(rateLimitLedger)
    .innerJoin(channels, eq(channels.id, rateLimitLedger.channelId))
    .where(and(eq(rateLimitLedger.action, "comment"),
      or(eq(channels.id, room.channelId), eq(channels.externalAccountId, room.accountProfileId)),
      sql`${rateLimitLedger.meta}->>'source' = ${FREE_WORKSPACE_LEDGER_SOURCE}`,
      sql`${rateLimitLedger.meta}->>'postUrn' = ${normalizePostUrn(room.postUrn)}`,
      sql`${rateLimitLedger.meta}->>'outcome' in ('posted', 'uncertain')`))
    .limit(1);
  return imported !== undefined;
}

/** Even an unqueued composer is the owner's work. Step selection and its
 * final reservation use the same account-scoped check under roomVoice. */
export async function roomHasOwnerDraft(tx: Tx, room: Pick<RoomAccount, "accountProfileId" | "postUrn"> & { parentCommentUrn: string }): Promise<boolean> {
  const [draft] = await tx.select({ id: roomReplyDrafts.id }).from(roomReplyDrafts).where(and(
    isNull(roomReplyDrafts.erasedAt), sql`length(btrim(${roomReplyDrafts.text})) > 0`,
    sql`${roomReplyDrafts.target}->>'accountProfileId' = ${room.accountProfileId}`,
    sql`${roomReplyDrafts.target}->>'postUrn' = ${normalizePostUrn(room.postUrn)}`,
    sql`${roomReplyDrafts.target}->>'parentCommentUrn' = ${room.parentCommentUrn}`,
  )).limit(1);
  return draft !== undefined;
}

/** A recent step-made room reply makes the separate comment ask for a yes.
 * Campaigns share the account's voice; an owner composer is not a step. */
export async function roomVoiceTaken(tx: Tx, room: RoomAccount, now: number): Promise<boolean> {
  const [reply] = await tx.select({ id: messages.id }).from(messages)
    .where(and(eq(messages.kind, "room_reply"), isNotNull(messages.workerRunId),
      inArray(messages.status, LIVE_COMMENT_STATUSES),
      sql`${messages.roomReplyTarget}->>'selectedBy' = 'worker'`,
      sql`${messages.roomReplyTarget}->>'accountProfileId' = ${room.accountProfileId}`,
      sql`${messages.roomReplyTarget}->>'postUrn' = ${normalizePostUrn(room.postUrn)}`,
      or(sql`${messages.createdAt} > ${now - 86_400_000}`, sql`${messages.postedAt} > ${now - 86_400_000}`)))
    .limit(1);
  return reply !== undefined;
}
