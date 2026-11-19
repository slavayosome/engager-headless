import { inArray, sql, type SQL } from "drizzle-orm";
import { incomingComments, type ConversationRelationship } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { MESSAGE_SENDS } from "../actions/keys";
import { escapeSearch } from "../operations/threads";
import { parsePersonKey, personKey, personKeySql } from "./key";
import { roomExcludedSql } from "../rooms/eligibility";

/**
 * THE PEOPLE ENGAGER KNOWS, one row each, keyed by `people/key.ts` — and
 * among them everyone a campaign touched.
 *
 * A person is every row that names them by their LinkedIn identity — a post
 * of theirs, a comment, reply, like, invite or DM of ours to them, a reply,
 * invitation or DM of theirs, their conversation — gathered under one key. A
 * member urn some row ties to exactly one profile id is that profile's person;
 * an urn two profiles claim stays a person of its own, never a guess. Nothing
 * here joins on a name, and nothing needs a conversation, so a reply on a campaign
 * that does not run on its strategy is a person like any other.
 *
 * Reads only, inside the caller's `withOrg`; every table read is under RLS.
 */

/** What one touch was, from the owner's side. */
export type TouchKind =
  | "our_comment"
  | "our_like"
  | "our_reply"
  | "our_invite"
  | "our_acceptance"
  | "our_dm"
  | "their_reply"
  | "their_invite"
  | "their_acceptance"
  | "their_dm"
  /** The conversation opened — the touch of last resort, behind any other. */
  | "conversation";

export type PersonTouch = { at: number; kind: TouchKind; campaignId: number | null };

/** What the newest read of the person's profile showed: how their invitation
 *  switch stood, and when. */
export type LatestRead = {
  /** Their top card's invitation switch where that read held one: `withdrawn`
   *  is an invitation of ours taken back, and LinkedIn takes no new one for
   *  three weeks. Null where no read of theirs showed the switch. */
  invitation: "connect" | "pending" | "withdrawn" | null;
  /** The read showed the account's own page. */
  self: boolean;
  /** When the read was made; null where none was. */
  at: number | null;
};

export type Person = {
  /** The key every surface links the person by: `p.` whenever any of their
   *  rows, or a row sharing their member urn, carries a profile id. */
  canonicalKey: string;
  profileId: string | null;
  memberUrn: string | null;
  /** The reply that is the whole person, for an `r.` key. */
  incomingCommentId: number | null;
  /** The newest non-empty name any of their rows carries. */
  name: string | null;
  firstName: string | null;
  initials: string;
  headline: string | null;
  company: string | null;
  profileUrl: string | null;
  /** Their open conversation's, else what a read of their profile last showed. */
  relationship: ConversationRelationship;
  /** That read: its invitation switch and its time. */
  latestRead: LatestRead;
  /** Their open conversation, else their latest closed one (`personConversationOn`'s
   *  order). */
  conversationId: number | null;
  /** Every campaign that touched them, the most recent first. */
  campaigns: Array<{ id: number; name: string }>;
  doNotEngage: boolean;
  /** The newest touch — within the listed campaign, for `listPeople` with
   *  one. Null for someone only matched, never touched. */
  lastTouch: PersonTouch | null;
};

export type PeoplePage = {
  people: Person[];
  /** Everyone the filters keep, across every page. */
  total: number;
  nextCursor: string | null;
};

/** One kind of row that names a person: where it is read from, the identity
 *  it carries and, for a touch, what happened and when. */
type Source = {
  from: SQL;
  where?: SQL;
  profileId: SQL;
  memberUrn?: SQL;
  incomingCommentId?: SQL;
  at: SQL;
  /** Null for a row that only names the person: it makes them known, never
   *  touched. */
  touch: SQL | null;
  campaignId?: SQL;
  name?: SQL;
  headline?: SQL;
  profileUrl?: SQL;
};

