import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import { audienceRevisions, campaigns, candidateResearch, discoveredPosts, roomMembers, roomSnapshots, type Campaign } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { audienceProfile } from "../audience/model";
import { knownCountries } from "../people/countries";
import { resolvePersonKeys } from "../people/directory";
import { listRoomMembers } from "./room";
import { lockRoomEvidence } from "./eligibility";

export type RoomPerson = {
  roomMemberId: number;
  personKey: string;
  name: string | null;
  headline: string | null;
  /** Where a profile read last placed them; null where none did. */
  country: string | null;
  comment: string;
  parentCommentUrn: string;
  reactions: number;
  painId: string | null;
  painText: string | null;
  why: string | null;
};
export type RoomPeople = {
  fits: RoomPerson[];
  maybe: RoomPerson[];
  skipped: number;
  judged: number;
  fitsCount: number;
  stale: boolean;
};

async function readRoom(tx: Tx, campaign: Campaign, postId: number): Promise<RoomPeople | null> {
  const read = await listRoomMembers(tx, campaign, postId);
  if (!read) return null;
  let profile = audienceProfile(campaign);
  if (profile.revision !== read.snapshot.audienceRevision) {
    const [revision] = await tx.select().from(audienceRevisions)
      .where(and(eq(audienceRevisions.campaignId, campaign.id), eq(audienceRevisions.revision, read.snapshot.audienceRevision)));
    profile = revision?.profile ?? { ...profile, pains: [] };
  }
  const pains = new Map(profile.pains.filter((pain) => pain.status === "active").map((pain) => [pain.id, pain.text]));
  const result: RoomPeople = { fits: [], maybe: [], skipped: 0, judged: read.snapshot.summary.judged,
    fitsCount: read.members.filter((member) => member.fit === "fits").length, stale: read.stale };
  const countries = await knownCountries(tx, read.members.flatMap((member) => member.profileId ? [member.profileId] : []));
  for (const member of read.members) {
    if (member.fit !== "fits" && member.fit !== "maybe") continue;
    if (member.ownerSkippedAt !== null) { result.skipped += 1; continue; }
    const comment = member.comments.find((entry) => member.evidenceRefs.includes(entry.ref)) ?? member.comments[0];
    if (!comment) continue;
    result[member.fit === "fits" ? "fits" : "maybe"].push({
      roomMemberId: member.id, personKey: member.personKey, name: member.name, headline: member.headline,
      country: member.profileId ? countries.get(member.profileId) ?? null : null,
      comment: comment.text, parentCommentUrn: comment.commentUrn, reactions: comment.reactions, painId: member.painId,
      painText: member.painId ? pains.get(member.painId) ?? null : null, why: member.reason,
    });
  }
  return result;
}

/** The same post-scoped read backs the join pane and its room-people tool.
 * It spends no provider reads and never creates a person conversation. */
export async function roomPeople(tx: Tx, input: { discoveredPostIds: number[] }): Promise<Map<number, RoomPeople>> {
  if (!input.discoveredPostIds.length) return new Map();
  const posts = await tx.select({ id: discoveredPosts.id, campaignId: discoveredPosts.campaignId }).from(discoveredPosts)
    .where(inArray(discoveredPosts.id, input.discoveredPostIds));
  const ids = [...new Set(posts.map((post) => post.campaignId))];
  const campaignRows = ids.length ? await tx.select().from(campaigns).where(inArray(campaigns.id, ids)) : [];
  const byId = new Map(campaignRows.map((campaign) => [campaign.id, campaign]));
  const out = new Map<number, RoomPeople>();
  for (const post of posts) {
    const campaign = byId.get(post.campaignId);
    if (!campaign) continue;
    const read = await readRoom(tx, campaign, post.id);
    if (read) out.set(post.id, read);
  }
  return out;
}

async function lockRoom(tx: Tx, campaignId: number, postId: number) {
  const [campaign] = await tx.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.id, campaignId)).for("update");
  const [research] = await tx.select({ id: candidateResearch.discoveredPostId }).from(candidateResearch)
    .where(and(eq(candidateResearch.campaignId, campaignId), eq(candidateResearch.discoveredPostId, postId))).for("update");
  if (!campaign || !research) throw new AppError("room_not_found", "That room is no longer available.", 404);
}

/** The rows one person has on a post, including any alias the directory
 * learned since the card was rendered, under the evidence and room locks. The
 * Research lock serializes the change made to them with replacement reads, so
 * it cannot disappear between pages. */
async function lockPersonRows(tx: Tx, roomMemberId: number) {
  await lockRoomEvidence(tx);
  const [row] = await tx.select({ member: roomMembers, campaignId: roomSnapshots.campaignId }).from(roomMembers)
    .innerJoin(roomSnapshots, eq(roomSnapshots.id, roomMembers.snapshotId)).where(eq(roomMembers.id, roomMemberId));
  if (!row) throw new AppError("room_person_not_found", "That person is no longer in this room.", 404);
  await lockRoom(tx, row.campaignId, row.member.discoveredPostId);
  const members = await tx.select({ id: roomMembers.id, key: roomMembers.personKey, memberUrn: roomMembers.memberUrn }).from(roomMembers)
    .where(eq(roomMembers.discoveredPostId, row.member.discoveredPostId));
  if (!members.some((member) => member.id === roomMemberId)) throw new AppError("room_person_not_found", "That person is no longer in this room.", 404);
  const aliases = await resolvePersonKeys(tx, members.map((member) => member.key));
  const key = aliases.get(row.member.personKey) ?? row.member.personKey;
  const ids = members.filter((member) => (aliases.get(member.key) ?? member.key) === key ||
    (row.member.memberUrn !== null && member.memberUrn === row.member.memberUrn)).map((member) => member.id);
  return { discoveredPostId: row.member.discoveredPostId, ids };
}

/** Skip one person on this post. */
export async function skipRoomPerson(tx: Tx, roomMemberId: number, now = Date.now()) {
  const { discoveredPostId, ids } = await lockPersonRows(tx, roomMemberId);
  await tx.update(roomMembers).set({ ownerSkippedAt: now }).where(inArray(roomMembers.id, ids));
  return { discoveredPostId };
}

/** Bring one person back on this post, on the rows `skipRoomPerson` set;
 * anyone else skipped on it stays skipped. */
export async function unskipRoomPerson(tx: Tx, roomMemberId: number) {
  const { discoveredPostId, ids } = await lockPersonRows(tx, roomMemberId);
  await tx.update(roomMembers).set({ ownerSkippedAt: null }).where(inArray(roomMembers.id, ids));
  return { discoveredPostId };
}

export async function unskipRoom(tx: Tx, discoveredPostId: number) {
  await lockRoomEvidence(tx);
  const [post] = await tx.select({ campaignId: discoveredPosts.campaignId }).from(discoveredPosts).where(eq(discoveredPosts.id, discoveredPostId));
  if (!post) throw new AppError("room_not_found", "That room is no longer available.", 404);
  await lockRoom(tx, post.campaignId, discoveredPostId);
  await tx.update(roomMembers).set({ ownerSkippedAt: null })
    .where(and(eq(roomMembers.discoveredPostId, discoveredPostId), isNotNull(roomMembers.ownerSkippedAt)));
}
