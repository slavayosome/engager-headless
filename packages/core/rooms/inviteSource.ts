import { eq } from "drizzle-orm";
import { campaigns, channels, discoveredPosts, roomMembers } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { ActionLedgerError } from "../actions/errors";
import { lockPauses, openPauses, scopesOf } from "../actions/pause";
import { resolvePersonKeys } from "../people/directory";
import { lockRoomEvidence } from "./eligibility";
import { listRoomMembers } from "./room";

export type RoomInviteOrigin = { kind: "room"; discoveredPostId: number };

function unavailable(detail: string): never {
  throw new ActionLedgerError("action_not_permitted", detail, "Reopen the person from a current room.");
}

/** An invite from a room stays on that campaign and account. Unlike the
 * generic person header, this never falls back to another campaign. Reads
 * and the later press use the same stored evidence; neither reads LinkedIn. */
export async function roomInviteSource(tx: Tx, input: {
  campaignId: number | null;
  personKey: string;
  openedFrom: RoomInviteOrigin;
  now: number;
}) {
  await lockPauses(tx);
  await lockRoomEvidence(tx);
  const [row] = await tx.select({ campaign: campaigns, channel: channels }).from(discoveredPosts)
    .innerJoin(campaigns, eq(campaigns.id, discoveredPosts.campaignId))
    .innerJoin(channels, eq(channels.id, campaigns.channelId))
    .where(eq(discoveredPosts.id, input.openedFrom.discoveredPostId));
  if (!row || row.campaign.id !== input.campaignId || input.openedFrom.kind !== "room") {
    unavailable("That room does not belong to this campaign and account.");
  }
  const { campaign, channel } = row;
  if (campaign.status === "archived") unavailable("This campaign is archived.");
  const account = channel.externalAccountId?.trim();
  if (!account || (channel.executionAccountId && channel.executionAccountId !== account)) {
    unavailable("Reconnect the LinkedIn account before inviting from this room.");
  }
  const scopes = scopesOf({ channelId: channel.id, campaignId: campaign.id, conversationId: null });
  if ((await openPauses(tx, scopes)).length) {
    throw new ActionLedgerError("action_stopped", "A Stop holds this room's campaign or account.", "Resume it first.");
  }
  const key = (await resolvePersonKeys(tx, [input.personKey])).get(input.personKey) ?? input.personKey;
  const room = await listRoomMembers(tx, campaign, input.openedFrom.discoveredPostId, undefined, input.now);
  const member = room?.members.find((person) => person.personKey === key && person.fit === "fits" && person.ownerSkippedAt === null);
  if (!room || room.stale || !member) unavailable("Research needs to check this person in the room again.");
  return { campaign, channelId: channel.id, accountProfileId: account, member, openedFrom: input.openedFrom };
}

/** The browser names a stored room row, never an arbitrary person/post pair. */
export async function roomInviteAt(tx: Tx, roomMemberId: number, now = Date.now()) {
  if (!Number.isSafeInteger(roomMemberId) || roomMemberId <= 0) unavailable("Choose a person in the room.");
  const [row] = await tx.select({ member: roomMembers, campaignId: discoveredPosts.campaignId }).from(roomMembers)
    .innerJoin(discoveredPosts, eq(discoveredPosts.id, roomMembers.discoveredPostId))
    .where(eq(roomMembers.id, roomMemberId));
  if (!row) unavailable("This person is no longer in that room.");
  const source = await roomInviteSource(tx, { campaignId: row.campaignId, personKey: row.member.personKey,
    openedFrom: { kind: "room", discoveredPostId: row.member.discoveredPostId }, now });
  if (source.member.id !== roomMemberId) unavailable("The room changed while this invite was open.");
  return source;
}
