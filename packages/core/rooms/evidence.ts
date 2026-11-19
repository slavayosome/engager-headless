import { sql } from "drizzle-orm";
import { discoveredPosts } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { memberProfilesSql } from "../people/directory";
import type { JoinLens, RoomEvidence } from "./presentation";
import { roomExcludedSql } from "./eligibility";

/** The aliases here belong to the two reads below. A changed identity or
 * exclusion invalidates the entire stored denominator until Research rereads
 * it; filtering one person must never make the old room appear denser. */
function usableRoom(now: number) {
  return sql`rs.audience_revision = c.audience_revision
    and rs.read_at > ${now - 90 * 86_400_000}
    and rs.summary->>'judged' = (select count(*)::text from room_members member
      where member.organization_id = rs.organization_id and member.snapshot_id = rs.id)
    and not exists (
      select 1 from room_members member
      left join (${memberProfilesSql()}) alias on alias.urn = member.member_urn
      where member.organization_id = rs.organization_id and member.snapshot_id = rs.id
        and (
          ${roomExcludedSql(sql`coalesce(member.profile_id, alias.profile_id)`, sql`member.member_urn`, sql`member.person_key`, sql`(${memberProfilesSql()})`)}
          or
          (alias.profile_id is not null and member.person_key <> 'p.' || alias.profile_id)
          or exists (select 1 from engaged_profiles blocked
            where blocked.organization_id = member.organization_id and blocked.do_not_engage
              and blocked.profile_id = coalesce(member.profile_id, alias.profile_id))
          or exists (select 1 from conversations closed
            where closed.organization_id = member.organization_id and closed.channel_id = c.channel_id
              and closed.author_profile_id = coalesce(member.profile_id, alias.profile_id)
              and closed.closed_reason is not null
              and not exists (select 1 from conversations newer where newer.organization_id = closed.organization_id
                and newer.channel_id = closed.channel_id and newer.author_profile_id = closed.author_profile_id
                and newer.id > closed.id))
        ))`;
}

/** Research left this post to the owner (`author_maybe`), correlated to
 * `discovered_posts`. A worker neither drafts it nor counts it confirmed. */
export function forOwnerSql() {
  return sql`exists (select 1 from candidate_research cr
    where cr.organization_id = ${discoveredPosts.organizationId} and cr.discovered_post_id = ${discoveredPosts.id}
      and cr.join_lens = 'author_maybe')`;
}

/** `roomOnly` (`presentation.ts`) read from the confirmed read, correlated to
 * `discovered_posts`: the owner answers the people in its comments, and no
 * worker writes a comment on the post itself. */
export function roomOnlySql() {
  return sql`exists (select 1 from candidate_research cr
    where cr.organization_id = ${discoveredPosts.organizationId} and cr.discovered_post_id = ${discoveredPosts.id}
      and cr.verdict = 'confirmed' and cr.join_lens = 'room' and cr.author_fit = 'not')`;
}

/** Correlated to the candidate being ranked, before the page limit. */
export function roomWorthSql(now: number) {
  return sql`coalesce((select least(1, 0.8 + 0.02 * (rs.summary->>'fits')::int)
    from candidate_research cr
    join campaigns c on c.organization_id = cr.organization_id and c.id = cr.campaign_id
    join room_snapshots rs on rs.organization_id = cr.organization_id and rs.id = cr.room_snapshot_id
      and rs.campaign_id = cr.campaign_id and rs.discovered_post_id = cr.discovered_post_id
    where cr.organization_id = ${discoveredPosts.organizationId} and cr.discovered_post_id = ${discoveredPosts.id}
      and cr.campaign_id = ${discoveredPosts.campaignId} and cr.verdict = 'confirmed'
      and rs.join_lens in ('room', 'both') and ${usableRoom(now)}), 0)`;
}

/** Stored evidence only. Historical counts are labelled stale and never
 * contribute to selection, while an existing draft can keep its explanation. */
export async function roomEvidence(tx: Tx, postIds: number[], now = Date.now()) {
  if (!postIds.length) return new Map<number, { joinLens: JoinLens; room: RoomEvidence }>();
  const rows = await tx.execute<{
    postId: number; joinLens: JoinLens; fits: number; judged: number; pages: 1 | 2;
    commentsRead: number; totalComments: number; coverage: RoomEvidence["coverage"]; current: boolean;
    firstPageFits: number | null;
  }>(sql`select cr.discovered_post_id::int as "postId", rs.join_lens as "joinLens",
      (rs.summary->>'fits')::int as fits, (rs.summary->>'judged')::int as judged,
      (rs.summary->'firstPageRoom'->>'fits')::int as "firstPageFits",
      rs.pages, rs.comments_read as "commentsRead", rs.total_comments as "totalComments", rs.coverage,
      (${usableRoom(now)}) as current
    from candidate_research cr
    join campaigns c on c.organization_id = cr.organization_id and c.id = cr.campaign_id
    join room_snapshots rs on rs.organization_id = cr.organization_id and rs.id = cr.room_snapshot_id
      and rs.campaign_id = cr.campaign_id and rs.discovered_post_id = cr.discovered_post_id
    where cr.discovered_post_id in (${sql.join(postIds.map((id) => sql`${id}`), sql`, `)}) and cr.verdict = 'confirmed'`);
  return new Map(rows.rows.map(({ postId, joinLens, current, firstPageFits, ...room }) =>
    [postId, { joinLens, room: { ...room, stale: !current, ...(firstPageFits === null ? {} : { firstPageFits }) } }]));
}