const SOURCES: readonly Source[] = [
  // A newly found Signal is addressable for an owner-requested invite note.
  // Discovery is not contact and must not put it in the Inbox's people list.
  {
    from: sql`leads lead`,
    profileId: sql`lead.profile_id`,
    at: sql`lead.last_signal_at`,
    touch: null,
    name: sql`lead.name`,
    headline: sql`lead.headline`,
  },
  // Pending or cancelled room work stays addressable from its saved message,
  // without restoring expired discovery details or calling a queue a touch.
  {
    from: sql`messages m`,
    where: sql`m.kind = 'room_reply' and m.room_reply_target is not null
      and m.status not in ('rejected', 'suppressed_dryrun')
      and (m.status <> 'posted' or m.external_urn is null)`,
    profileId: sql`m.target_profile_id`,
    memberUrn: sql`m.room_reply_target->>'memberUrn'`,
    at: sql`m.created_at`,
    touch: null,
  },
  {
    from: sql`messages m`,
    where: sql`m.kind = 'room_reply' and m.status = 'posted' and m.external_urn is not null`,
    profileId: sql`m.target_profile_id`,
    memberUrn: sql`m.room_reply_target->>'memberUrn'`,
    at: sql`m.posted_at`,
    touch: sql`'our_reply'`,
    campaignId: sql`m.campaign_id`,
  },
  // Our comment on their post, its like with it. A draft the owner turned
  // down and a shadow campaign's rehearsal are not a touch.
  {
    from: sql`messages m
      left join discovered_posts post
        on post.organization_id = m.organization_id and post.id = m.discovered_post_id`,
    where: sql`m.kind = 'comment' and m.status not in ('rejected', 'suppressed_dryrun')`,
    profileId: sql`coalesce(nullif(post.author_profile_id, ''), m.target_profile_id)`,
    at: sql`coalesce(m.posted_at, m.created_at)`,
    touch: sql`'our_comment'`,
    campaignId: sql`m.campaign_id`,
    name: sql`post.author_name`,
    headline: sql`post.author_headline`,
  },
  // Our answer to their reply: the replier, by the reply's own identity.
  {
    from: sql`messages m
      join incoming_comments reply
        on reply.organization_id = m.organization_id and reply.id = m.incoming_comment_id`,
    where: sql`m.kind = 'reply' and m.status not in ('rejected', 'suppressed_dryrun')`,
    profileId: sql`reply.author_profile_id`,
    memberUrn: sql`reply.author_member_urn`,
    incomingCommentId: sql`reply.id`,
    at: sql`coalesce(m.posted_at, m.created_at)`,
    touch: sql`'our_reply'`,
    campaignId: sql`m.campaign_id`,
    name: sql`reply.author_name`,
  },
  // Their reply under our comment, or their comment on our post — held,
  // ignored and dismissed ones too: they wrote it whatever we did.
  {
    from: sql`incoming_comments reply`,
    profileId: sql`reply.author_profile_id`,
    memberUrn: sql`reply.author_member_urn`,
    incomingCommentId: sql`reply.id`,
    at: sql`reply.received_at`,
    touch: sql`'their_reply'`,
    campaignId: sql`reply.campaign_id`,
    name: sql`reply.author_name`,
  },
  // A like, invite, acceptance, DM or follow-up of ours on the action
  // ledger, unless it was called off before anything went.
  {
    from: sql`actions action`,
    where: sql`action.status <> 'cancelled' and action.kind not in (${sql.join(MESSAGE_SENDS.map((kind) => sql`${kind}`), sql`, `)})`,
    profileId: sql`action.author_profile_id`,
    at: sql`coalesce(action.settled_at, action.created_at)`,
    touch: sql`case action.kind
      when 'like_target' then 'our_like'
      when 'invite' then 'our_invite'
      when 'accept_invite' then 'our_acceptance'
      else 'our_dm' end`,
    campaignId: sql`action.campaign_id`,
  },
  // Their invitation to the account, under the campaign of the conversation it
  // was tied to, if any.
  {
    from: sql`incoming_invitations invitation
      left join conversations conversation
        on conversation.organization_id = invitation.organization_id and conversation.id = invitation.conversation_id`,
    profileId: sql`invitation.sender_profile_id`,
    at: sql`coalesce(invitation.received_at, invitation.first_observed_at)`,
    touch: sql`'their_invite'`,
    campaignId: sql`conversation.owning_campaign_id`,
    name: sql`invitation.sender_display_name`,
    profileUrl: sql`invitation.sender_url`,
  },
  {
    from: sql`conversations conversation`,
    profileId: sql`conversation.author_profile_id`,
    at: sql`conversation.created_at`,
    touch: sql`'conversation'`,
    campaignId: sql`conversation.owning_campaign_id`,
  },
  // What only their conversation's log holds: a DM of theirs, and their accepting
  // our invite. Every DM and invite of ours, the owner's own included, is a
  // ledger row above.
  {
    from: sql`conversation_events event
      join conversations conversation
        on conversation.organization_id = event.organization_id and conversation.id = event.conversation_id`,
    where: sql`event.type in ('inbound_message_observed', 'invitation_accepted')`,
    profileId: sql`conversation.author_profile_id`,
    at: sql`event.occurred_at`,
    touch: sql`case event.type when 'inbound_message_observed' then 'their_dm' else 'their_acceptance' end`,
    campaignId: sql`conversation.owning_campaign_id`,
  },
  // A post of theirs Scout found: it names them, and touches them only once
  // we comment on it.
  {
    from: sql`discovered_posts post`,
    profileId: sql`post.author_profile_id`,
    at: sql`post.discovered_at`,
    touch: null,
    name: sql`post.author_name`,
    headline: sql`post.author_headline`,
  },
  // A room match makes someone known, with no contact implied.
  // A post-only skip changes the room display, never this person's identity.
  {
    from: sql`room_members member
      join room_snapshots snapshot on snapshot.organization_id = member.organization_id and snapshot.id = member.snapshot_id
      join candidate_research research on research.organization_id = snapshot.organization_id
        and research.discovered_post_id = snapshot.discovered_post_id and research.room_snapshot_id = snapshot.id
      join campaigns campaign on campaign.organization_id = snapshot.organization_id and campaign.id = snapshot.campaign_id
      left join member_profiles alias on alias.urn = member.member_urn`,
    where: sql`member.fit = 'fits'
      and snapshot.read_at > extract(epoch from statement_timestamp()) * 1000 - 7776000000
      and not ${roomExcludedSql(sql`coalesce(member.profile_id, alias.profile_id)`, sql`member.member_urn`, sql`member.person_key`, sql`member_profiles`)}
      and not exists (select 1 from engaged_profiles blocked where blocked.do_not_engage
        and blocked.profile_id = coalesce(member.profile_id, alias.profile_id))
      and not exists (select 1 from conversations closed where closed.channel_id = campaign.channel_id
        and closed.author_profile_id = coalesce(member.profile_id, alias.profile_id) and closed.closed_reason is not null
        and not exists (select 1 from conversations newer where newer.channel_id = closed.channel_id
          and newer.author_profile_id = closed.author_profile_id and newer.id > closed.id))`,
    profileId: sql`member.profile_id`,
    memberUrn: sql`member.member_urn`,
    at: sql`snapshot.read_at`,
    touch: null,
    name: sql`member.name`,
    headline: sql`member.headline`,
  },
  // Someone in one of the account's conversations.
  {
    from: sql`dm_threads thread
      cross join lateral jsonb_array_elements(thread.participants) as participant`,
    where: sql`participant->>'isSelf' = 'false'`,
    profileId: sql`participant->>'profileId'`,
    memberUrn: sql`participant->>'memberUrn'`,
    at: sql`thread.last_observed_at`,
    touch: null,
    name: sql`participant->>'displayName'`,
    profileUrl: sql`participant->>'profileUrl'`,
  },
  // Someone the owner listed by hand, do-not-engage included.
  {
    from: sql`room_exclusions excluded`,
    profileId: sql`case when excluded.person_key like 'p.%' then substring(excluded.person_key from 3) end`,
    memberUrn: sql`case when excluded.identity_key like 'm.%' then 'urn:li:fsd_profile:' || substring(excluded.identity_key from 3) end`,
    at: sql`excluded.created_at`,
    touch: null,
  },
  {
    from: sql`engaged_profiles listed`,
    profileId: sql`listed.profile_id`,
    at: sql`coalesce(listed.last_engaged_at, listed.first_engaged_at, 0)`,
    touch: null,
    name: sql`listed.name`,
  },
];

