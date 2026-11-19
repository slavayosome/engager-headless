import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { actions, campaigns, candidateResearch, channels, discoveredPosts, messages, roomMembers } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { getChannel, inOrg, mkCampaign, mkOrg } from "./db";
import { dispatchAction } from "../execution/actionGate";
import type { PostInput } from "../linkedin/driver";
import { judgeRoomPeople } from "../rooms/judgment";
import { MockRoomReplyDriver } from "../linkedin/mockRoomReply";
import { queueRoomReplyDraft, saveRoomReplyDraft } from "../operations/roomReply";
import { selectRoomPeople, storeRoom } from "../rooms/room";

export const NOW = Date.now();
export const PARENT = "urn:li:comment:fixture-parent";
export const MEMBER = "urn:li:fsd_profile:fixture-alice";

export async function roomReplyFixture(tx: Tx, opts: { memberOnly?: boolean } = {}) {
  const channel = await getChannel(tx);
  await tx.update(channels).set({ externalAccountId: "fixture-owner", executionAccountId: "fixture-owner" }).where(eq(channels.id, channel.id));
  const campaign = await mkCampaign(tx, { channelId: channel.id });
  const [post] = await tx.insert(discoveredPosts).values({ campaignId: campaign.id,
    postUrn: `urn:li:activity:${BigInt(`0x${randomUUID().replaceAll("-", "").slice(0, 15)}`)}`,
    authorProfileId: "fixture-host", contentText: "A fixture post" }).returning();
  await tx.insert(candidateResearch).values({ campaignId: campaign.id, discoveredPostId: post!.id,
    verdict: "confirmed", verifiedBy: "server" });
  const thread = { postUrn: post!.postUrn, fullText: "A fixture post", counts: { comments: 1, reactions: 0, reposts: 0 },
    comments: [{ commentUrn: PARENT, memberUrn: MEMBER, authorProfileId: opts.memberOnly ? undefined : "fixture-alice", authorName: "Alice",
      text: "The fixture comment", reactions: 1, isOwner: false, authorReplied: false }] };
  const people = await selectRoomPeople(tx, campaign, thread, post!.authorProfileId);
  await storeRoom(tx, campaign, post!, { thread, people: judgeRoomPeople(people,
    people.map((person) => ({ personRef: person.ref, fit: "fits", reason: "Fixture",
      evidenceRefs: person.comments.map((comment) => comment.ref) })), new Set()), readAt: NOW,
    pages: 1, orders: ["relevance"], coverage: "complete", authorFit: "not", authorContactEligible: true },
  { reader: "server", now: NOW });
  const [member] = await tx.select().from(roomMembers).where(eq(roomMembers.discoveredPostId, post!.id));
  return { channel, campaign, post: post!, member: member!, input: { roomMemberId: member!.id, parentCommentUrn: PARENT } };
}


/** The owner's own saved answer under a fixture comment, queued to post. */
export async function queuedRoomReply(tx: Tx) {
  const source = await roomReplyFixture(tx);
  const draft = await saveRoomReplyDraft(tx, { ...source.input, text: "An answer", expectedRevision: null },
    { selection: "owner", authoredByOwner: true, now: NOW });
  const message = await queueRoomReplyDraft(tx, { draftId: draft.id, expectedRevision: draft.revision },
    { authorization: "owner", surface: "dashboard", now: NOW });
  return { source, message };
}

/** A room-reply driver signed in as the fixture's owner. */
export function ownerRoomDriver(): MockRoomReplyDriver {
  const driver = new MockRoomReplyDriver();
  driver.signedInAs = "fixture-owner";
  driver.ensureSession = async () => ({ ok: true, account: { externalAccountId: "fixture-owner" } });
  return driver;
}

export const roomMessage = (room: { orgId: string; message: { id: number } }) =>
  inOrg(room.orgId, async (tx) => (await tx.select().from(messages).where(eq(messages.id, room.message.id)))[0]!);

/** An owner's room reply, approved and queued as an action in its own org, with a provider that answers `outcome`. */
export async function queuedRoom(outcome: "confirmed" | "uncertain" = "confirmed") {
  const orgId = await mkOrg();
  const { source, message } = await inOrg(orgId, async (tx) => {
    const { source, message } = await queuedRoomReply(tx);
    return { source, message: (await tx.update(messages).set({ scheduledAt: null }).where(eq(messages.id, message.id)).returning())[0]! };
  });
  const driver = Object.assign(ownerRoomDriver(), { roomOutcome: outcome });
  driver.roomParents.set(`${source.post.postUrn}:${PARENT}`, { memberUrn: MEMBER });
  const [action] = await inOrg(orgId, (tx) => tx.select().from(actions));
  return { orgId, message, driver, action: action!, send: () => dispatchAction({ organizationId: orgId, driver }, action!.id) };
}

/** A sidecar journal that answers every resolution as `state`, recording the markers it was asked about. */
export function roomJournal(driver: MockRoomReplyDriver, state?: "already_committed", urn = "urn:li:comment:landed") {
  const asked: string[] = [];
  Object.assign(driver, { resolveUncertainWriteOutcome: async (input: PostInput, resolutionVersion: number, postedUrn?: string) => {
    asked.push(input.marker);
    return state || postedUrn ? { operationId: input.marker, state: "already_committed" as const, resolutionVersion, externalUrn: postedUrn ?? urn }
      : { operationId: input.marker, state: "resolved_not_posted" as const, resolutionVersion };
  } });
  return asked;
}
