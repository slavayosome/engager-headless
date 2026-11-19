import { and, eq, inArray, or, sql } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import { campaigns, candidateResearch, discoveredPosts, engagedProfiles, conversations, roomMembers, roomSnapshots, type Campaign } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { track } from "@engager/observability/analytics";
import type { PostThread } from "../linkedin/driver";
import { findPeople, memberProfilesSql, resolvePersonKeys } from "../people/directory";
import { authorIdentity, memberId, personKey } from "../people/key";
import { afterCommitOrNow } from "../telemetry/emit";
import { decideJoin, roomPeople, roomSummary, type JudgedRoomPerson } from "./judgment";
import { lockRoomEvidence, roomContactSql, ROOM_RETENTION_MS } from "./eligibility";
import { excludedRoomKeys } from "./retention";
import { bindRoomInsights, type RoomInsightsInput } from "./insightEvidence";

/** Resolve identity and account exclusions before the reference set is frozen.
 * This performs database reads only; comment authors never spend profile reads. */
export async function selectRoomPeople(tx: Tx, campaign: Pick<Campaign, "channelId">, thread: PostThread, authorProfileId: string | null) {
  const keys = thread.comments.flatMap((comment) => {
    const key = personKey({ profileId: comment.authorProfileId ? authorIdentity(comment.authorProfileId) : null, memberUrn: comment.memberUrn });
    const member = memberId(comment.memberUrn);
    return [...(key ? [key] : []), ...(member ? [`m.${member}`] : [])];
  });
  const aliases = await resolvePersonKeys(tx, keys);
  const profiles = [...new Set([...keys, ...aliases.values()].filter((key) => key.startsWith("p.")).map((key) => key.slice(2)))];
  const excluded = await excludedRoomKeys(tx);
  if (profiles.length) {
    const blocked = await tx.select({ id: engagedProfiles.profileId }).from(engagedProfiles)
      .where(and(inArray(engagedProfiles.profileId, profiles), eq(engagedProfiles.doNotEngage, true)));
    for (const person of blocked) excluded.add(`p.${person.id}`);
    const closed = await tx.select({ id: conversations.authorProfileId }).from(conversations)
      .where(and(inArray(conversations.authorProfileId, profiles),
        campaign.channelId == null ? sql`false` : eq(conversations.channelId, campaign.channelId),
        sql`${conversations.closedReason} is not null`,
        sql`not exists (select 1 from conversations newer where newer.channel_id = ${conversations.channelId}
          and newer.author_profile_id = ${conversations.authorProfileId} and newer.id > ${conversations.id})`));
    for (const person of closed) excluded.add(`p.${person.id}`);
  }
  return roomPeople(thread.comments, { aliases, excluded, authorKey: authorProfileId ? `p.${authorIdentity(authorProfileId)}` : null });
}

export class StaleRoomEvidence extends AppError {
  constructor() { super("room_evidence_stale", "Audience or eligible people changed during Research. Read and judge the room again.", 409); }
}

export type RoomRead = {
  people: JudgedRoomPerson[];
  thread: PostThread;
  readAt: number;
  pages: 1 | 2;
  orders: Array<"relevance" | "recent">;
  coverage: "complete" | "sampled" | "budget_limited";
  authorFit: "fits" | "maybe" | "not";
  authorContactEligible: boolean;
  contentFault?: "off_topic" | "engagement_bait" | "no_contribution_possible";
  insights?: RoomInsightsInput;
  firstPageRoom?: { judged: number; fits: number };
};

/** Called in the verdict's transaction. The old snapshot remains a stable
 * reference; the new pointer replaces its entire evidence set, not one page. */