/**
 * The member urns the org's rows tie to exactly one profile id, as the body
 * of a `member_profiles (urn, profile_id)` CTE: a reply that carried both, a
 * conversation read that showed both, or a read of the person's own profile
 * that verified both (`memberProfile.ts`). An urn two profiles claim is no
 * one's.
 */
export function memberProfilesSql(): SQL {
  return sql`
    select pair.urn, min(pair.profile_id) as profile_id
    from (
      select reply.author_member_urn as urn, reply.author_profile_id as profile_id
      from incoming_comments reply
      where reply.author_member_urn is not null and nullif(reply.author_profile_id, '') is not null
      union
      select participant->>'memberUrn', participant->>'profileId'
      from dm_threads thread
        cross join lateral jsonb_array_elements(thread.participants) as participant
      where participant->>'isSelf' = 'false'
        and participant->>'memberUrn' is not null
        and nullif(participant->>'profileId', '') is not null
        -- A member id a conversation kept in a profile's place names no profile.
        and participant->>'profileId' <> lower(split_part(participant->>'memberUrn', ':', 4))
      union
      select author.identity_evidence->'read'->>'profileUrn', author.profile_id
      from author_profiles author
      where author.identity_evidence->'read'->'profile'->>'verified' = 'true'
        and author.identity_evidence->'read'->'profile'->>'id' = author.profile_id
        and author.identity_evidence->'read'->>'profileUrn' is not null
      union
      select member.member_urn, member.profile_id
      from room_members member
      join room_snapshots snapshot on snapshot.organization_id = member.organization_id and snapshot.id = member.snapshot_id
      where member.member_urn is not null and nullif(member.profile_id, '') is not null
      union
      select receipt.target_member_urn, receipt.target_profile_id
      from rate_limit_ledger receipt
      where receipt.target_member_urn is not null and nullif(receipt.target_profile_id, '') is not null
      union
      select message.room_reply_target->>'memberUrn', message.target_profile_id
      from messages message
      where message.kind = 'room_reply' and message.status not in ('rejected', 'suppressed_dryrun')
        and message.room_reply_target->>'memberUrn' is not null and nullif(message.target_profile_id, '') is not null
      union
      select 'urn:li:fsd_profile:' || substring(excluded.identity_key from 3), substring(excluded.person_key from 3)
      from room_exclusions excluded where excluded.identity_key like 'm.%' and excluded.person_key like 'p.%'
    ) pair
    group by pair.urn
    having count(distinct pair.profile_id) = 1`;
}

