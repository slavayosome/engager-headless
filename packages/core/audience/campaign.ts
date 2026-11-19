import { and, eq, isNull, sql } from "drizzle-orm";
import { campaigns } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { listMatchingRoomPeople } from "../rooms/people";

export type CampaignAudience = {
  campaignId: number;
  revision: number;
  since: number;
  until: number;
  roomsRead: number;
  peopleWhoFit: number;
  spotted: number;
};

/** Overview and both destination lists share the matching-person reader.
 * The fixed half-open window travels in each link along with the Audience
 * revision. A later revision cannot quietly replace the linked population. */
export async function campaignAudience(tx: Tx, campaignId: number, now = Date.now()): Promise<CampaignAudience | null> {
  const [campaign] = await tx.select({ revision: campaigns.audienceRevision }).from(campaigns)
    .where(and(eq(campaigns.id, campaignId), isNull(campaigns.deletedAt)));
  if (!campaign) return null;
  const since = now - 7 * 86_400_000;
  const until = now + 1;
  const scope = { campaignId, audienceRevision: campaign.revision, since, until, now, limit: 1 };
  const matching = await listMatchingRoomPeople(tx, { ...scope, contactState: "all" });
  const spotted = await listMatchingRoomPeople(tx, { ...scope, contactState: "spotted" });
  const { rows } = await tx.execute<{ rooms: number }>(sql`
    select count(distinct snapshot.discovered_post_id)::int as rooms
    from room_snapshots snapshot
    join candidate_research research on research.room_snapshot_id = snapshot.id
      and research.discovered_post_id = snapshot.discovered_post_id
      and research.campaign_id = snapshot.campaign_id
      and research.organization_id = snapshot.organization_id
    where snapshot.campaign_id = ${campaignId} and snapshot.audience_revision = ${campaign.revision}
      and research.verdict = 'confirmed' and snapshot.read_at >= ${since} and snapshot.read_at < ${until}
  `);
  return { campaignId, revision: campaign.revision, since, until, roomsRead: rows[0]?.rooms ?? 0,
    peopleWhoFit: matching.total, spotted: spotted.total };
}
