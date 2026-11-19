import { sql, type SQL } from "drizzle-orm";
import type { Tx } from "@engager/database/tenant";
import { escapeSearch } from "../operations/threads";
import { memberProfilesSql } from "../people/directory";
import { personKeySql } from "../people/key";
import { roomContactSql, roomExcludedSql, ROOM_RETENTION_MS } from "./eligibility";

export type MatchingRoomPerson = {
  personKey: string;
  name: string | null;
  headline: string | null;
  spottedAt: number;
  rooms: number;
  contacted: boolean;
  discoveredPostId: number;
  postAuthor: string | null;
  comment: string;
  campaignId: number;
  campaignName: string;
};
export type RoomPeopleScope = {
  campaignId?: number;
  discoveredPostId?: number;
  excludeSkipped?: boolean;
  /** MCP's untouched filter follows the directory standing across accounts. */
  standingSpottedOnly?: boolean;
  since?: number;
  until?: number;
  audienceRevision?: number;
  contactState?: "spotted" | "touched" | "all";
  /** The judgments listed: a comment that fits alone unless asked. */
  fit?: readonly ("fits" | "maybe")[];
  search?: string;
  keys?: readonly string[];
  limit?: number;
  offset?: number;
  now?: number;
};

/** One population for list rows and their count. Matches are the latest
 * snapshot at the campaign's current audience; contact comes only from a
 * confirmed receipt on an account represented by those rooms. */
