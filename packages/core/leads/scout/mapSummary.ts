import { and, desc, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import {
  SIGNAL_DROP_REASONS,
  audienceRevisions,
  campaigns,
  channels,
  searchPlans,
  searchChanges,
  searches,
  type LanguageType,
  type SearchLane,
  type Search,
  type SearchChange,
  type SignalDropReason,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { effectiveAudience } from "../../audience/model";
import { eligiblePersonSql } from "../../discovery/roomPopulation";
import { linkedinPostUrl } from "../../linkedin/postUrl";
import { memberProfilesSql } from "../../people/directory";
import {
  discoverPagesToday,
  profileReadsFreeAt,
  profileReadsToday,
  type SearchLimitSource,
} from "../../ratelimit/ledger";
import { withinActiveWindow } from "../../time";
import {
  COMPANY_PAGES_NOT_READ,
  SEARCH_SEGMENTS,
  MAP_MAX_RETIRED_PER_PLAN,
  MAP_MAX_STARTED_PER_PLAN,
  MAP_MAX_SWEEPING,
  canUndo,
  dismissedAuthors,
  searchSegment,
  mapRow,
  segmentCounts,
  segmentRows,
  type SearchMapRow,
  type SearchSegment,
} from "./map";
import { leadScreenGate, pipelineCounts, type PipelineCounts } from "./queues";
import { agentHeld, type AgentFault } from "./wake";

/**
 * THE SEARCHES TAB'S READ for a campaign that finds leads: every row of its
 * search map by segment and by the kind of language it catches, what each
 * found in people, what is working, what the Scout changed and where buyers
 * gather. Every count is people, from `lead_signals` and `leads` as they stand,
 * never a stored total; a person on do-not-engage, excluded, or on a conversation
 * the owner closed is in none, and an erased one has nothing left to count.
 * It writes nothing and reads nothing from LinkedIn. Names, phrases and words
 * come back as data, for plain-text rendering. The former posts search summary
 * keeps serving Find posts.
 */

const DAY = 86_400_000;
/** How far back a row's people are counted: the board's "last 90 days". */
const PEOPLE_WINDOW_DAYS = 90;
/** The intro's and What's working's window. */
const WEEK_DAYS = 7;
/** A row whose people are all through the pipeline, this many and no lead
 *  among them, is not finding the audience. */
const NOT_FINDING_AFTER = 10;
/** Where buyers gather: rooms of the last 30 days, authors of the last 90. */
const ROOMS_WINDOW_DAYS = 30;
const GATHER_MOST = 10;
const CHANGES_MOST = 50;

/** The groups a segment's rows fall into, in the board's order. A phrase
 *  groups by the kind of language it catches; a creator or company page is an
 *  Audience magnet; a post the owner pointed Scout at, and a phrase learned
 *  from one, is Like a post, the phrase keeping its kind of language for the
 *  sweep. There is no Topic group. */
export const MAP_GROUPS = [
  "pain",
  "desired_outcome",
  "failed_alternative",
  "comparison",
  "direct_ask",
  "audience_magnet",
  "like_a_post",
] as const;
export type MapGroup = (typeof MAP_GROUPS)[number];

export function mapGroup(row: Pick<Search, "lane" | "languageType" | "origin">): MapGroup {
  if (row.lane === "creators" || row.lane === "competitors") return "audience_magnet";
  return row.lane === "keywords" && row.languageType && row.origin !== "like_a_post" ? row.languageType : "like_a_post";
}

/** What a row reads: a keyword, an author's posts, a company page's posts,
 *  or one post's thread. */
export type MapRowKind = "keyword" | "author" | "company_page" | "post";
const KIND: Record<SearchLane, MapRowKind> = {
  keywords: "keyword",
  creators: "author",
  competitors: "company_page",
  one_thread: "post",
};

export type MapRowStatus = "not_read_yet" | "working" | "not_finding" | "waiting" | "refused" | "retired";

/** People a row found, over its window. `inPipeline` are those the pipeline
 *  has not finished with: a word waiting for the screen, or a person who
 *  passed it and has not been judged, unless a step set them aside or they
 *  belong to another campaign's lead. */
export type MapPeople = { found: number; inPipeline: number; leads: number; contacted: number; cameBack: number };

/** The rooms a row heard buyers in, over its window: the threads whose
 *  comments, read through the row, held people Research judged buyers, and how
 *  many buyers those were — as Where buyers gather counts an author's. */
export type MapRooms = { buyers: number; rooms: number };

export type MapSummaryRow = SearchMapRow & {
  group: MapGroup;
  kind: MapRowKind;
  displayName: string | null;
  addedAt: number;
  sort: Search["sort"];
  datePosted: Search["datePosted"];
  /** When a waiting row is read again from the top. */
  nextReadAt: number | null;
  /** Active, and refused by LinkedIn once: tried again. */
  refusedOnce: boolean;
  status: MapRowStatus;
  /** Why it stands: Scout's or the owner's reason, else the pain it serves;
   *  for a row not finding the audience, who screened out. */
  why: string | null;
  /** The pain it serves, in the Audience’s words. */
  painText: string | null;
  people: MapPeople;
  rooms: MapRooms;
  /** Of the people found, how many screened out, and the reason most of
   *  them did. */
  screenedOut: number;
  commonestDrop: SignalDropReason | null;
};

export type MapChange = Pick<
  SearchChange,
  "id" | "phraseId" | "runId" | "actor" | "action" | "term" | "rationale" | "refusal" | "undoes" | "createdAt"
> & {
  /** The lane of the row it changed: a phrase, or a place Scout reads. */
  lane: SearchLane | null;
  /** The kind of language of the phrase it changed. */
  languageType: LanguageType | null;
  /** The row it changed is retired now. */
  rowRetired: boolean;
  /** The owner can undo it (`undoMapChange`). */
  undoable: boolean;
};

export type GatherAuthor = {
  /** Their profile id, or a company page's. */
  profileId: string;
  name: string | null;
  lane: "creators" | "competitors";
  buyers: number;
  rooms: number;
  /** A row of the map reads them. */
  following: boolean;
};

export type GatherRoom = {
  postUrn: string;
  /** The post on LinkedIn: the link Scout captured when it is one, else the
   *  post's permalink. */
  url: string;
  /** The post's opening, when Scout met the post itself. */
  opening: string | null;
  comments: number | null;
  buyers: number;
  readAt: number;
  /** A One thread row of the map follows it. */
  following: boolean;
};

export type SearchMapSummary = {
  campaignId: number;
  segments: Record<SearchSegment, { count: number; groups: Array<{ group: MapGroup; rows: MapSummaryRow[] }> }>;
  /** People found in the last seven days, and the leads among them: the
   *  intro's numbers and What's working's. */
  week: { people: number; leads: number };
  working: {
    activeRows: number;
    profileReadsToday: number;
    /** The account's search pages in the rolling day, against its limit —
     *  0 turns searching off — and whether the limit is the account's own
     *  setting or the environment's override. */
    searchPages: { today: number; dailyLimit: number; limitSource: SearchLimitSource };
    note: string | null;
    /** The newest plan could not be asked for, so nothing on the map
     *  changed by it. */
    planFailed: boolean;
    maxPostAgeDays: number;
    /** The bounds every plan of the Scout's keeps; the owner keeps none. */
    limits: { startsPerRun: number; retiresPerRun: number; sweeping: number };
  };
  changes: MapChange[];
  gather: { authors: GatherAuthor[]; rooms: GatherRoom[] };
};

/** A signal's person: their profile, as the signal names it or the member
 *  directory ties its member urn to one. */
export const PERSON = sql`coalesce(signal.profile_id, alias.profile_id)`;
/** Within the owner's reach, by the rule every Find leads stage reads. */
const REACHABLE = eligiblePersonSql(PERSON, sql`signal.member_urn`, sql`coalesce('p.' || ${PERSON}, signal.person_key)`, "all");

/** A signal whose person is known by a profile (a member urn no row ties to
 *  one waits out of sight) and is within the owner's reach, judged or not. */
const KNOWN_AND_REACHABLE = sql`${PERSON} is not null and ${REACHABLE}`;

/**
 * WHAT COUNTS A PERSON AS FOUND, wherever a campaign counts people found — its
 * Overview's Found and its Searches tab's People found are one number because
 * they read this one filter: a signal the screen judged (passed or dropped,
 * so not one that expired or could not be screened), whose person is known by
 * a profile (a member urn no row ties to one waits out of sight), and who is
 * within the owner's reach. Over `lead_signals signal`, `campaigns current`
 * and the `member_profiles` CTE joined as `alias`.
 */
export const FOUND_SIGNAL = sql`signal.verdict in ('passed', 'dropped') and ${KNOWN_AND_REACHABLE}`;

type PeopleRow = MapPeople & { screenedOut: number } & Record<SignalDropReason, number>;

/**
 * The people a campaign's signals found since `since` whom the screen judged,
 * by the row that found them, or all together: found, the leads among them (a
 * buyer at Lead or further), those contacted, those who came back. A person
 * found twice counts once in a group, and under each row that found them.
 * `inPipeline` also counts the people the screen has not reached, and those who
 * passed it and wait to be merged or judged, bar those a step set aside and
 * those merged into a lead of another campaign, which this one has no more to
 * do with; a Quick campaign judges no one, so its people leave the pipeline at
 * the screen.
 */
async function peopleFound(tx: Tx, campaignId: number, since: number, byPhrase: boolean): Promise<Array<PeopleRow & { phraseId: number | null }>> {
  const phrase: SQL = byPhrase ? sql`signal.phrase_id` : sql`null::bigint`;
  const stage = sql`coalesce(lead.stage, 'relationship')`;
  const read = await tx.execute<MapPeople & { phraseId: number | null; passed: boolean; dropReason: SignalDropReason | null }>(sql`
    with member_profiles as (${memberProfilesSql()}),
    met as (
      select ${phrase} as phrase_id, ${PERSON} as person,
        bool_or(signal.verdict in ('passed', 'dropped')) as screened,
        bool_or(signal.verdict = 'pending') as waiting,
        bool_or(signal.verdict = 'passed') as passed,
        bool_or(signal.verdict = 'passed' and signal.lead_id is null) as unmerged,
        max(signal.seen_at) filter (where signal.verdict = 'passed') as "newestPassed",
        (array_agg(signal.drop_reason order by coalesce(signal.said_at, signal.seen_at) desc, signal.id desc)
          filter (where signal.verdict = 'dropped'))[1] as drop_reason
      from lead_signals signal
      join campaigns current on current.id = signal.campaign_id
      left join member_profiles alias on alias.urn = signal.member_urn
      where signal.campaign_id = ${campaignId} and signal.seen_at >= ${since}
        and ${KNOWN_AND_REACHABLE} and ${byPhrase ? sql`signal.phrase_id is not null` : sql`true`}
      group by 1, 2
    )
    select met.phrase_id::float8 as "phraseId", met.passed,
      case when met.passed then null else met.drop_reason end as "dropReason",
      count(*) filter (where met.screened)::int as found,
      count(*) filter (where met.waiting or (met.passed and campaign.search_depth <> 'quick' and ((lead.id is null and met.unmerged) or (
        lead.pipeline_hold is null and lead.rating is distinct from 'not_a_fit'
        and ((lead.stage = 'signal' and (lead.role is null or lead.role = 'buyer'))
          or (lead.stage in ('lead', 'contacted', 'no_answer', 'relationship') and lead.role = 'buyer' and reading.profile_read is not null))
        and (lead.qualification is null or met."newestPassed" > coalesce((lead.qualification ->> 'at')::bigint, 0))
      ))))::int as "inPipeline",
      count(*) filter (where met.screened and lead.role = 'buyer' and ${stage} in ('lead', 'contacted', 'relationship', 'no_answer'))::int as leads,
      count(*) filter (where met.screened and lead.id is not null and ${stage} in ('contacted', 'no_answer', 'relationship'))::int as contacted,
      count(*) filter (where met.screened and lead.id is not null and ${stage} = 'relationship')::int as "cameBack"
    from met
    join campaigns campaign on campaign.id = ${campaignId}
    left join leads lead on lead.profile_id = met.person and lead.campaign_id = ${campaignId} and lead.origin = 'find_leads'
    left join author_profiles reading on reading.organization_id = lead.organization_id and reading.profile_id = lead.profile_id
    group by 1, 2, 3`);
  // One row per row of the map and way the screen judged its people: summed,
  // and the people who screened out told apart by the reason they did.
  const byRow = new Map<number | null, PeopleRow>();
  for (const one of read.rows) {
    const key = one.phraseId === null ? null : Number(one.phraseId);
    const into = byRow.get(key) ?? { ...NO_PEOPLE };
    into.found += one.found;
    into.inPipeline += one.inPipeline;
    into.leads += one.leads;
    into.contacted += one.contacted;
    into.cameBack += one.cameBack;
    if (!one.passed) {
      into.screenedOut += one.found;
      if (one.dropReason) into[one.dropReason] += one.found;
    }
    byRow.set(key, into);
  }
  return [...byRow].map(([phraseId, people]) => ({ ...people, phraseId }));
}

/** Each row's {@link MapRooms} since `since`, by the row's id; a row that
 *  heard no buyer in a thread is absent. */
async function roomsByRow(tx: Tx, campaignId: number, since: number): Promise<Map<number, MapRooms>> {
  const read = await tx.execute<MapRooms & { phraseId: number }>(sql`
    with member_profiles as (${memberProfilesSql()})
    select signal.phrase_id::float8 as "phraseId",
      count(distinct ${PERSON})::int as buyers, count(distinct signal.post_urn)::int as rooms
    from lead_signals signal
    join campaigns current on current.id = signal.campaign_id
    left join member_profiles alias on alias.urn = signal.member_urn
    join leads lead on lead.profile_id = ${PERSON} and lead.campaign_id = signal.campaign_id
    where signal.campaign_id = ${campaignId} and signal.phrase_id is not null
      and signal.kind = 'comment' and signal.verdict = 'passed' and signal.seen_at >= ${since}
      and lead.role = 'buyer' and lead.researched_at is not null and ${REACHABLE}
    group by signal.phrase_id`);
  return new Map(read.rows.map((row) => [Number(row.phraseId), { buyers: row.buyers, rooms: row.rooms }] as const));
}

const NO_ROOMS: MapRooms = { buyers: 0, rooms: 0 };

const NO_PEOPLE: PeopleRow = {
  found: 0,
  inPipeline: 0,
  leads: 0,
  contacted: 0,
  cameBack: 0,
  screenedOut: 0,
  ...(Object.fromEntries(SIGNAL_DROP_REASONS.map((reason) => [reason, 0])) as Record<SignalDropReason, number>),
};

function commonest(people: PeopleRow): SignalDropReason | null {
  let best: SignalDropReason | null = null;
  for (const reason of SIGNAL_DROP_REASONS) if (people[reason] > (best ? people[best] : 0)) best = reason;
  return best;
}

/** What a row that finds no one says first, when the reason most of its people
 *  dropped for is one of these. */
const ANSWERED_BY: Partial<Record<SignalDropReason, string>> = {
  not_audience: "People outside your audience answer this phrase, not buyers: ",
  selling_similar: "Vendors answer this phrase, not buyers: ",
};

/** When the campaign's Audience took the revision in force: what a row's
 *  people are counted under, as Find posts counts a room judged under it. */
async function audienceSince(tx: Tx, campaignId: number, revision: number): Promise<number> {
  const [row] = await tx
    .select({ at: audienceRevisions.createdAt })
    .from(audienceRevisions)
    .where(and(eq(audienceRevisions.campaignId, campaignId), eq(audienceRevisions.revision, revision)));
  return row?.at ?? 0;
}

/**
 * Where buyers gather: the threads whose comments held people Research judged
 * buyers, over the last 30 days, and the authors of those threads over the
 * last 90 — a person whose post Scout met, or the creator or company page a
 * row read — each with their buyers and rooms, and whether the map follows
 * them. Strongest first, at most ten of each; an author the owner dismissed
 * for the campaign is left out.
 */
export async function buyerGathering(tx: Tx, campaignId: number, now: number): Promise<{ authors: GatherAuthor[]; rooms: GatherRoom[] }> {
  const read = await tx.execute<{
    kind: "room" | "author";
    key: string;
    name: string | null;
    lane: "creators" | "competitors" | null;
    buyers: number;
    rooms: number;
    last: number;
  }>(sql`
    with member_profiles as (${memberProfilesSql()}),
    heard as (
      select signal.post_urn as post, ${PERSON} as person, signal.phrase_id, signal.seen_at
      from lead_signals signal
      join campaigns current on current.id = signal.campaign_id
      left join member_profiles alias on alias.urn = signal.member_urn
      join leads lead on lead.profile_id = ${PERSON} and lead.campaign_id = signal.campaign_id
      where signal.campaign_id = ${campaignId} and signal.kind = 'comment' and signal.verdict = 'passed'
        and signal.seen_at >= ${now - PEOPLE_WINDOW_DAYS * DAY}
        and lead.role = 'buyer' and lead.researched_at is not null and ${REACHABLE}
    ),
    authored as (
      select distinct on (heard.post) heard.post,
        coalesce(own.profile_id, source.target_ref) as author,
        coalesce(own.name, source.display_name, source.term) as name,
        case when own.profile_id is not null then 'creators' else source.lane end as lane
      from heard
      left join lateral (
        select post.profile_id, post.name from lead_signals post
        where post.campaign_id = ${campaignId} and post.post_urn = heard.post and post.kind = 'post' and post.profile_id is not null
        order by post.id limit 1
      ) own on true
      left join searches source on source.id = heard.phrase_id and source.lane in ('creators', 'competitors')
      order by heard.post, source.id nulls last
    )
    select 'room' as kind, heard.post as key, null as name, null as lane,
      count(distinct heard.person)::int as buyers, 1 as rooms, max(heard.seen_at)::float8 as last
    from heard where heard.seen_at >= ${now - ROOMS_WINDOW_DAYS * DAY}
    group by heard.post
    union all
    select 'author', authored.author, max(authored.name), max(authored.lane),
      count(distinct heard.person)::int, count(distinct heard.post)::int, max(heard.seen_at)::float8
    from heard join authored on authored.post = heard.post
    join campaigns current on current.id = ${campaignId}
    where authored.author is not null
      and ${eligiblePersonSql(sql`authored.author`, sql`null::text`, sql`'p.' || authored.author`, "all")}
    group by authored.author
    order by buyers desc, last desc, key
  `);
  const dismissed = await dismissedAuthors(tx, campaignId);
  const roomRows = read.rows.filter((row) => row.kind === "room").slice(0, GATHER_MOST);
  const authorRows = read.rows
    .filter((row) => row.kind === "author" && !dismissed.has(row.key.toLowerCase()))
    .slice(0, GATHER_MOST);

  const followed = await tx
    .select({ lane: searches.lane, targetRef: searches.targetRef })
    .from(searches)
    .where(
      and(
        eq(searches.campaignId, campaignId),
        isNotNull(searches.targetRef),
        sql`${searches.status} <> 'retired'`,
      ),
    );
  const follows = (lanes: readonly SearchLane[], ref: string) =>
    followed.some((row) => lanes.includes(row.lane) && row.targetRef!.toLowerCase() === ref.toLowerCase());

  const posts = roomRows.map((row) => row.key);
  const about = posts.length
    ? await tx.execute<{ post: string; opening: string | null; url: string | null; comments: number | null; read_at: number | null }>(sql`
        select signal.post_urn as post,
          (array_agg(left(signal.words, 200) order by signal.id) filter (where signal.kind = 'post'))[1] as opening,
          (array_agg(signal.url order by signal.id) filter (where signal.url is not null))[1] as url,
          max(signal.comment_count)::int as comments,
          (select max(thread.read_at) from lead_thread_reads thread
            where thread.campaign_id = ${campaignId} and thread.post_urn = signal.post_urn)::float8 as read_at
        from lead_signals signal
        where signal.campaign_id = ${campaignId} and signal.post_urn in (${sql.join(posts.map((post) => sql`${post}`), sql`, `)})
        group by signal.post_urn`)
    : { rows: [] };
  const aboutPost = new Map(about.rows.map((row) => [row.post, row] as const));
  return {
    rooms: roomRows.map((row) => {
      const post = aboutPost.get(row.key);
      return {
        postUrn: row.key,
        // A captured link is LinkedIn text: only an https link on linkedin.com is
        // kept, else the post's own permalink, as Find posts' rooms read theirs.
        url: linkedinPostUrl(post?.url && /^https:\/\/([a-z]+\.)?linkedin\.com\//i.test(post.url) ? post.url : null, row.key),
        opening: post?.opening ?? null,
        comments: post?.comments ?? null,
        buyers: row.buyers,
        readAt: post?.read_at ?? Number(row.last),
        following: follows(["one_thread"], row.key),
      };
    }),
    authors: authorRows.map((row) => ({
      profileId: row.key,
      name: row.name,
      lane: row.lane ?? "creators",
      buyers: row.buyers,
      rooms: row.rooms,
      following: follows(["creators", "competitors"], row.key),
    })),
  };
}

/**
 * The Searches tab of a campaign that finds leads. Null when the campaign is
 * none of this organization's. Each segment is listed whole, up to 200 rows,
 * grouped; a row's people, and the rooms it heard buyers in, are counted over
 * the last 90 days under the Audience in force, and its status is Not read
 * yet before its first read, Waiting, Refused or Retired by its segment, Not
 * finding your audience once ten of its people are through the pipeline and
 * none became a lead, and Working otherwise.
 */
export async function searchMapSummary(tx: Tx, campaignId: number, now: number): Promise<SearchMapSummary | null> {
  const [campaign] = await tx.select().from(campaigns).where(eq(campaigns.id, campaignId));
  if (!campaign) return null;
  const pains = new Map(effectiveAudience(campaign).profile.pains.map((pain) => [pain.id, pain.text] as const));
  const since = Math.max(now - PEOPLE_WINDOW_DAYS * DAY, await audienceSince(tx, campaignId, campaign.audienceRevision));
  const byPhrase = new Map((await peopleFound(tx, campaignId, since, true)).map((row) => [row.phraseId!, row] as const));
  const rooms = await roomsByRow(tx, campaignId, since);
  const [week] = await peopleFound(tx, campaignId, now - WEEK_DAYS * DAY, false);

  const counts = await segmentCounts(tx, campaignId);
  const segments = {} as SearchMapSummary["segments"];
  for (const segment of SEARCH_SEGMENTS) {
    const rows = (await segmentRows(tx, campaignId, segment)).map((row) => summaryRow(row, byPhrase.get(row.id) ?? NO_PEOPLE, rooms.get(row.id) ?? NO_ROOMS, pains));
    segments[segment] = {
      count: counts[segment],
      groups: MAP_GROUPS.flatMap((group) => {
        const held = rows.filter((row) => row.group === group);
        return held.length > 0 ? [{ group, rows: held }] : [];
      }),
    };
  }

  // The newest plan says whether the last call could be answered; the note
  // shown is the newest one that says anything.
  const [latest] = await tx
    .select({ failed: searchPlans.failed })
    .from(searchPlans)
    .where(eq(searchPlans.campaignId, campaignId))
    .orderBy(desc(searchPlans.createdAt), desc(searchPlans.id))
    .limit(1);
  const [noted] = await tx
    .select({ note: searchPlans.note })
    .from(searchPlans)
    .where(and(eq(searchPlans.campaignId, campaignId), sql`${searchPlans.note} <> ''`))
    .orderBy(desc(searchPlans.createdAt), desc(searchPlans.id))
    .limit(1);
  const pages = await discoverPagesToday(tx, campaignId, now);
  return {
    campaignId,
    segments,
    week: { people: week?.found ?? 0, leads: week?.leads ?? 0 },
    working: {
      activeRows: counts.active,
      profileReadsToday: campaign.channelId === null ? 0 : await profileReadsToday(tx, campaign.channelId, now),
      searchPages: { today: pages.used, dailyLimit: pages.limit, limitSource: pages.source },
      note: noted?.note ?? null,
      planFailed: latest?.failed ?? false,
      maxPostAgeDays: campaign.maxPostAgeDays,
      limits: { startsPerRun: MAP_MAX_STARTED_PER_PLAN, retiresPerRun: MAP_MAX_RETIRED_PER_PLAN, sweeping: MAP_MAX_SWEEPING },
    },
    changes: await mapChanges(tx, campaignId),
    gather: await buyerGathering(tx, campaignId, now),
  };
}

/** Whether Scout reads new posts: not while the screen has more waiting than
 *  it should be given, or Read profiles more people than the day has reads
 *  for, nor while the owner's agent holds Screen or Judge. */
export type PipelineGate = "open" | "waiting_for_screen" | "waiting_for_agent";

/** Where a campaign's people wait, and what binds each step. */
export type PipelineSummary = {
  counts: PipelineCounts;
  /** The account's profile reads in the rolling day against its cap, and when
   *  the next one frees once none is left. */
  profileReads: { today: number; dailyCap: number; freesAt: number | null };
  /** When the account's active hours next open; null inside them. */
  windowOpensAt: number | null;
  /** The zone the account's hours are in. */
  timeZone: string | null;
  /** The words waiting for the screen at which Scout stops reading new posts. */
  screenGate: number;
  gate: PipelineGate;
  /** What keeps the owner's agent from answering, while it holds a step. */
  agentFault: AgentFault | null;
};

/**
 * The Searches tab's pipeline section for a campaign that finds leads: what
 * waits at each step, the account's profile reads against its day, whether its
 * active hours are open, and whether Scout is reading new posts or waiting.
 * Null when the campaign is none of this organization's. It writes nothing,
 * reads nothing from LinkedIn and calls no model.
 */
export async function pipelineSummary(tx: Tx, campaignId: number, now: number): Promise<PipelineSummary | null> {
  const [campaign] = await tx.select().from(campaigns).where(eq(campaigns.id, campaignId));
  if (!campaign) return null;
  const [channel] =
    campaign.channelId === null ? [] : await tx.select().from(channels).where(eq(channels.id, campaign.channelId));
  const counts = await pipelineCounts(tx, campaignId, now);
  const today = channel ? await profileReadsToday(tx, channel.id, now) : 0;
  const dailyCap = channel?.dailyProfileReadCap ?? 0;
  const readsLeft = Math.max(0, dailyCap - today);
  const window = channel ? withinActiveWindow(now, channel.activeHours, channel.activeDays) : null;
  const screenGate = leadScreenGate();
  const agentFault = await agentHeld(tx, campaign.organizationId, campaignId);
  const shut = counts.toScreen >= screenGate || counts.waitingForRead > readsLeft;
  return {
    counts,
    profileReads: {
      today,
      dailyCap,
      freesAt: channel && dailyCap > 0 && readsLeft === 0 ? await profileReadsFreeAt(tx, channel.id, now) : null,
    },
    windowOpensAt: window && !window.within ? window.nextOpen : null,
    timeZone: channel?.activeHours?.tz || null,
    screenGate,
    gate: agentFault ? "waiting_for_agent" : shut ? "waiting_for_screen" : "open",
    agentFault,
  };
}

function summaryRow(row: Search, people: PeopleRow, rooms: MapRooms, pains: ReadonlyMap<string, string>): MapSummaryRow {
  const segment = searchSegment(row);
  // A row can say it finds nobody only once its people are through the
  // pipeline: someone still waiting to be judged may yet be a lead.
  const notFinding =
    segment === "active" && row.lastCheckedAt !== null && people.inPipeline === 0 && people.found >= NOT_FINDING_AFTER && people.leads === 0;
  const status: MapRowStatus =
    segment !== "active" ? segment : row.lastCheckedAt === null ? "not_read_yet" : notFinding ? "not_finding" : "working";
  const drop = commonest(people);
  const pain = row.painId ? pains.get(row.painId) : undefined;
  return {
    ...mapRow(row),
    group: mapGroup(row),
    kind: KIND[row.lane],
    displayName: row.displayName,
    addedAt: row.createdAt,
    sort: row.sort,
    datePosted: row.datePosted,
    nextReadAt: segment === "waiting" ? row.nextReadAt : null,
    refusedOnce: segment === "active" && row.refusedAt !== null,
    status,
    why:
      row.lane === "competitors" && segment !== "retired"
        ? COMPANY_PAGES_NOT_READ
        : notFinding
          ? `${(drop && ANSWERED_BY[drop]) ?? ""}${people.screenedOut} of ${people.found} people screened out.`
          : (row.rationale ?? (pain ? `Serves “${pain}”.` : null)),
    painText: pain ?? null,
    people: { found: people.found, inPipeline: people.inPipeline, leads: people.leads, contacted: people.contacted, cameBack: people.cameBack },
    rooms,
    screenedOut: people.screenedOut,
    commonestDrop: drop,
  };
}

/** What changed on the map, newest first, each with whether the owner can
 *  undo it: the campaign's latest, or every change one run's plan made — what
 *  the run's page lists. */
export async function mapChanges(tx: Tx, campaignId: number, opts: { runId?: number } = {}): Promise<MapChange[]> {
  const changes = await tx
    .select()
    .from(searchChanges)
    .where(
      and(
        eq(searchChanges.campaignId, campaignId),
        opts.runId === undefined ? undefined : eq(searchChanges.runId, opts.runId),
      ),
    )
    .orderBy(desc(searchChanges.createdAt), desc(searchChanges.id))
    .limit(CHANGES_MOST);
  const phraseIds = [...new Set(changes.flatMap((change) => (change.phraseId === null ? [] : [change.phraseId])))];
  const rows = phraseIds.length
    ? await tx
        .select({
          id: searches.id,
          lane: searches.lane,
          languageType: searches.languageType,
          status: searches.status,
          retiredBy: searches.retiredBy,
        })
        .from(searches)
        .where(inArray(searches.id, phraseIds))
    : [];
  const ids = changes.map((change) => change.id);
  const undone = new Set(
    ids.length
      ? (
          await tx
            .select({ undoes: searchChanges.undoes })
            .from(searchChanges)
            .where(inArray(searchChanges.undoes, ids))
        ).map((row) => row.undoes)
      : [],
  );
  return changes.map((change) => {
    const row = rows.find((candidate) => candidate.id === change.phraseId) ?? null;
    return {
      id: change.id,
      phraseId: change.phraseId,
      runId: change.runId,
      actor: change.actor,
      action: change.action,
      term: change.term,
      rationale: change.rationale,
      refusal: change.refusal,
      undoes: change.undoes,
      createdAt: change.createdAt,
      lane: row?.lane ?? null,
      languageType: row?.languageType ?? null,
      rowRetired: row?.status === "retired",
      undoable: canUndo(change, row, undone.has(change.id)),
    };
  });
}
