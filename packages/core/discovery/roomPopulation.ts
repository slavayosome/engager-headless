import { sql, type SQL } from "drizzle-orm";
import { memberProfilesSql } from "../people/directory";
import { roomContactSql, roomExcludedSql, ROOM_RETENTION_MS } from "../rooms/eligibility";

/** A post author's canonical profile id, spelled as `authorIdentity` spells it. */
export const postAuthorKeySql = sql`regexp_replace(split_part(split_part(
  regexp_replace(regexp_replace(btrim(post.author_profile_id), '^author:', ''),
    '^https?://([a-z]+[.])?linkedin[.]com/in/', ''), '?', 1), '#', 1), '/+$', '')`;

/** One rule for a comment author and a post author alike: not erased or excluded,
 * not blocked, not a conversation the owner closed, and in the contact state asked. */
export function eligiblePersonSql(profile: SQL, memberUrn: SQL, key: SQL, contactState: "all" | "touched" | "spotted") {
  return sql`not ${roomExcludedSql(profile, memberUrn, key, sql`member_profiles`)}
    and not exists (select 1 from engaged_profiles blocked where blocked.do_not_engage and blocked.profile_id = ${profile})
    and not exists (select 1 from conversations closed where closed.channel_id = current.channel_id
      and closed.author_profile_id = ${profile} and closed.closed_reason is not null
      and not exists (select 1 from conversations newer where newer.channel_id = closed.channel_id
        and newer.author_profile_id = closed.author_profile_id and newer.id > closed.id))
    and ${contactState === "all" ? sql`true` : contactState === "touched"
      ? roomContactSql(profile, memberUrn, sql`current.channel_id`)
      : sql`not ${roomContactSql(profile, memberUrn, sql`current.channel_id`)}`}`;
}

/** Current room evidence, shared by search yields and audience suggestions.
 * Historical snapshots never revive an erased, excluded or outdated person.
 * `eligible_authors` holds the authors Research judged to fit on those same
 * posts; a post author is never one of its own comment authors. `country` is where
 * a profile read placed a person, or null. */
export function roomPopulationSql(campaignId: number, opts: {
  now: number; since: number; contactState?: "all" | "touched" | "spotted";
}) {
  const profile = sql`coalesce(member.profile_id, alias.profile_id)`;
  const contactState = opts.contactState ?? "all";
  return sql`member_profiles as (${memberProfilesSql()}),
    current_rooms as (
      select snapshot.*, campaign.channel_id
      from room_snapshots snapshot
      join candidate_research research on research.organization_id = snapshot.organization_id
        and research.campaign_id = snapshot.campaign_id and research.discovered_post_id = snapshot.discovered_post_id
        and research.room_snapshot_id = snapshot.id
      join campaigns campaign on campaign.organization_id = snapshot.organization_id and campaign.id = snapshot.campaign_id
      where snapshot.campaign_id = ${campaignId} and campaign.deleted_at is null
        and snapshot.audience_revision = campaign.audience_revision
        and snapshot.read_at > ${Math.max(opts.since, opts.now - ROOM_RETENTION_MS)} and snapshot.read_at <= ${opts.now}
    ), eligible_people as (
      select current.discovered_post_id, current.id as snapshot_id, member.id as member_id,
        coalesce('p.' || ${profile}, member.person_key) as person_key,
        ${profile} as profile_id, member.member_urn, member.fit, member.pain_id, member.country
      from current_rooms current
      join room_members member on member.snapshot_id = current.id
      left join member_profiles alias on alias.urn = member.member_urn
      where ${eligiblePersonSql(profile, sql`member.member_urn`, sql`member.person_key`, contactState)}
    ), eligible_authors as (
      select current.discovered_post_id, current.id as snapshot_id, 'p.' || ${postAuthorKeySql} as person_key,
        place.country as country
      from current_rooms current
      join candidate_research research on research.organization_id = current.organization_id
        and research.discovered_post_id = current.discovered_post_id and research.room_snapshot_id = current.id
      join discovered_posts post on post.organization_id = current.organization_id and post.id = current.discovered_post_id
      left join author_profiles place on place.organization_id = current.organization_id and place.profile_id = ${postAuthorKeySql}
      where research.author_fit = 'fits' and nullif(post.author_profile_id, '') is not null
        and ${eligiblePersonSql(postAuthorKeySql, sql`null::text`, sql`'p.' || ${postAuthorKeySql}`, contactState)}
    )`;
}