export async function listMatchingRoomPeople(tx: Tx, scope: RoomPeopleScope = {}): Promise<{ people: MatchingRoomPerson[]; total: number }> {
  if (scope.keys?.length === 0) return { people: [], total: 0 };
  const now = scope.now ?? Date.now();
  const profile = sql`coalesce(member.profile_id, alias.profile_id)`;
  const key = personKeySql({ profileId: profile, memberUrn: sql`member.member_urn`, incomingCommentId: sql`null` });
  const fit = scope.fit ?? ["fits"];
  if (fit.length === 0) return { people: [], total: 0 };
  const filters: SQL[] = [sql`member.fit in (${sql.join(fit.map((value) => sql`${value}`), sql`, `)})`, sql`research.verdict = 'confirmed'`, sql`snapshot.audience_revision = campaign.audience_revision`,
    sql`campaign.deleted_at is null`, sql`snapshot.read_at <= ${now}`, sql`snapshot.read_at > ${now - ROOM_RETENTION_MS}`,
    sql`not ${roomExcludedSql(profile, sql`member.member_urn`, key, sql`member_profiles`)}`,
    sql`not exists (select 1 from engaged_profiles blocked where blocked.profile_id = ${profile} and blocked.do_not_engage)`,
    sql`not exists (select 1 from conversations closed where closed.channel_id = campaign.channel_id
      and closed.author_profile_id = ${profile} and closed.closed_reason is not null
      and not exists (select 1 from conversations newer where newer.channel_id = closed.channel_id
        and newer.author_profile_id = closed.author_profile_id and newer.id > closed.id))`];
  const scoped: SQL[] = [];
  if (scope.campaignId !== undefined) scoped.push(sql`campaign_id = ${scope.campaignId}`);
  if (scope.discoveredPostId !== undefined) scoped.push(sql`discovered_post_id = ${scope.discoveredPostId}`);
  if (scope.excludeSkipped) scoped.push(sql`owner_skipped_at is null`);
  if (scope.audienceRevision !== undefined) scoped.push(sql`audience_revision = ${scope.audienceRevision}`);
  if (scope.since !== undefined) scoped.push(sql`read_at >= ${scope.since}`);
  if (scope.until !== undefined) scoped.push(sql`read_at < ${scope.until}`);
  if (scope.keys) filters.push(sql`${key} in (${sql.join(scope.keys.map((value) => sql`${value}`), sql`, `)})`);
  const population: SQL[] = [sql`key is not null`];
  if (scope.standingSpottedOnly) population.push(sql`key in (select key from standing_spotted)`);
  if (scope.contactState === "spotted") population.push(sql`not contacted`);
  if (scope.contactState === "touched") population.push(sql`contacted`);
  if (scope.search?.trim()) {
    const pattern = `%${escapeSearch(scope.search.trim())}%`;
    population.push(sql`(name ilike ${pattern} escape '\\' or headline ilike ${pattern} escape '\\')`);
  }
  const limit = Math.max(1, Math.min(100, Math.floor(scope.limit ?? 25)));
  const offset = Math.max(0, Math.floor(scope.offset ?? 0));
  const result = await tx.execute<{ people: MatchingRoomPerson[]; total: number }>(sql`
    with member_profiles as (${memberProfilesSql()}), all_evidence as (
      select ${key} as key, ${profile} as profile_id, member.id, member.name, member.headline,
        member.owner_skipped_at, snapshot.audience_revision,
        snapshot.read_at, snapshot.discovered_post_id, post.author_name,
        coalesce((select entry->>'text' from jsonb_array_elements(member.comments) entry
          where member.evidence_refs ? (entry->>'ref') limit 1), member.comments->0->>'text', '') as comment,
        campaign.id as campaign_id, campaign.name as campaign_name,
        ${roomContactSql(profile, sql`member.member_urn`, sql`campaign.channel_id`)} as contacted
      from room_members member
      join room_snapshots snapshot on snapshot.id = member.snapshot_id and snapshot.organization_id = member.organization_id
      join candidate_research research on research.room_snapshot_id = snapshot.id and research.discovered_post_id = snapshot.discovered_post_id
      join campaigns campaign on campaign.id = snapshot.campaign_id
      join discovered_posts post on post.id = snapshot.discovered_post_id
      left join member_profiles alias on alias.urn = member.member_urn
      where ${sql.join(filters, sql` and `)}
    ), evidence as (
      select * from all_evidence where ${scoped.length ? sql.join(scoped, sql` and `) : sql`true`}
    )${scope.standingSpottedOnly ? sql`, standing_spotted as (
      select key from all_evidence
      where (select conversation.closed_reason from conversations conversation
        where conversation.author_profile_id = all_evidence.profile_id
        order by conversation.closed_reason is null desc, conversation.id desc limit 1) is null
      group by key having not bool_or(contacted)
    )` : sql``}, counted as (
      select key, count(distinct discovered_post_id)::int as rooms, bool_or(contacted) as contacted from evidence group by key
    ), latest as (
      select distinct on (key) key, name, headline, read_at, discovered_post_id, author_name, comment, campaign_id, campaign_name
      from evidence order by key, read_at desc, id desc
    ), population as (
      select latest.*, counted.rooms, counted.contacted from latest join counted using (key)
      where ${sql.join(population, sql` and `)}
    ), page as (
      select key as "personKey", name, headline, read_at::float8 as "spottedAt", rooms, contacted,
        discovered_post_id::int as "discoveredPostId", author_name as "postAuthor", comment,
        campaign_id::int as "campaignId", campaign_name as "campaignName"
      from population order by read_at desc, key limit ${limit} offset ${offset}
    ) select coalesce((select json_agg(page) from page), '[]'::json) as people,
      (select count(*)::int from population) as total`);
  return result.rows[0] ?? { people: [], total: 0 };
}

export function listSpotted(tx: Tx, scope: Omit<RoomPeopleScope, "contactState"> = {}) {
  return listMatchingRoomPeople(tx, { ...scope, contactState: "spotted" });
}

/** The matching room population with the same evidence and standing the room shows. */
export async function roomPeoplePage(tx: Tx, input: { campaignId?: number; limit: number; offset: number; now: number }) {
  const { roomPeople } = await import("./read");
  const { findPeople } = await import("../people/directory");
  const { personStandings } = await import("../people/standing");
  const page = await listMatchingRoomPeople(tx, { campaignId: input.campaignId, limit: input.limit, offset: input.offset,
    now: input.now, since: input.now - 7 * 86_400_000, until: input.now + 1, excludeSkipped: true, standingSpottedOnly: true });
  const rooms = await roomPeople(tx, { discoveredPostIds: [...new Set(page.people.map((row) => row.discoveredPostId))] });
  const directory = await findPeople(tx, page.people.map((row) => row.personKey));
  const standings = await personStandings(tx, [...directory.values()]);
  const people = page.people.map((row) => {
    const member = rooms.get(row.discoveredPostId)?.fits.find((item) => item.personKey === row.personKey);
    const standing = standings.get(row.personKey);
    if (!member || !standing || standing.kind !== "spotted") throw new Error("room_evidence_changed");
    return { ...row, member, standing };
  });
  return { people, total: page.total };
}