/** The ids a set of canonical keys names people by, as a source's rows carry
 *  them. */
type Identity = { profileIds: string[]; memberUrns: string[]; incomingCommentIds: number[] };

function inList(expr: SQL, values: readonly (string | number)[]): SQL {
  return values.length === 0
    ? sql`false`
    : sql`${expr} in (${sql.join(
        values.map((value) => sql`${value}`),
        sql`, `,
      )})`;
}

/** Narrows a source to the rows that may name one of `identity`'s people —
 *  by id only; the key each row resolves to decides. */
function identityFilter(source: Source, identity: Identity): SQL {
  const clauses = [inList(source.profileId, identity.profileIds)];
  if (source.memberUrn) {
    clauses.push(
      inList(source.memberUrn, identity.memberUrns),
      sql`${source.memberUrn} in
        (select urn from member_profiles where ${inList(sql`profile_id`, identity.profileIds)})`,
    );
  }
  if (source.incomingCommentId) clauses.push(inList(source.incomingCommentId, identity.incomingCommentIds));
  return sql`(${sql.join(clauses, sql` or `)})`;
}

function rowsOf(source: Source, ordinal: number, identity: Identity | undefined): SQL {
  const conditions = [source.where ?? sql`true`];
  if (identity) conditions.push(identityFilter(source, identity));
  return sql`
    select
      nullif(${source.profileId}, '')::text as profile_id,
      ${source.memberUrn ?? sql`null`}::text as member_urn,
      ${source.incomingCommentId ?? sql`null`}::bigint as incoming_comment_id,
      ${source.at}::bigint as at,
      ${source.touch ?? sql`null`}::text as touch,
      ${source.campaignId ?? sql`null`}::bigint as campaign_id,
      ${source.name ?? sql`null`}::text as name,
      ${source.headline ?? sql`null`}::text as headline,
      ${source.profileUrl ?? sql`null`}::text as profile_url,
      ${ordinal}::int as source
    from ${source.from}
    where ${sql.join(conditions, sql` and `)}`;
}

