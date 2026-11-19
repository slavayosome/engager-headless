import { and, eq, inArray } from "drizzle-orm";
import { campaigns, candidateResearch, discoveredPosts, engagedProfiles, type RoomInsightJson } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { resolvePersonKeys } from "../people/directory";
import { ROOM_RETENTION_MS } from "./eligibility";
import { authorIdentity } from "../people/key";
import { excludedRoomKeys } from "./retention";
import { listRoomMembers } from "./room";

export type RoomInsight = {
  kind: RoomInsightJson["kind"];
  text: string;
  sources: Array<{ commentUrn: string; personKey: string; authorName: string | null; text: string }>;
};
export type RoomInsightEvidence = {
  snapshotId: string;
  audienceRevision: number;
  readAt: number;
  insights: RoomInsight[];
};

/** Read current claims from their retained matching-person comments. Losing
 * a source changes the count immediately, before the daily purge runs. */
export async function readRoomInsightEvidence(tx: Tx, discoveredPostIds: readonly number[], now = Date.now()): Promise<Map<number, RoomInsightEvidence>> {
  const out = new Map<number, RoomInsightEvidence>();
  if (!discoveredPostIds.length) return out;
  const rows = await tx.select({ research: candidateResearch, campaign: campaigns, author: discoveredPosts.authorProfileId }).from(candidateResearch)
    .innerJoin(campaigns, eq(campaigns.id, candidateResearch.campaignId))
    .innerJoin(discoveredPosts, eq(discoveredPosts.id, candidateResearch.discoveredPostId))
    .where(and(inArray(candidateResearch.discoveredPostId, [...discoveredPostIds]), eq(candidateResearch.verdict, "confirmed")));
  const authors = [...new Set(rows.flatMap((row) => row.author ? [authorIdentity(row.author)] : []))];
  const excluded = await excludedRoomKeys(tx);
  const blocked = new Set((authors.length ? await tx.select({ profileId: engagedProfiles.profileId }).from(engagedProfiles)
    .where(and(inArray(engagedProfiles.profileId, authors), eq(engagedProfiles.doNotEngage, true))) : []).map((row) => row.profileId));
  for (const { research, campaign, author } of rows) {
    if (author && (blocked.has(authorIdentity(author)) || excluded.has(`p.${authorIdentity(author)}`))) continue;
    if (!research.roomSnapshotId || !research.insights?.length) continue;
    const room = await listRoomMembers(tx, campaign, research.discoveredPostId, undefined, now);
    if (!room || room.snapshot.id !== research.roomSnapshotId || room.snapshot.audienceRevision !== room.currentAudienceRevision ||
      room.snapshot.readAt <= now - ROOM_RETENTION_MS || room.snapshot.readAt > now) continue;
    const aliases = await resolvePersonKeys(tx, research.insights.flatMap((item) => item.sourceRefs.map((ref) => ref.personKey)));
    const comments = new Map<string, RoomInsight["sources"][number]>();
    for (const person of room.members) {
      if (person.fit !== "fits" || person.ownerSkippedAt !== null) continue;
      for (const comment of person.comments) {
        if (!comment.text.trim()) continue;
        comments.set(comment.commentUrn, { commentUrn: comment.commentUrn, personKey: person.personKey,
          authorName: person.name, text: comment.text });
      }
    }
    const insights = research.insights.flatMap((item) => {
      if (item.snapshotId !== room.snapshot.id || item.audienceRevision !== campaign.audienceRevision) return [];
      const seen = new Set<string>();
      const sources = item.sourceRefs.flatMap((ref) => {
        const comment = comments.get(ref.commentUrn);
        if (!comment || seen.has(ref.commentUrn) || comment.personKey !== (aliases.get(ref.personKey) ?? ref.personKey)) return [];
        seen.add(ref.commentUrn);
        return [comment];
      });
      return sources.length ? [{ kind: item.kind, text: item.text, sources }] : [];
    });
    if (insights.length) out.set(research.discoveredPostId, { snapshotId: room.snapshot.id,
      audienceRevision: room.snapshot.audienceRevision, readAt: room.snapshot.readAt, insights });
  }
  return out;
}

export async function readRoomInsights(tx: Tx, discoveredPostIds: readonly number[], now = Date.now()): Promise<Map<number, RoomInsight[]>> {
  return new Map([...(await readRoomInsightEvidence(tx, discoveredPostIds, now))].map(([id, evidence]) => [id, evidence.insights]));
}