export async function storeRoom(tx: Tx, campaign: Campaign, post: { id: number; authorProfileId: string | null }, input: RoomRead,
  meta: { reader: "server" | "agent"; runId?: number; now: number }) {
  await lockRoomEvidence(tx);
  const [current] = await tx.select({ revision: campaigns.audienceRevision }).from(campaigns)
    .where(eq(campaigns.id, campaign.id)).for("update");
  if (!current || current.revision !== campaign.audienceRevision) throw new StaleRoomEvidence();
  const [research] = await tx.select({ id: candidateResearch.discoveredPostId }).from(candidateResearch)
    .where(and(eq(candidateResearch.campaignId, campaign.id), eq(candidateResearch.discoveredPostId, post.id))).for("update");
  if (!research) throw new StaleRoomEvidence();
  const eligible = await selectRoomPeople(tx, campaign, input.thread, post.authorProfileId);
  // A block or an alias can arrive while the model is reading. Do not attach
  // its answers to a different reference set or retain excluded source text.
  if (JSON.stringify(eligible.map((person) => [person.personKey, person.comments.map((comment) => comment.commentUrn)])) !==
      JSON.stringify(input.people.map((person) => [person.personKey, person.comments.map((comment) => comment.commentUrn)]))) throw new StaleRoomEvidence();
  const counts = roomSummary(input.people, input.pages);
  const firstPageRoom = meta.reader === "server" && input.pages === 2 ? input.firstPageRoom : undefined;
  const { lens, reasonCode, reason } = decideJoin({ ...input, firstPageRoom, room: counts });
  const skipped = await tx.select({ key: roomMembers.personKey, memberUrn: roomMembers.memberUrn, at: roomMembers.ownerSkippedAt })
    .from(roomMembers).where(and(eq(roomMembers.discoveredPostId, post.id), sql`${roomMembers.ownerSkippedAt} is not null`));
  const skipAliases = await resolvePersonKeys(tx, skipped.map((person) => person.key));
  const skippedAt = (person: JudgedRoomPerson) => skipped.reduce<number | null>((at, previous) =>
    ((skipAliases.get(previous.key) ?? previous.key) === person.personKey ||
      (person.memberUrn !== null && previous.memberUrn === person.memberUrn))
      ? Math.max(at ?? 0, previous.at!) : at, null);
  const insightPeople = input.readAt <= meta.now - ROOM_RETENTION_MS || input.readAt > meta.now
    ? [] : input.people.filter((person) => skippedAt(person) === null);
  const newlySpotted = lens === "none" || input.readAt <= meta.now - ROOM_RETENTION_MS || input.readAt > meta.now
    ? 0 : await countNewRoomPeople(tx, input.people.filter((person) => person.fit === "fits" && skippedAt(person) === null), campaign.channelId, meta.now);
  const summary = { ...counts, newlySpotted, decision: { reasonCode, reason }, authorFit: input.authorFit,
    ...(firstPageRoom ? { firstPageRoom } : {}) };
  const [snapshot] = await tx.insert(roomSnapshots).values({
    campaignId: campaign.id, discoveredPostId: post.id, audienceRevision: campaign.audienceRevision,
    readAt: input.readAt, reader: meta.reader, runId: meta.runId ?? null, createdAt: meta.now,
    totalComments: input.thread.counts.comments, commentsRead: input.thread.comments.length,
    pages: input.pages, orders: input.orders, coverage: input.coverage, summary, joinLens: lens,
  }).returning();
  if (input.people.length) await tx.insert(roomMembers).values(input.people.map((person) => ({
    discoveredPostId: post.id, snapshotId: snapshot!.id, personKey: person.personKey, personRef: person.ref,
    profileId: person.profileId, memberUrn: person.memberUrn, name: person.name, headline: person.headline,
    comments: person.comments, fit: person.fit, painId: person.painId, reason: person.reason, evidenceRefs: person.evidenceRefs,
    country: person.country, countryReadAt: person.countryReadAt, ownerSkippedAt: skippedAt(person),
  })));
  await tx.update(candidateResearch).set({ roomSnapshotId: snapshot!.id, roomSummary: summary, joinLens: lens, authorFit: input.authorFit,
    insights: bindRoomInsights(input.insights, insightPeople, snapshot!) })
    .where(and(eq(candidateResearch.campaignId, campaign.id), eq(candidateResearch.discoveredPostId, post.id)));
  afterCommitOrNow(tx, () => track("room_read", { judged: summary.judged, fits: summary.fits,
    maybe: summary.maybe, lens, pages: input.pages }));
  return snapshot!;
}

/** Called only under lockRoomEvidence. A reread or another campaign must not
 * rediscover the same person, even if a newer snapshot no longer fits them.
 * Both keys matter when this thread is the first evidence of an alias. */