/** The newest of a column across a person's rows, skipping empties. */
function newest(column: SQL): SQL {
  return sql`(array_agg(btrim(${column}) order by at desc, source)
    filter (where nullif(btrim(${column}), '') is not null))[1]`;
}

/** Whom a read is about. */
type Scope =
  /** The people these canonical keys name, touched or only known. */
  | { keys: string[]; identity: Identity }
  /** Everyone touched, or everyone touched in one campaign — whose touches
   *  are then the only ones that count. */
  | { campaignId: number | undefined };

/** Every person in `scope`, one row each, as the CTEs up to `projected`. */
function peopleSql(scope: Scope): SQL {
  const touched =
    "keys" in scope || scope.campaignId === undefined
      ? sql`touch is not null`
      : sql`touch is not null and campaign_id = ${scope.campaignId}`;
  // The conversation opening is a touch only where nothing else is: it never
  // stands in front of the reply or the invite it opened on.
  const lastTouch = (column: SQL) =>
    sql`(array_agg(${column} order by touch = 'conversation', at desc, source) filter (where ${touched}))[1]`;
  return sql`
    with member_profiles as (${memberProfilesSql()}),
    person_rows as (
      ${sql.join(
        SOURCES.map((source, ordinal) => rowsOf(source, ordinal, "keys" in scope ? scope.identity : undefined)),
        sql` union all `,
      )}
    ),
    keyed as (
      select ${personKeySql({
        profileId: sql`coalesce(named.profile_id, alias.profile_id)`,
        memberUrn: sql`named.member_urn`,
        incomingCommentId: sql`named.incoming_comment_id`,
      })} as key, named.*
      from person_rows named
      left join member_profiles alias on named.profile_id is null and alias.urn = named.member_urn
    ),
    people as (
      select
        key,
        case when key like 'p.%' then substring(key from 3) end as profile_id,
        (array_agg(member_urn order by at desc, source) filter (where member_urn is not null))[1] as member_urn,
        ${newest(sql`name`)} as name,
        ${newest(sql`headline`)} as headline,
        ${newest(sql`profile_url`)} as profile_url,
        ${lastTouch(sql`at`)} as last_touch_at,
        ${lastTouch(sql`touch`)} as last_touch,
        ${lastTouch(sql`campaign_id`)} as last_touch_campaign_id
      from keyed
      where ${"keys" in scope ? inList(sql`key`, scope.keys) : sql`key in (select key from keyed where ${touched})`}
      group by key
    ),
    person_campaigns as (
      select touched.key,
        json_agg(json_build_object('id', campaign.id, 'name', campaign.name) order by touched.at desc, campaign.id)
          as campaign_list
      from (
        select key, campaign_id, max(at) as at
        from keyed
        where key is not null and touch is not null and campaign_id is not null
        group by key, campaign_id
      ) touched
      join campaigns campaign on campaign.id = touched.campaign_id
      group by touched.key
    ),
    projected as (
      select
        people.key,
        people.profile_id,
        coalesce(
          people.member_urn,
          case when people.key like 'm.%' then 'urn:li:fsd_profile:' || substring(people.key from 3) end
        ) as member_urn,
        case when people.key like 'r.%' then substring(people.key from 3)::int end as incoming_comment_id,
        people.name,
        coalesce(nullif(btrim(author.headline), ''), people.headline, nullif(btrim(listed.headline), ''))
          as headline,
        nullif(btrim(listed.company), '') as company,
        coalesce(nullif(listed.url, ''), author.identity_evidence #>> '{read,profile,url}', people.profile_url)
          as profile_url,
        coalesce(
          case when conversation.closed_reason is null then conversation.relationship end,
          author.relationship,
          'unknown'
        ) as relationship,
        case
          when conversation.closed_reason is null and conversation.relationship is not null
            then conversation.relationship_checked_at
          else author.relationship_checked_at
        end::float8 as relationship_checked_at,
        -- The person's own copy follows the newest read that could tell, so
        -- it holds the switch and the degree the conversation's read showed too.
        case
          when author.relationship_checked_at is not null
            and author.relationship_checked_at >= coalesce(
              case when conversation.closed_reason is null then conversation.relationship_checked_at end, 0)
            then author.identity_evidence #>> '{read,invitation}'
        end as read_invitation,
        author.identity_evidence #>> '{read,degree}' = 'self' as read_self,
        conversation.id::float8 as conversation_id,
        (coalesce(listed.do_not_engage, false) or ${roomExcludedSql(sql`people.profile_id`, sql`people.member_urn`, sql`people.key`, sql`member_profiles`)}) as do_not_engage,
        coalesce(person_campaigns.campaign_list, '[]'::json) as campaigns,
        people.last_touch_at::float8 as last_touch_at,
        people.last_touch,
        people.last_touch_campaign_id::float8 as last_touch_campaign_id
      from people
      left join person_campaigns on person_campaigns.key = people.key
      left join engaged_profiles listed on listed.profile_id = people.profile_id
      left join author_profiles author on author.profile_id = people.profile_id
      left join lateral (
        select conversation.id, conversation.relationship, conversation.relationship_checked_at, conversation.closed_reason
        from conversations conversation
        where conversation.author_profile_id = people.profile_id
        order by conversation.closed_reason is null desc, conversation.id desc
        limit 1
      ) conversation on true
    )`;
}

