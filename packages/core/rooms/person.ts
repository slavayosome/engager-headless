import { inArray, sql } from "drizzle-orm";
import { campaigns, roomMembers } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { audienceProfile } from "../audience/model";
import { memberProfilesSql, resolvePersonKeys } from "../people/directory";
import { linkedinPostUrl } from "../linkedin/postUrl";
import { roomContactSql, roomExcludedSql, ROOM_RETENTION_MS } from "./eligibility";

export type PersonRoom = {
  postId: number;
  campaignId: number;
  campaignName: string;
  author: string | null;
  authorProfileId: string | null;
  postUrn: string;
  url: string | null;
  opening: string | null;
  postedAt: number | null;
  readAt: number;
  totalComments: number;
  fits: number;
  judged: number;
  comment: string;
  roomMemberId: number;
  parentCommentUrn: string | null;
  reactions: number;
  pain: { id: string; position: number; text: string } | null;
  contacted: boolean;
  stale: boolean;
  /** How their comment fits the campaign's audience. */
  fit: "fits" | "maybe";
  /** The room read's one sentence on why they fit; null where it gave none. */
  reason: string | null;
  /** The owner skipped them on this post. */
  skipped: boolean;
};

/** The room history shared by the full person page and the Inbox. Current
 * pointers avoid duplicate rereads; confirmed contact retains its existing
 * history policy, while untouched evidence expires at ninety days. */
export async function personRooms(tx: Tx, personKey: string, now = Date.now()): Promise<PersonRoom[]> {
  const canonical = (await resolvePersonKeys(tx, [personKey])).get(personKey);
  return canonical ? ((await peopleRooms(tx, [canonical], now)).get(canonical) ?? []) : [];
}

/** `personRooms` for many people at once, by the canonical keys given: one
 *  read, and each campaign's sources and joinable posts read once for all
 *  of them. */
export async function peopleRooms(
  tx: Tx,
  canonicalKeys: readonly string[],
  now = Date.now(),
): Promise<Map<string, PersonRoom[]>> {
  if (canonicalKeys.length === 0) return new Map();
  const profile = sql`coalesce(member.profile_id, alias.profile_id)`;
  const key = sql`coalesce('p.' || ${profile}, member.person_key)`;
  const contact = roomContactSql(profile, sql`member.member_urn`, sql`campaign.channel_id`);
  const { rows } = await tx.execute<{
    personKey: string; fit: PersonRoom["fit"]; reason: string | null; skipped: boolean; postId: number; campaignId: number; campaignName: string; author: string | null; authorProfileId: string | null;
    postUrn: string; url: string | null; opening: string | null; postedAt: number | null; readAt: number;
    totalComments: number; fits: number; judged: number; comments: (typeof roomMembers.$inferSelect)["comments"];
    evidenceRefs: string[]; painId: string | null; contacted: boolean; stale: boolean; roomMemberId: number;
  }>(sql`with member_profiles as (${memberProfilesSql()})
    select distinct on (${key}, post.id) ${key} as "personKey", member.fit, member.reason, member.owner_skipped_at is not null as skipped,
      post.id::int as "postId", campaign.id::int as "campaignId", campaign.name as "campaignName",
      post.author_name as author, post.author_profile_id as "authorProfileId", post.post_urn as "postUrn", post.url,
      coalesce(research.thread->>'fullText', post.content_text) as opening, post.posted_at::float8 as "postedAt",
      snapshot.read_at::float8 as "readAt", snapshot.total_comments as "totalComments",
      (snapshot.summary->>'fits')::int as fits, (snapshot.summary->>'judged')::int as judged,
      member.id::int as "roomMemberId", member.comments, member.evidence_refs as "evidenceRefs", member.pain_id as "painId", ${contact} as contacted,
      (snapshot.audience_revision <> campaign.audience_revision
        or snapshot.read_at <= ${now - ROOM_RETENTION_MS}
        or (select count(*) from room_members retained where retained.snapshot_id = snapshot.id) <> (snapshot.summary->>'judged')::int) as stale
    from room_members member join room_snapshots snapshot on snapshot.id = member.snapshot_id
    join candidate_research research on research.room_snapshot_id = snapshot.id and research.discovered_post_id = snapshot.discovered_post_id
    join campaigns campaign on campaign.id = snapshot.campaign_id
    join discovered_posts post on post.id = snapshot.discovered_post_id
    left join member_profiles alias on alias.urn = member.member_urn
    where ${key} in (${sql.join(canonicalKeys.map((value) => sql`${value}`), sql`, `)}) and member.fit in ('fits', 'maybe')
      and not ${roomExcludedSql(profile, sql`member.member_urn`, key, sql`member_profiles`)}
      and not exists (select 1 from engaged_profiles blocked where blocked.profile_id = ${profile} and blocked.do_not_engage)
      and (snapshot.read_at > ${now - ROOM_RETENTION_MS} or ${contact})
    order by ${key}, post.id, (member.fit = 'fits') desc, member.id desc`);
  if (!rows.length) return new Map();
  const campaignRows = await tx.select().from(campaigns).where(inArray(campaigns.id, [...new Set(rows.map((row) => row.campaignId))]));
  const byPerson = new Map<string, PersonRoom[]>();
  for (const { personKey, comments, evidenceRefs, painId, ...row } of rows) {
    const campaign = campaignRows.find((campaign) => campaign.id === row.campaignId)!;
    const pains = audienceProfile(campaign).pains.filter((pain) => pain.status === "active");
    const position = pains.findIndex((pain) => pain.id === painId);
    const pain = position < 0 ? null : { id: pains[position]!.id, text: pains[position]!.text, position: position + 1 };
    const comment = comments.find((comment) => evidenceRefs.includes(comment.ref)) ?? comments[0];
    byPerson.set(personKey, [...(byPerson.get(personKey) ?? []), { ...row, url: linkedinPostUrl(row.url, row.postUrn),
      comment: comment?.text ?? "", parentCommentUrn: comment?.commentUrn ?? null, reactions: comment?.reactions ?? 0, pain,
    }]);
  }
  for (const found of byPerson.values()) found.sort((a, b) => b.readAt - a.readAt || a.postId - b.postId);
  return byPerson;
}