async function countNewRoomPeople(tx: Tx, people: JudgedRoomPerson[], channelId: number | null, now: number) {
  if (!people.length) return 0;
  const keysOf = (person: JudgedRoomPerson) => [person.personKey,
    ...(memberId(person.memberUrn) ? [`m.${memberId(person.memberUrn)}`] : [])];
  const keys = [...new Set(people.flatMap(keysOf))];
  const known = await findPeople(tx, keys);
  const resolved = await resolvePersonKeys(tx, keys);
  const named = [...new Set([...keys, ...resolved.values()])];
  const prior = await tx.select({ key: roomMembers.personKey }).from(roomMembers)
    .innerJoin(roomSnapshots, eq(roomSnapshots.id, roomMembers.snapshotId))
    .where(and(eq(roomMembers.fit, "fits"), sql`${roomSnapshots.readAt} > ${now - ROOM_RETENTION_MS}`,
      sql`${roomSnapshots.readAt} <= ${now}`, or(inArray(roomMembers.personKey, named),
        inArray(roomMembers.profileId, named.filter((key) => key.startsWith("p.")).map((key) => key.slice(2))),
        inArray(roomMembers.memberUrn, people.flatMap((person) => person.memberUrn ? [person.memberUrn] : [])))));
  const aliases = await resolvePersonKeys(tx, [...keys, ...prior.map((person) => person.key)]);
  const seen = new Set(prior.map((person) => aliases.get(person.key) ?? person.key));
  const { rows: contacted } = await tx.execute<{ key: string }>(sql`with member_profiles as (${memberProfilesSql()}),
    incoming(person_key, profile_id, member_urn) as (values ${sql.join(people.map((person) =>
      sql`(${person.personKey}::text, ${person.profileId}::text, ${person.memberUrn}::text)`), sql`, `)})
    select member.person_key as key from incoming member
    left join member_profiles alias on alias.urn = member.member_urn
    where ${roomContactSql(sql`coalesce(member.profile_id, alias.profile_id)`, sql`member.member_urn`, sql`${channelId}`)}`);
  const touched = new Set(contacted.map((person) => person.key));
  return people.filter((person) => !touched.has(person.personKey) && keysOf(person).every((key) =>
    !known.has(key) && !seen.has(aliases.get(key) ?? key))).length;
}

/** Current evidence by default; an explicit historical snapshot can explain
 * existing work, but is visibly stale and cannot qualify new selection. */
export async function listRoomMembers(tx: Tx, campaign: Campaign, discoveredPostId: number, snapshotId?: string, now = Date.now()) {
  const [currentCampaign] = await tx.select().from(campaigns).where(eq(campaigns.id, campaign.id));
  if (!currentCampaign) return null;
  const [research] = await tx.select().from(candidateResearch)
    .where(and(eq(candidateResearch.campaignId, campaign.id), eq(candidateResearch.discoveredPostId, discoveredPostId)));
  const id = snapshotId ?? research?.roomSnapshotId;
  if (!id) return null;
  const [snapshot] = await tx.select().from(roomSnapshots)
    .where(and(eq(roomSnapshots.id, id), eq(roomSnapshots.campaignId, campaign.id), eq(roomSnapshots.discoveredPostId, discoveredPostId)));
  if (!snapshot) return null;
  const [post] = await tx.select({ authorProfileId: discoveredPosts.authorProfileId }).from(discoveredPosts)
    .where(and(eq(discoveredPosts.id, discoveredPostId), eq(discoveredPosts.campaignId, campaign.id)));
  if (!post) return null;
  const members = await tx.select().from(roomMembers).where(eq(roomMembers.snapshotId, id));
  const eligible = await selectRoomPeople(tx, currentCampaign, {
    postUrn: "", fullText: "", counts: { comments: snapshot.totalComments, reactions: 0, reposts: 0 },
    comments: members.flatMap((person) => person.comments),
  }, post.authorProfileId);
  const keys = new Set(eligible.map((person) => person.personKey));
  const expired = snapshot.readAt <= now - ROOM_RETENTION_MS;
  let retained: Set<number> | null = null;
  if (expired) {
    const contact = roomContactSql(sql`coalesce(member.profile_id, alias.profile_id)`, sql`member.member_urn`, sql`${currentCampaign.channelId}`);
    const { rows } = await tx.execute<{ id: number }>(sql`with member_profiles as (${memberProfilesSql()})
      select member.id::int as id from room_members member
      left join member_profiles alias on alias.urn = member.member_urn
      where member.snapshot_id = ${id} and ${contact}`);
    retained = new Set(rows.map((row) => row.id));
  }
  const aliases = await resolvePersonKeys(tx, members.map((person) => person.personKey));
  const visible = members.flatMap((person) => {
    const key = aliases.get(person.personKey) ?? person.personKey;
    if (!keys.has(key) || (retained !== null && !retained.has(person.id))) return [];
    return [{ ...person, personKey: key, profileId: key.startsWith("p.") ? key.slice(2) : person.profileId }];
  });
  const priority = { fits: 0, maybe: 1, unknown: 2, not: 3 };
  visible.sort((a, b) => priority[a.fit] - priority[b.fit] || a.id - b.id);
  return { snapshot, members: visible, currentAudienceRevision: currentCampaign.audienceRevision,
    stale: snapshot.audienceRevision !== currentCampaign.audienceRevision ||
    expired || id !== research?.roomSnapshotId || visible.length !== snapshot.summary.judged };
}