type ProjectedRow = {
  key: string;
  profile_id: string | null;
  member_urn: string | null;
  incoming_comment_id: number | null;
  name: string | null;
  headline: string | null;
  company: string | null;
  profile_url: string | null;
  relationship: ConversationRelationship;
  relationship_checked_at: number | null;
  read_invitation: string | null;
  read_self: boolean | null;
  conversation_id: number | null;
  do_not_engage: boolean;
  campaigns: Array<{ id: number; name: string }>;
  last_touch_at: number | null;
  last_touch: TouchKind | null;
  last_touch_campaign_id: number | null;
};

/** The words of a name that start with a letter and end without a dot: an
 *  emoji is no name, and a title or an initial written with one ("Dr.",
 *  "J.") is no first name. */
function nameWords(name: string | null): string[] {
  return (name ?? "").split(/\s+/).filter((word) => /^\p{L}/u.test(word) && !word.endsWith("."));
}

/** What a person is called in a sentence: their name's first word, and null
 *  for a name with no word in it. */
export function personFirstName(name: string | null): string | null {
  return nameWords(name)[0] ?? null;
}

/** The initials a name shows as, where Engager has no face: its first two
 *  words' first letters, and "?" for a name with no word in it. */
export function personInitials(name: string | null): string {
  const words = nameWords(name);
  return words.length === 0
    ? "?"
    : words
        .slice(0, 2)
        .map((word) => Array.from(word)[0]!)
        .join("")
        .toLocaleUpperCase("en");
}

function personOf(row: ProjectedRow): Person {
  return {
    canonicalKey: row.key,
    profileId: row.profile_id,
    memberUrn: row.member_urn,
    incomingCommentId: row.incoming_comment_id,
    name: row.name,
    firstName: personFirstName(row.name),
    initials: personInitials(row.name),
    headline: row.headline,
    company: row.company,
    // The profile id is the public identifier of their page.
    profileUrl:
      row.profile_url ?? (row.profile_id === null ? null : `https://www.linkedin.com/in/${row.profile_id}/`),
    relationship: row.relationship,
    latestRead: {
      invitation:
        row.read_invitation === "connect" || row.read_invitation === "pending" || row.read_invitation === "withdrawn"
          ? row.read_invitation
          : null,
      self: row.read_self === true,
      at: row.relationship_checked_at,
    },
    conversationId: row.conversation_id,
    campaigns: row.campaigns,
    doNotEngage: row.do_not_engage,
    lastTouch:
      row.last_touch_at === null || row.last_touch === null
        ? null
        : { at: row.last_touch_at, kind: row.last_touch, campaignId: row.last_touch_campaign_id },
  };
}

/** Someone no row the directory reads names, as another read names them: a
 *  comment Scout judged may fit makes no one known, yet the Inbox lists its
 *  writer behind its weaker-fit fold. */
export function namedPerson(key: string, named: { name: string | null; headline: string | null }): Person {
  const parsed = parsePersonKey(key);
  const profileId = parsed?.kind === "profile" ? parsed.profileId : null;
  return personOf({
    key,
    profile_id: profileId,
    member_urn: parsed?.kind === "member" ? parsed.memberUrn : null,
    incoming_comment_id: parsed?.kind === "reply" ? parsed.incomingCommentId : null,
    name: named.name,
    headline: named.headline,
    company: null,
    profile_url: null,
    relationship: "unknown",
    relationship_checked_at: null,
    read_invitation: null,
    read_self: null,
    conversation_id: null,
    do_not_engage: false,
    campaigns: [],
    last_touch_at: null,
    last_touch: null,
    last_touch_campaign_id: null,
  });
}

/** The profile id each member urn is known by, where one is. */
async function memberProfiles(tx: Tx, urns: readonly string[]): Promise<Map<string, string>> {
  if (urns.length === 0) return new Map();
  const { rows } = await tx.execute(sql`
    with member_profiles as (${memberProfilesSql()})
    select urn, profile_id from member_profiles where ${inList(sql`urn`, urns)}`);
  return new Map(
    (rows as Array<{ urn: string; profile_id: string }>).map((row) => [row.urn, row.profile_id] as const),
  );
}

/**
 * The key each of `keys` resolves to: an `m.` key whose urn a row ties to one
 * profile id becomes that `p.` key, and an `r.` key becomes the key its reply
 * names, which is itself only while the reply carries neither id. A key that
 * is no person's (`setup`, a malformed one) is left out.
 */
export async function resolvePersonKeys(tx: Tx, keys: readonly string[]): Promise<Map<string, string>> {
  const parsed = keys.flatMap((key) => {
    const person = parsePersonKey(key);
    return person ? [[key, person] as const] : [];
  });
  const replyIds = parsed.flatMap(([, person]) => (person.kind === "reply" ? [person.incomingCommentId] : []));
  const replies =
    replyIds.length === 0
      ? []
      : await tx
          .select({
            incomingCommentId: incomingComments.id,
            profileId: incomingComments.authorProfileId,
            memberUrn: incomingComments.authorMemberUrn,
          })
          .from(incomingComments)
          .where(inArray(incomingComments.id, replyIds));
  const named = new Map(
    parsed.map(([key, person]) => {
      if (person.kind !== "reply") return [key, key] as const;
      const reply = replies.find((row) => row.incomingCommentId === person.incomingCommentId);
      return [key, reply ? personKey(reply)! : key] as const;
    }),
  );
  const urns = [...named.values()].flatMap((key) => {
    const person = parsePersonKey(key);
    return person?.kind === "member" ? [person.memberUrn] : [];
  });
  const profiles = await memberProfiles(tx, urns);
  return new Map(
    [...named].map(([asked, key]) => {
      const person = parsePersonKey(key);
      const profileId = person?.kind === "member" ? profiles.get(person.memberUrn) : undefined;
      return [asked, profileId === undefined ? key : `p.${profileId}`] as const;
    }),
  );
}

/** Each of `keys` that names someone any row knows — touched or only matched —
 *  under the key it was asked by. */
export async function findPeople(tx: Tx, keys: readonly string[]): Promise<Map<string, Person>> {
  const resolved = await resolvePersonKeys(tx, keys);
  const canonical = [...new Set(resolved.values())];
  if (canonical.length === 0) return new Map();
  const identity: Identity = { profileIds: [], memberUrns: [], incomingCommentIds: [] };
  for (const key of canonical) {
    const person = parsePersonKey(key)!;
    if (person.kind === "profile") identity.profileIds.push(person.profileId);
    else if (person.kind === "member") identity.memberUrns.push(person.memberUrn);
    else identity.incomingCommentIds.push(person.incomingCommentId);
  }
  const { rows } = await tx.execute(sql`
    ${peopleSql({ keys: canonical, identity })}
    select * from projected`);
  const people = new Map((rows as ProjectedRow[]).map((row) => [row.key, personOf(row)] as const));
  return new Map(
    [...resolved].flatMap(([asked, key]) => {
      const person = people.get(key);
      return person ? [[asked, person] as const] : [];
    }),
  );
}

/** The person `key` names; null when no row knows them. */
export async function findPerson(tx: Tx, key: string): Promise<Person | null> {
  return (await findPeople(tx, [key])).get(key) ?? null;
}

type PeopleCursor = { at: number; key: string };

function encodeCursor(cursor: PeopleCursor): string {
  return Buffer.from(JSON.stringify([cursor.at, cursor.key]), "utf8").toString("base64url");
}

function decodeCursor(value: string | null | undefined): PeopleCursor | null {
  if (!value || value.length > 2_000) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      !Number.isSafeInteger(parsed[0]) ||
      typeof parsed[1] !== "string" ||
      parsePersonKey(parsed[1]) === null
    ) {
      return null;
    }
    return { at: parsed[0], key: parsed[1] };
  } catch {
    return null;
  }
}

/**
 * Everyone a campaign touched, newest touch first, keyset-paged. A touch is a
 * comment or like of ours on their post, a reply of theirs, an invite or a DM
 * either way, or a conversation; a post Scout matched and nobody commented on is
 * not one. `campaignId` keeps the people touched in that campaign, and their
 * order and last touch are that campaign's. `search` matches the name,
 * headline or company shown, case-insensitively — a filter on people already
 * told apart, never a way to join them.
 */
export async function listPeople(
  tx: Tx,
  opts: { campaignId?: number; search?: string; cursor?: string | null; limit: number },
): Promise<PeoplePage> {
  const limit = Math.min(100, Math.max(1, Math.floor(opts.limit)));
  const cursor = decodeCursor(opts.cursor);
  const search = opts.search?.trim();
  const pattern = search ? `%${escapeSearch(search)}%` : null;
  const { rows } = await tx.execute(sql`
    ${peopleSql({ campaignId: opts.campaignId })},
    listed as (
      select * from projected
      where ${
        pattern === null
          ? sql`true`
          : sql`(name ilike ${pattern} escape '\\' or headline ilike ${pattern} escape '\\'
              or company ilike ${pattern} escape '\\')`
      }
    )
    select (select count(*) from listed)::int as total, page.*
    from (select 1) as one
    left join lateral (
      select * from listed
      where ${cursor ? sql`(last_touch_at, key) < (${cursor.at}, ${cursor.key})` : sql`true`}
      order by last_touch_at desc, key desc
      limit ${limit + 1}
    ) page on true`);
  const page = (rows as Array<ProjectedRow & { total: number }>).filter((row) => row.key !== null);
  const people = page.slice(0, limit).map(personOf);
  const last = people.at(-1);
  return {
    people,
    total: (rows as Array<{ total: number }>)[0]?.total ?? 0,
    nextCursor:
      page.length > limit && last?.lastTouch ? encodeCursor({ at: last.lastTouch.at, key: last.canonicalKey }) : null,
  };
}
