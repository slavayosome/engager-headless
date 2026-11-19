import { LEGACY_SIGNAL_REASON } from "./legacySource";
import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import {
  actions,
  authorProfiles,
  campaigns,
  composerDrafts,
  discoveredPosts,
  draftAttempts,
  draftPlans,
  conversations,
  conversationEvents,
  SEARCH_LANES,
  LEAD_FITS,
  leads,
  leadSignals,
  searches,
  messages,
  SCOUT_INTENTS,
  type Lead,
  type LeadFirstSend,
  type LeadFit,
  type LeadOrigin,
  type LeadQualificationJson,
  type LeadRating,
  type LeadRole,
  type LeadSignalKind,
  type LeadStage,
  type LeadTier,
  type LanguageType,
  type SearchLane,
  type ScoutIntent,
  type SignalDropReason,
  type SignalVerdict,
  type WorkerRun,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { LEAD_OPENER_POST } from "../candidates/status";
import { profileReads } from "../operations/researchReads";
import { escapeSearch } from "../operations/threads";
import { memberProfilesSql, personInitials, resolvePersonKeys } from "../people/directory";
import { memberId, parsePersonKey, personKey } from "../people/key";
import { eligiblePersonSql } from "../discovery/roomPopulation";
import { authorIdentity } from "../people/key";
import { readDeclined } from "../people/declined";
import { newLead, seenAtOf } from "./newLeads";
import { MOVE_STEP, publicMove, type OpenerMove } from "./queue";
import { modeFor } from "../strategy/mode";
import { leadOrigin, leadStage } from "./read";
import { turnedAway } from "./replySource";
import { openerSignal } from "./scout/opener";
import { signalPhases, type SignalPhase } from "./scout/queues";
import { recommendedSignal } from "./source";
import { asideAmong, asideNow, standsAside, storedAside, type Aside } from "./setAside";
import { leadTemperatureOf, type Warmth } from "./temperature";

/**
 * The leads as a read sees them: the one row per person, with what Scout found
 * and what the owner's contact since has made of them. Reads only, inside the
 * caller's `withOrg`. Every name, headline and word here is LinkedIn text; a
 * caller that shows it to a model fences it first (`mcp/tools/leads.ts`).
 */

export const LEADS_PAGE = 50;
export const LEADS_MAX_PAGE = 200;
export const LEAD_SIGNALS_PAGE = 50;

export type { SignalPhase };

export type LeadView = {
  id: number;
  /** `p.<profile id>`, as the Inbox keys the same person. */
  personKey: string;
  name: string | null;
  headline: string | null;
  campaignId: number | null;
  stage: LeadStage;
  origin: LeadOrigin;
  role: LeadRole | null;
  fit: LeadFit | null;
  intent: ScoutIntent | null;
  intentAt: number | null;
  researchedAt: number | null;
  intentQuote: string | null;
  /** The hot-lead email's scoring, as stored: not the temperature. */
  tier: LeadTier;
  touchCount: number;
  lastSignalAt: number;
  /** Hot, Warm, Cold, Dormant or Declined from their words to the owner; null
   *  before the first send. */
  temperature: Warmth | "dormant" | "declined" | null;
  /** What a Dormant person was before the quiet. */
  temperatureWas: Warmth | null;
  /** When someone Declined said no. */
  declinedAt: number | null;
  lastWordsAt: number | null;
  contactedAt: number | null;
  firstSend: LeadFirstSend | null;
  relationshipAt: number | null;
  rating: LeadRating | null;
  /** Set aside now: not one whose newer words have undone it. */
  setAside: boolean;
  /** Where a Signal stands in Find leads' pipeline; null for anyone else, and
   *  for a Signal at Quick, which no phase takes. */
  pipelinePhase: SignalPhase | null;
  /** A lead on the Leads page's list the owner has not opened since they
   *  became one, or since Scout read new words of theirs (`leads/newLeads.ts`);
   *  false for anyone else. */
  new: boolean;
};

export function leadView(
  row: Lead,
  now: number,
  setAside: boolean,
  pipelinePhase: SignalPhase | null = null,
  fresh = false,
  /** When they said no, where their newest word on the offer is one. */
  declinedAt: number | null = null,
): LeadView {
  const heat = leadTemperatureOf(row, now, declinedAt);
  return {
    id: row.id,
    personKey: personKey({ profileId: row.profileId })!,
    name: row.name,
    headline: row.headline,
    campaignId: row.campaignId,
    stage: leadStage(row),
    origin: leadOrigin(row),
    role: row.role,
    fit: row.fit,
    intent: row.intent,
    intentAt: row.intentAt,
    researchedAt: row.researchedAt,
    intentQuote: row.intentQuote,
    tier: row.tier,
    touchCount: row.touchCount,
    lastSignalAt: row.lastSignalAt,
    temperature: heat?.temperature ?? null,
    temperatureWas: heat?.temperature === "dormant" ? heat.was : null,
    declinedAt: heat?.temperature === "declined" ? heat.at : null,
    lastWordsAt: row.lastWordsAt,
    contactedAt: row.contactedAt,
    firstSend: row.firstSend,
    relationshipAt: row.relationshipAt,
    rating: row.rating,
    setAside,
    pipelinePhase,
    new: fresh,
  };
}

// The order every read of the leads uses: whoever Scout made a lead of most
// recently first, then whoever said or did something most recently, then the id
// so the order never wavers. Someone not yet researched ranks after everyone
// who is.
const became = sql<number>`coalesce(${leads.researchedAt}, 0)`;
const newest = sql<number>`coalesce(${leads.intentAt}, ${leads.lastSignalAt})`;

/** Where a page ended, as the one string the next page asks from. */
function cursorOf(row: { became: number; newest: number; lead: Lead }): string {
  return Buffer.from(JSON.stringify([Number(row.became), Number(row.newest), row.lead.id])).toString("base64url");
}

function afterCursor(cursor: string): SQL {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3 || !parsed.every((part) => Number.isSafeInteger(part))) {
    throw new AppError("invalid_cursor", "That is not a page this list gave out. Start again without `before`.", 400);
  }
  const [since, at, id] = parsed as number[];
  return sql`(-${became}, -${newest}, ${leads.id}) > (${-since!}, ${-at!}, ${id})`;
}

export type LeadsPage = { leads: LeadView[]; nextBefore: string | null };

/**
 * A person a campaign that still stands found — or one past finding: a
 * Relationship (or a row today's intake wrote, which reads as one) is the
 * Inbox's whatever became of the campaign. A campaign's delete is soft and a
 * lead is one row per person, so this is what makes a deleted campaign's
 * leads go with it (US-LME-16): someone only it found, short of a
 * Relationship, leaves every list of leads, and someone another campaign also
 * found stays. Found is by their signals, and for a row with none, by the
 * campaign it follows.
 */
function foundViaLiveCampaign(): SQL {
  const signalOf = sql`signal.organization_id = ${leads.organizationId} and signal.lead_id = ${leads.id}`;
  return sql`(coalesce(${leads.stage}, 'relationship') = 'relationship'
    or exists (
      select 1 from ${leadSignals} signal join ${campaigns} finder on finder.id = signal.campaign_id
      where ${signalOf} and finder.deleted_at is null)
    or (not exists (select 1 from ${leadSignals} signal where ${signalOf})
      and not exists (select 1 from ${campaigns} finder where finder.id = ${leads.campaignId} and finder.deleted_at is not null)))`;
}

/**
 * One page of leads in the order above, found by a campaign that stands
 * (`foundViaLiveCampaign`). `stage` reads a row today's intake wrote as a
 * Relationship, as every surface does; `before` is the previous page's
 * `nextBefore`. Null when `campaignId` is none of this organization's.
 */
export async function listLeads(
  tx: Tx,
  opts: { campaignId?: number; stage?: LeadStage; limit?: number; before?: string; now?: number } = {},
): Promise<LeadsPage | null> {
  if (opts.campaignId !== undefined) {
    const [campaign] = await tx.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.id, opts.campaignId));
    if (!campaign) return null;
  }
  const limit = Math.min(opts.limit ?? LEADS_PAGE, LEADS_MAX_PAGE);
  const rows = await tx
    .select({ lead: leads, became, newest })
    .from(leads)
    .where(
      and(
        opts.campaignId === undefined ? undefined : eq(leads.campaignId, opts.campaignId),
        opts.stage === undefined ? undefined : sql`coalesce(${leads.stage}, 'relationship') = ${opts.stage}`,
        opts.before === undefined ? undefined : afterCursor(opts.before),
        foundViaLiveCampaign(),
      ),
    )
    .orderBy(desc(became), desc(newest), asc(leads.id))
    .limit(limit + 1);
  const now = opts.now ?? Date.now();
  const page = rows.slice(0, limit);
  const aside = await asideAmong(tx, page.map((row) => row.lead.id));
  const phases = await signalPhases(tx, page.map((row) => row.lead), now);
  const fresh = await newAmong(tx, page.map((row) => row.lead.id));
  const declined = await readDeclined(tx, page.map((row) => row.lead.profileId));
  return {
    leads: page.map((row) =>
      leadView(row.lead, now, aside.has(row.lead.id), phases.get(row.lead.id) ?? null, fresh.has(row.lead.id), declined.get(authorIdentity(row.lead.profileId)) ?? null),
    ),
    nextBefore: rows.length > limit ? cursorOf(page.at(-1)!) : null,
  };
}

/** The stages the Leads page lists: the people Scout handed over that have
 *  not answered. A Relationship is the Inbox's. */
export const LEADS_PAGE_STAGES = ["signal", "lead", "contacted", "no_answer"] as const satisfies readonly LeadStage[];
export type LeadPageStage = (typeof LEADS_PAGE_STAGES)[number];
const isPageStage = (stage: LeadStage): stage is LeadPageStage =>
  (LEADS_PAGE_STAGES as readonly LeadStage[]).includes(stage);
/** How many people the Leads page opens at first, and the most one address
 *  opens at once. */
export const LEADS_SHOWN = 50;
export const LEADS_SHOWN_MOST = 1_000;

/** Where Scout found the words a row shows: their own post, or their comment
 *  under someone else's — whose, when Scout knows it. */
export type FoundIn = { kind: "post" } | { kind: "comment"; author: string | null };

/** The first send of ours that reached someone, as the Contacted row says it:
 *  a comment on their post, a reply under their comment, or an invite. Our
 *  words, when it carried any. */
export type FirstSent = { kind: "comment" | "reply" | "invite"; text: string | null; at: number };

/** A lead as a row of the Leads page shows it. */
export type PageLead = LeadView & {
  initials: string;
  /** The newest words of theirs Find leads kept that the screen passed. */
  words: string | null;
  /** When they wrote those words, else when Scout read them. */
  wordsAt: number | null;
  /** When Scout read those words: a first look's round marks the rows it
   *  read "just in". */
  foundAt: number | null;
  foundIn: FoundIn | null;
  /** Their current role, as Research read it off their profile; null before. */
  title: string | null;
  company: string | null;
  /** What went out to them first; null before anything did. */
  sent: FirstSent | null;
  /** When the owner's Research press last asked for them; null with none. */
  researchRequestedAt: number | null;
  /** Where they stand aside: only on the Set aside group's rows. */
  aside: Aside | null;
};

/** One of the groups the page folds under its list: the rows it lists, and
 *  how many people it holds. */
export type PageLeadGroup = { rows: PageLead[]; count: number };

/** The Signals group, and how many of its people are in a phase: waiting for a
 *  read or being judged, every one of them and not only the rows listed. */
export type PageSignals = PageLeadGroup & { moving: number };

/** The page's people as it lists them. */
export type PageLeads = {
  /** The list's people, whoever became a lead most recently first, as far as
   *  `shown` opens. */
  leads: PageLead[];
  /** There are more of them than `shown` opened. */
  more: boolean;
  /** How many people the list holds over every page, and how many of them
   *  are new. */
  count: number;
  newCount: number;
  /** The ids of the people whose opener is drafted and waits for the owner's
   *  yes (`openerReadyIds`): the row says so. */
  openerReady: number[];
  /** The people written to and waiting on an answer, newest first send first. */
  contacted: PageLeadGroup;
  /** The people Scout has not researched: the newest ten, newest words first. */
  signals: PageSignals;
  /** The people written to who said nothing in the two weeks after our first
   *  send (`leads/lifecycle.ts`), newest first send first. */
  noAnswer: PageLeadGroup;
  /** The people set aside, newest set aside first: by the owner, until their
   *  next words, or by their rating Not a fit or A peer. */
  setAside: PageLeadGroup;
  /** How many people each filter option would list, the other filter, the
   *  search and the campaign applied. */
  options: PageLeadOptions;
};

/** How many Signals the page's fold lists: the newest. */
export const SIGNALS_SHOWN = 10;

/** The one thing the opener filter narrows by: the Leads whose opener is
 *  ready and waits for the owner's yes (`openerReadyIds`). */
export const OPENER_FILTERS = ["ready"] as const;
export type OpenerFilter = (typeof OPENER_FILTERS)[number];

/** The page's filters: how well they fit, what their words show, where Scout
 *  found them, and whether an opener waits for a yes. */
export type PageLeadFilters = {
  fit?: readonly LeadFit[];
  intent?: readonly ScoutIntent[];
  lane?: readonly SearchLane[];
  opener?: readonly OpenerFilter[];
};
export type PageLeadOptions = {
  fit: Record<LeadFit, number>;
  intent: Record<ScoutIntent, number>;
  lane: Record<SearchLane, number>;
  opener: Record<OpenerFilter, number>;
};

/** What the page's list is narrowed by. */
export type PageLeadsQuery = {
  campaignId?: number | null;
  unread?: boolean;
  q?: string | null;
  /** The Find leads run whose served leads alone are listed. */
  runId?: number | null;
  filters?: PageLeadFilters;
  now?: number;
};

/** Which of the page's people a read is over: those in its list and groups,
 *  those in the Set aside fold, or both. */
type PagePeople = "listed" | "aside" | "either";

const listedPeople = and(sql`not ${asideNow}`, or(isNull(leads.role), eq(leads.role, "buyer")))!;
// The people the owner rated A peer stand aside for it, and the fold keeps them.
const asidePeople = and(asideNow, or(isNull(leads.role), eq(leads.role, "buyer"), eq(leads.setAsideReason, "a_peer")))!;

/** The company the person's profile read names, for the page's search. */
const readCompany = sql`(select ${authorProfiles.profileRead} -> 'currentRole' ->> 'company' from ${authorProfiles}
  where ${authorProfiles.organizationId} = ${leads.organizationId} and ${authorProfiles.profileId} = ${leads.profileId})`;

/**
 * The people the Leads page is for: Find leads' own people between Signal and
 * No answer who are a buyer or not yet judged one, not set aside, and within
 * the owner's reach — not on the do-not-engage list, not an erased or
 * excluded identity, not a conversation the owner closed — and found by a campaign
 * that stands (`foundViaLiveCampaign`). A row today's intake
 * wrote has no origin and is never one of them. `q` narrows by the name,
 * headline or company shown, taken literally; `runId` to the leads one Find
 * leads run served, as its `lead_served` events name it; the filters narrow by
 * the fit Research stored, by intent, by where Scout found them and by
 * whether an opener waits for a yes (`ready`, the ids `openerReadyIds` read),
 * except the one `skip` names.
 *
 * With `people` "aside", the same people set aside instead, and with them the
 * people the owner rated A peer; "either" is both, everyone the page lists.
 */
function pageLeadsWhere(
  opts: PageLeadsQuery & { ready: readonly number[] | null },
  skip?: keyof PageLeadFilters,
  people: PagePeople = "listed",
): SQL {
  const search = opts.q?.trim();
  const pattern = search ? `%${escapeSearch(search)}%` : null;
  const fit = skip === "fit" ? [] : (opts.filters?.fit ?? []);
  const intent = skip === "intent" ? [] : (opts.filters?.intent ?? []);
  const lane = skip === "lane" ? [] : (opts.filters?.lane ?? []);
  const ready = skip === "opener" || !opts.filters?.opener?.length ? null : opts.ready;
  return and(
    eq(leads.origin, "find_leads"),
    inArray(leads.stage, [...LEADS_PAGE_STAGES]),
    people === "listed" ? listedPeople : people === "aside" ? asidePeople : or(listedPeople, asidePeople),
    opts.campaignId == null ? undefined : eq(leads.campaignId, opts.campaignId),
    opts.unread === undefined ? undefined : opts.unread ? newLead : sql`not ${newLead}`,
    pattern === null
      ? undefined
      : sql`concat_ws(' ', ${leads.name}, ${leads.headline}, ${readCompany}) ilike ${pattern} escape '\\'`,
    opts.runId == null ? undefined : servedBy(opts.runId),
    fit.length === 0 ? undefined : inArray(leads.fit, [...fit]),
    intent.length === 0 ? undefined : inArray(leads.intent, [...intent]),
    lane.length === 0 ? undefined : sql`exists (select 1 ${foundInLane(lane)})`,
    ready === null ? undefined : ready.length === 0 ? sql`false` : inArray(leads.id, [...ready]),
    inReach(),
    foundViaLiveCampaign(),
  )!;
}

/** The passed signals of the lead a phrase or source in one of `lanes` found,
 *  as a `from … where` for `exists` and for counting by lane. */
function foundInLane(lanes: readonly SearchLane[]): SQL {
  return sql`from ${leadSignals} join ${searches}
      on ${searches.organizationId} = ${leadSignals.organizationId} and ${searches.id} = ${leadSignals.phraseId}
    where ${leadSignals.organizationId} = ${leads.organizationId} and ${leadSignals.leadId} = ${leads.id}
      and ${leadSignals.verdict} = 'passed' and ${inArray(searches.lane, [...lanes])}`;
}

/** How many of the page's people each option would list: an option of one
 *  group among those the other groups keep, as a fit among those the intent,
 *  lane and opener filters keep.
 *  Filters narrow the folds too, the Set aside fold among them, so its people
 *  are counted. */
async function optionCounts(tx: Tx, opts: PageLeadsQuery & { ready: readonly number[] }): Promise<PageLeadOptions> {
  const fits = await tx
    .select({ fit: leads.fit, people: sql<number>`count(*)::int` })
    .from(leads)
    .where(and(pageLeadsWhere(opts, "fit", "either"), sql`${leads.fit} is not null`))
    .groupBy(leads.fit);
  const intents = await tx
    .select({ intent: leads.intent, people: sql<number>`count(*)::int` })
    .from(leads)
    .where(and(pageLeadsWhere(opts, "intent", "either"), sql`${leads.intent} is not null`))
    .groupBy(leads.intent);
  const lanes = await tx
    .select({ lane: searches.lane, people: sql<number>`count(distinct ${leads.id})::int` })
    .from(leads)
    .innerJoin(leadSignals, and(eq(leadSignals.organizationId, leads.organizationId), eq(leadSignals.leadId, leads.id)))
    .innerJoin(
      searches,
      and(eq(searches.organizationId, leadSignals.organizationId), eq(searches.id, leadSignals.phraseId)),
    )
    .where(and(pageLeadsWhere(opts, "lane", "either"), eq(leadSignals.verdict, "passed")))
    .groupBy(searches.lane);
  const [ready] = opts.ready.length
    ? await tx
        .select({ people: sql<number>`count(*)::int` })
        .from(leads)
        .where(and(pageLeadsWhere(opts, "opener", "either"), inArray(leads.id, [...opts.ready])))
    : [];
  const options: PageLeadOptions = {
    fit: Object.fromEntries(LEAD_FITS.map((fit) => [fit, 0])) as Record<LeadFit, number>,
    intent: Object.fromEntries(SCOUT_INTENTS.map((intent) => [intent, 0])) as Record<ScoutIntent, number>,
    lane: Object.fromEntries(SEARCH_LANES.map((lane) => [lane, 0])) as Record<SearchLane, number>,
    opener: { ready: 0 },
  };
  for (const row of fits) if (row.fit !== null) options.fit[row.fit] = row.people;
  for (const row of intents) if (row.intent !== null) options.intent[row.intent] = row.people;
  for (const row of lanes) options.lane[row.lane] = row.people;
  options.opener.ready = ready?.people ?? 0;
  return options;
}

/** The list holds the Leads: researched, judged a buyer and served. */
const inList = and(eq(leads.stage, "lead"), sql`${leads.fit} is not null`)!;

/** Which of the leads `ids` are new as the page counts them
 *  (`countNewLeads`): in its list, and not opened since they were last seen. */
async function newAmong(tx: Tx, ids: readonly number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const rows = await tx
    .select({ id: leads.id })
    .from(leads)
    .where(and(inArray(leads.id, [...ids]), pageLeadsWhere({ ready: null }), inList, newLead));
  return new Set(rows.map((row) => row.id));
}

/** When a Signal's newest words the screen passed were written, else read. */
const newestWords = sql<number>`(select max(coalesce(${leadSignals.saidAt}, ${leadSignals.seenAt}))
  from ${leadSignals} where ${leadSignals.organizationId} = ${leads.organizationId}
    and ${leadSignals.leadId} = ${leads.id} and ${leadSignals.verdict} = 'passed')`;

/**
 * The people the Leads page lists, in its one list in the order above — the
 * Leads of {@link pageLeadsWhere}, with how many it holds and how many of
 * them are new — and in the groups it folds under it: Contacted, Signals, No
 * answer and Set aside, each with its count. `shown` is how many of the list's
 * people to open (fifty at first, a thousand at most) and `more` says there
 * are others; a group lists apart. Null when `campaignId` is none of this
 * organization's. Reads only.
 */
export async function listPageLeads(
  tx: Tx,
  opts: PageLeadsQuery & { shown?: number | null; offset?: number } = {},
): Promise<PageLeads | null> {
  if (opts.campaignId != null) {
    const [campaign] = await tx.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.id, opts.campaignId));
    if (!campaign) return null;
  }
  const limit = Math.min(Math.max(opts.shown ?? LEADS_SHOWN, 1), LEADS_SHOWN_MOST);
  const now = opts.now ?? Date.now();
  const query = { ...opts, ready: await openerReadyIds(tx, opts.campaignId ?? null, now) };
  const where = pageLeadsWhere(query);
  const rows = await tx
    .select({ lead: leads, became, newest })
    .from(leads)
    .where(and(where, inList))
    .orderBy(desc(became), desc(newest), asc(leads.id))
    .limit(limit + 1)
    .offset(Math.max(0, opts.offset ?? 0));
  const [total] = await tx
    .select({ people: sql<number>`count(*)::int`, fresh: sql<number>`count(*) filter (where ${newLead})::int` })
    .from(leads)
    .where(and(where, inList));
  // Every Signal the page lists, not only the rows its fold opens: the fold's
  // head says whether any of them is in a phase.
  const signalPeople = await tx
    .select({
      id: leads.id,
      campaignId: leads.campaignId,
      stage: leads.stage,
      origin: leads.origin,
      pipelineHold: leads.pipelineHold,
      pipelineHoldNote: leads.pipelineHoldNote,
    })
    .from(leads)
    .where(and(where, eq(leads.stage, "signal")));
  const phases = await signalPhases(tx, signalPeople, now);
  const group = async (stage: "contacted" | "signal" | "no_answer", order: SQL, most: number): Promise<PageLeadGroup> => {
    const [held] = await tx
      .select({ people: sql<number>`count(*)::int` })
      .from(leads)
      .where(and(where, eq(leads.stage, stage)));
    const listed = await tx
      .select()
      .from(leads)
      .where(and(where, eq(leads.stage, stage)))
      .orderBy(order, desc(leads.id))
      .limit(most);
    return { rows: await pageLeadsOf(tx, listed, now, { phases }), count: held?.people ?? 0 };
  };
  const firstSendFirst = sql`${leads.contactedAt} desc nulls last`;
  const aside = pageLeadsWhere(query, undefined, "aside");
  const [asideHeld] = await tx.select({ people: sql<number>`count(*)::int` }).from(leads).where(aside);
  const asideListed = await tx
    .select()
    .from(leads)
    .where(aside)
    .orderBy(desc(leads.setAsideAt), desc(leads.id))
    .limit(LEADS_SHOWN_MOST);
  return {
    leads: await pageLeadsOf(tx, rows.slice(0, limit).map((row) => row.lead), now),
    more: rows.length > limit,
    count: total?.people ?? 0,
    newCount: total?.fresh ?? 0,
    openerReady: query.ready,
    contacted: await group("contacted", firstSendFirst, LEADS_SHOWN_MOST),
    signals: {
      ...(await group("signal", sql`${newestWords} desc nulls last`, SIGNALS_SHOWN)),
      moving: [...phases.values()].filter(({ phase }) => phase !== "set_aside").length,
    },
    noAnswer: await group("no_answer", firstSendFirst, LEADS_SHOWN_MOST),
    setAside: { rows: await pageLeadsOf(tx, asideListed, now, { aside: true }), count: asideHeld?.people ?? 0 },
    options: await optionCounts(tx, query),
  };
}

/** The Leads page's list and the groups it folds under it, as a read that
 *  takes one at a time names them. */
export const LEAD_GROUPS = ["leads", "contacted", "signals", "no_answer", "set_aside"] as const;
export type LeadGroup = (typeof LEAD_GROUPS)[number];

/** One group's people as far as a page opens, how many it holds under the
 *  read's own narrowing, and how many each group holds without it. */
export type LeadGroupPage = { rows: PageLead[]; count: number; counts: Record<LeadGroup, number> };

/**
 * ONE GROUP OF THE LEADS PAGE, A PAGE AT A TIME — for a reader that cannot
 * carry the whole page (`listPageLeads` lists every group at once): the same
 * people in the same order, `limit` of them from `offset`. `wordsBefore`
 * keeps only those whose newest words the screen passed are older than it,
 * which is how "everyone whose post is over three days old" is asked. Null
 * when `campaignId` is none of this organization's. Reads only.
 */
export async function listLeadGroup(
  tx: Tx,
  opts: Pick<PageLeadsQuery, "campaignId" | "unread" | "now"> & {
    group: LeadGroup;
    wordsBefore?: number;
    limit: number;
    offset?: number;
  },
): Promise<LeadGroupPage | null> {
  if (opts.campaignId != null) {
    const [campaign] = await tx.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.id, opts.campaignId));
    if (!campaign) return null;
  }
  const now = opts.now ?? Date.now();
  const query = { campaignId: opts.campaignId, unread: opts.unread, ready: null };
  const listed = pageLeadsWhere(query);
  const stage = (value: "contacted" | "signal" | "no_answer") => and(listed, eq(leads.stage, value))!;
  const firstSendFirst = sql`${leads.contactedAt} desc nulls last`;
  const groups: Record<LeadGroup, { where: SQL; order: SQL[] }> = {
    leads: { where: and(listed, inList)!, order: [desc(became), desc(newest), asc(leads.id)] },
    contacted: { where: stage("contacted"), order: [firstSendFirst, desc(leads.id)] },
    signals: { where: stage("signal"), order: [sql`${newestWords} desc nulls last`, desc(leads.id)] },
    no_answer: { where: stage("no_answer"), order: [firstSendFirst, desc(leads.id)] },
    set_aside: { where: pageLeadsWhere(query, undefined, "aside"), order: [desc(leads.setAsideAt), desc(leads.id)] },
  };
  const held = async (where: SQL | undefined) =>
    (await tx.select({ people: sql<number>`count(*)::int` }).from(leads).where(where))[0]?.people ?? 0;
  const counts = {} as Record<LeadGroup, number>;
  for (const group of LEAD_GROUPS) counts[group] = await held(groups[group].where);
  const { where, order } = groups[opts.group];
  const narrowed = opts.wordsBefore === undefined ? where : and(where, sql`${newestWords} < ${opts.wordsBefore}`);
  const rows = await tx
    .select()
    .from(leads)
    .where(narrowed)
    .orderBy(...order)
    .limit(opts.limit)
    .offset(Math.max(0, opts.offset ?? 0));
  const phases = opts.group === "signals" ? await signalPhases(tx, rows, now) : undefined;
  return {
    rows: await pageLeadsOf(tx, rows, now, { aside: opts.group === "set_aside", phases }),
    count: opts.wordsBefore === undefined ? counts[opts.group] : await held(narrowed),
    counts,
  };
}

/**
 * How many people the Leads page lists under Contacted — the first send to
 * them settled and no answer yet, not No answer — across every campaign or
 * under one: the count the Contacted group's head reads (`listPageLeads`),
 * through the same filter of who the page lists. Counts only; reads only.
 */
export async function countContactedLeads(tx: Tx, opts: { campaignId?: number | null } = {}): Promise<number> {
  const [held] = await tx
    .select({ people: sql<number>`count(*)::int` })
    .from(leads)
    .where(and(pageLeadsWhere({ campaignId: opts.campaignId, ready: null }), eq(leads.stage, "contacted")));
  return held?.people ?? 0;
}

/**
 * How many of the people the Leads page lists are new — in its list, not
 * folded under it — across every campaign or under one: the number the
 * sidebar's Leads row shows and the list's head reads (`listPageLeads`), and
 * the people `LeadView.new` says are. Counts only; reads only.
 */
export async function countNewLeads(tx: Tx, opts: { campaignId?: number | null } = {}): Promise<number> {
  const [held] = await tx
    .select({ people: sql<number>`count(*)::int` })
    .from(leads)
    .where(and(pageLeadsWhere({ campaignId: opts.campaignId, ready: null }), inList, newLead));
  return held?.people ?? 0;
}

/** The intents a drafted opener is counted by on a campaign's Overview. */
export type OpenerIntent = ScoutIntent;

/**
 * Something of ours to them is queued, going out, out or unsure — the sends
 * `readQueuedSends` reads, and the ones past them: a comment on their own
 * post, a reply under their comment (which has no post row of ours), an
 * invite. Their opener has been answered, whatever the box still holds.
 */
const sentTo = sql`(
  exists (
    select 1 from ${messages} sent join ${discoveredPosts} post on post.id = sent.discovered_post_id
    where sent.kind = 'comment' and sent.status in ('approved', 'posting', 'posted', 'needs_review')
      and post.filter_reason = ${LEAD_OPENER_POST} and post.author_profile_id = ${leads.profileId})
  or exists (
    select 1 from ${messages} sent
    where sent.kind = 'room_reply' and sent.status in ('approved', 'posting', 'posted', 'needs_review')
      and sent.room_reply_target ->> 'source' = 'lead' and (sent.room_reply_target ->> 'leadId')::bigint = ${leads.id})
  or exists (
    select 1 from ${actions} invite join ${conversations} conversation on conversation.id = invite.conversation_id
    where conversation.author_profile_id = ${leads.profileId} and invite.kind = 'invite'
      and invite.status in ('reserved', 'awaiting_review', 'approved', 'dispatching', 'confirmed', 'uncertain')))`;

/**
 * THE LEADS WHOSE OPENER IS READY: in the Leads page's list (a
 * campaign's, or everyone's), their box holds a drafted way in that waits for
 * the owner's yes, nothing of ours is on its way to them (`sentTo`), and Queue
 * is open to them by the rules it asks of a press (`queueable`): they are not
 * turned away — not a buyer, rated A peer or Not a fit, set aside
 * (`turnedAway`) — and one of the moves their words allow, a comment on their
 * post or a reply under their comment, or an invite, is a step the campaign
 * has On. A campaign's Overview counts these, and the Leads page lists them
 * under Opener ready, so the two are one read. Reads only.
 */
async function openerReadyIds(tx: Tx, campaignId: number | null, now: number): Promise<number[]> {
  const drafted = await tx
    .select()
    .from(leads)
    .where(
      and(
        pageLeadsWhere({ campaignId, ready: null }),
        inList,
        sql`not ${sentTo}`,
        sql`exists (
          select 1 from ${composerDrafts} drafted
          where drafted.organization_id = ${leads.organizationId}
            and (drafted.box_key = 'lead:' || ${leads.id} or drafted.box_key like 'lead:' || ${leads.id} || ':signal:%')
            and drafted.state = 'ready')`,
      ),
    );
  if (drafted.length === 0) return [];
  const ids = drafted.map((lead) => lead.id);
  const readyBoxes = await tx.select({ key: composerDrafts.boxKey }).from(composerDrafts)
    .where(and(eq(composerDrafts.state, "ready"), sql`split_part(${composerDrafts.boxKey}, ':', 1) = 'lead'`,
      inArray(sql`split_part(${composerDrafts.boxKey}, ':', 2)`, ids.map(String))));
  const readyKeys = new Set(readyBoxes.map((row) => row.key));
  const aside = await asideAmong(tx, ids);
  const said = await tx
    .select()
    .from(leadSignals)
    .where(and(inArray(leadSignals.leadId, ids), eq(leadSignals.verdict, "passed")))
    .orderBy(desc(sql`coalesce(${leadSignals.saidAt}, ${leadSignals.seenAt})`), desc(leadSignals.id));
  const signals = new Map<number, typeof said>();
  for (const signal of said) {
    if (signal.leadId !== null) signals.set(signal.leadId, [...(signals.get(signal.leadId) ?? []), signal]);
  }
  const modes = new Map<number, Record<OpenerMove, string>>();
  const ready: number[] = [];
  for (const lead of drafted) {
    if (turnedAway(lead, aside.has(lead.id)) !== null || lead.campaignId === null) continue;
    const passed = signals.get(lead.id) ?? [];
    const legacy = openerSignal(lead, passed);
    const sources = passed.filter((signal) => readyKeys.has(`lead:${lead.id}:signal:${signal.id}`) ||
      (signal.id === legacy?.id && readyKeys.has(`lead:${lead.id}`)));
    if (sources.length === 0) continue;
    if (!modes.has(lead.campaignId)) {
      const resolved = {} as Record<OpenerMove, string>;
      for (const move of ["comment", "reply", "invite"] as const) {
        const binding = MOVE_STEP[move];
        resolved[move] = (await modeFor(tx, { campaignId: lead.campaignId, capability: binding.capability, target: binding.target, catalogStep: binding.step })).effective ?? "off";
      }
      modes.set(lead.campaignId, resolved);
    }
    const mode = modes.get(lead.campaignId)!;
    if (sources.some((signal) => ([publicMove(signal), "invite"] as const).some((move: OpenerMove) => mode[move] !== null && mode[move] !== "off"))) {
      ready.push(lead.id);
    }
  }
  return ready;
}

/**
 * How many of one campaign's Leads asking for help, living the problem, and
 * on the topic alone have an opener ready that waits for the owner's yes
 * (US-LME-10): of the people its Leads page lists (`listPageLeads`, the
 * campaign applied), the ones its Opener ready filter lists
 * (`openerReadyIds`). Reads only.
 */
export async function openersWaiting(tx: Tx, campaignId: number, now = Date.now()): Promise<Record<OpenerIntent, number>> {
  const waiting: Record<OpenerIntent, number> = { asking: 0, has_problem: 0, topic_only: 0 };
  const ready = await openerReadyIds(tx, campaignId, now);
  if (ready.length === 0) return waiting;
  const rows = await tx
    .select({ intent: leads.intent, people: sql<number>`count(*)::int` })
    .from(leads)
    .where(and(inArray(leads.id, ready), sql`${leads.intent} is not null`))
    .groupBy(leads.intent);
  for (const row of rows) if (row.intent !== null) waiting[row.intent] = row.people;
  return waiting;
}

/** What one Find leads run served, or one Ambassador run drafted openers
 *  for, as a campaign's Activity opens its line: the best-fitting of its
 *  leads, each saying whether its opener waits for the owner's yes and what
 *  the run wrote for them, and how many it lists in all. */
export type RunLeads = {
  leads: (PageLead & { openerReady: boolean; draft: RunDraft | null })[];
  count: number;
  /** How many of them have an opener ready (`openerReadyIds`) — for an
   *  Ambassador run, one it wrote and the judge let in. */
  openersReady: number;
  /** How many of them the run wrote an opener for that the judge held back
   *  (`openerHeldBack`); none for a Find leads run, which writes none. */
  heldBack: number;
};

/** The opener a run wrote for one lead (`runOpeners` says which of its plans
 *  speaks for them): that plan's last text (`draft_attempts`), what the judge
 *  made of it, and why it missed where it did. The run's own text, not the
 *  box's since. `writing`: the judge sent it back and the run, still
 *  running, has yet to write the rewrite. */
export type RunDraft = { text: string; outcome: DraftAttemptOutcome; reason: string | null; writing: boolean };

type DraftAttemptOutcome = (typeof draftAttempts.$inferSelect)["outcome"];

/** The judge's outcomes that leave an opener nowhere: sent back with no
 *  rewrite after it, withheld, or discarded. `held` waits for a later run. */
const OPENER_HELD_BACK: ReadonlySet<DraftAttemptOutcome> = new Set(["rewrite", "withheld", "discarded"]);

/** Whether the judge held an opener back: it went nowhere, and no rewrite is
 *  still on its way. */
export function openerHeldBack(draft: RunDraft): boolean {
  return !draft.writing && OPENER_HELD_BACK.has(draft.outcome);
}

const fitFirst = sql`case ${leads.fit} when 'strong' then 0 when 'fits' then 1 else 2 end`;

/**
 * Each of one campaign's Find leads runs' served leads on the Leads page
 * (`pageLeadsWhere`, the run applied), `top` of them, strongest fit first; a
 * run that served nobody the page lists is absent. Reads only.
 */
export async function runLeads(
  tx: Tx,
  campaignId: number,
  runIds: readonly number[],
  { top = 3, now = Date.now() }: { top?: number; now?: number } = {},
): Promise<Map<number, RunLeads>> {
  const served = new Map<number, RunLeads>();
  if (runIds.length === 0) return served;
  const readyIds = await openerReadyIds(tx, campaignId, now);
  const ready = new Set(readyIds);
  const isReady = readyIds.length > 0 ? inArray(leads.id, readyIds) : sql`false`;
  for (const runId of runIds) {
    const where = and(pageLeadsWhere({ campaignId, runId, ready: null }), inList);
    const [listed] = await tx
      .select({ people: sql<number>`count(*)::int`, ready: sql<number>`(count(*) filter (where ${isReady}))::int` })
      .from(leads)
      .where(where);
    if (!listed?.people) continue;
    const best = await tx
      .select()
      .from(leads)
      .where(where)
      .orderBy(fitFirst, desc(became), desc(newest), asc(leads.id))
      .limit(top);
    served.set(runId, {
      leads: (await pageLeadsOf(tx, best, now)).map((lead) => ({ ...lead, openerReady: ready.has(lead.id), draft: null })),
      count: listed.people,
      openersReady: listed.ready,
      heldBack: 0,
    });
  }
  return served;
}

/**
 * The leads each of one campaign's Ambassador runs drafted an opener for, from
 * the plans it saved (`draft_plans`, a lead's box): `top` of them — those
 * whose opener waits for the owner's yes first, those the judge held back
 * last, strongest fit first within each — each with the opener the run wrote
 * (`RunDraft`), and how many it lists in all. One read of the plans for every
 * run and one of their boxes; a run that drafted for no lead is absent.
 * Reads only.
 *
 * WHICH PLAN SPEAKS FOR A LEAD, where a run saved several for them (a box per
 * signal): the newest the judge let in whose box still holds it ready, else
 * the newest it let in, else the run's newest plan for them — and a newest
 * plan the writer returned nothing for says nothing, rather than an older
 * plan's text as if it were the newest. So a lead is held back only where
 * none of the run's plans for them was let in, and waits only where the
 * plan's own box is ready and the lead is one the Leads page holds ready
 * (`openerReadyIds`). A text sent back in a run still `running` is being
 * rewritten (`RunDraft.writing`), not held back.
 */
export async function runOpeners(
  tx: Tx,
  campaignId: number,
  runs: readonly Pick<WorkerRun, "id" | "status">[],
  { top = 5, now = Date.now() }: { top?: number; now?: number } = {},
): Promise<Map<number, RunLeads>> {
  const drafted = new Map<number, RunLeads>();
  if (runs.length === 0) return drafted;
  const rows = await tx
    .select({
      runId: draftPlans.runId,
      planId: draftPlans.id,
      boxKey: draftPlans.boxKey,
      leadId: sql<number>`split_part(${draftPlans.boxKey}, ':', 2)::int`,
      text: draftAttempts.text,
      outcome: draftAttempts.outcome,
      reason: draftAttempts.reason,
    })
    .from(draftPlans)
    .leftJoin(
      draftAttempts,
      and(eq(draftAttempts.organizationId, draftPlans.organizationId), eq(draftAttempts.planId, draftPlans.id)),
    )
    .where(and(inArray(draftPlans.runId, runs.map((run) => run.id)), sql`${draftPlans.boxKey} ~ '^lead:[0-9]+(:|$)'`))
    .orderBy(asc(draftPlans.id), asc(draftAttempts.attempt));
  if (rows.length === 0) return drafted;
  // Oldest plan and attempt first: a plan's last row is its last text, and a
  // lead's plans read oldest to newest.
  type Plan = { box: string; last: Omit<RunDraft, "writing"> | null };
  const plans = new Map<number, Plan>();
  const byRun = new Map<number, Map<number, Plan[]>>();
  for (const { runId, planId, boxKey, leadId, text, outcome, reason } of rows) {
    if (runId === null || boxKey === null) continue;
    let plan = plans.get(planId);
    if (!plan) {
      plan = { box: boxKey, last: null };
      plans.set(planId, plan);
      const leadPlans = byRun.get(runId) ?? new Map<number, Plan[]>();
      leadPlans.set(leadId, [...(leadPlans.get(leadId) ?? []), plan]);
      byRun.set(runId, leadPlans);
    }
    if (text !== null && outcome !== null) plan.last = { text, outcome, reason };
  }
  const boxes = [...new Set([...plans.values()].map((plan) => plan.box))];
  const readyBoxes = new Set(
    (
      await tx
        .select({ key: composerDrafts.boxKey })
        .from(composerDrafts)
        .where(and(eq(composerDrafts.state, "ready"), inArray(composerDrafts.boxKey, boxes)))
    ).map((box) => box.key),
  );
  const ready = new Set(await openerReadyIds(tx, campaignId, now));
  const among = (ids: readonly number[]) => (ids.length > 0 ? inArray(leads.id, [...ids]) : sql`false`);
  for (const run of runs) {
    const leadPlans = byRun.get(run.id);
    if (!leadPlans) continue;
    const drafts = new Map<number, RunDraft | null>();
    const waiting: number[] = [];
    const heldBack: number[] = [];
    for (const [leadId, theirs] of leadPlans) {
      const admitted = theirs.filter((plan) => plan.last?.outcome === "admitted");
      const speaks =
        admitted.filter((plan) => readyBoxes.has(plan.box)).at(-1) ?? admitted.at(-1) ?? theirs.at(-1);
      const last = speaks?.last ?? null;
      const draft = last && { ...last, writing: run.status === "running" && last.outcome === "rewrite" };
      drafts.set(leadId, draft);
      if (draft?.outcome === "admitted" && readyBoxes.has(speaks!.box) && ready.has(leadId)) waiting.push(leadId);
      else if (draft && openerHeldBack(draft)) heldBack.push(leadId);
    }
    const theirs = and(inArray(leads.id, [...leadPlans.keys()]), eq(leads.campaignId, campaignId));
    const [listed] = await tx
      .select({
        people: sql<number>`count(*)::int`,
        waiting: sql<number>`(count(*) filter (where ${among(waiting)}))::int`,
        heldBack: sql<number>`(count(*) filter (where ${among(heldBack)}))::int`,
      })
      .from(leads)
      .where(theirs);
    if (!listed?.people) continue;
    const rank = sql`case when ${among(waiting)} then 0 when ${among(heldBack)} then 2 else 1 end`;
    const best = await tx.select().from(leads).where(theirs).orderBy(rank, fitFirst, asc(leads.id)).limit(top);
    const waits = new Set(waiting);
    drafted.set(run.id, {
      leads: (await pageLeadsOf(tx, best, now)).map((lead) => ({
        ...lead,
        openerReady: waits.has(lead.id),
        draft: drafts.get(lead.id) ?? null,
      })),
      count: listed.people,
      openersReady: listed.waiting,
      heldBack: listed.heldBack,
    });
  }
  return drafted;
}

/** Lead rows as the page's rows show them: with their newest passed words,
 *  where Scout found those, the role Research read and, for rows set aside,
 *  where they stand aside. `phases` are where the Signals among them stand in
 *  the pipeline, by lead id. */
async function pageLeadsOf(
  tx: Tx,
  rows: readonly Lead[],
  now: number,
  { aside = false, phases = new Map() }: { aside?: boolean; phases?: ReadonlyMap<number, SignalPhase> } = {},
): Promise<PageLead[]> {
  // Only the list's own Leads can be new.
  const fresh = await newAmong(tx, aside ? [] : rows.filter((row) => row.stage === "lead").map((row) => row.id));
  const declined = await readDeclined(tx, rows.map((row) => row.profileId));
  const views = rows.map((row) => leadView(row, now, aside, phases.get(row.id) ?? null, fresh.has(row.id), declined.get(authorIdentity(row.profileId)) ?? null));
  const said = await newestSignals(tx, views.map((lead) => lead.personKey));
  const under = await commentAuthors(tx, [...said.values()]);
  const sent = await firstSends(tx, rows);
  const reads = await profileReads(tx, rows.map((row) => row.profileId));
  return views.map((lead, index) => {
    const signal = said.get(lead.personKey);
    const role = reads.get(rows[index]!.profileId)?.read.currentRole;
    return {
      ...lead,
      initials: personInitials(lead.name),
      words: signal?.words ?? null,
      wordsAt: signal?.at ?? null,
      foundAt: signal?.seenAt ?? null,
      foundIn: !signal
        ? null
        : signal.kind === "post"
          ? { kind: "post" }
          : { kind: "comment", author: under.get(signal.id) ?? null },
      title: role?.title?.trim() || null,
      company: role?.company?.trim() || null,
      sent: sent.get(lead.id) ?? null,
      researchRequestedAt: rows[index]!.researchRequestedAt,
      aside: aside ? storedAside(rows[index]!) : null,
    };
  });
}

/** What went out first to each of `rows` that has been reached, by lead id:
 *  the comment or reply a message row holds, or the invite an action row
 *  does, at the moment it settled. */
async function firstSends(tx: Tx, rows: readonly Lead[]): Promise<Map<number, FirstSent>> {
  const reached = rows.filter((row) => row.firstSend !== null && row.contactedAt !== null);
  const ids = (kind: LeadFirstSend["kind"]) => reached.flatMap((row) => (row.firstSend!.kind === kind ? [row.firstSend!.id] : []));
  const messageIds = ids("message");
  const actionIds = ids("action");
  const said = messageIds.length
    ? await tx
        .select({ id: messages.id, kind: messages.kind, text: sql<string>`coalesce(${messages.finalText}, ${messages.proposedText})` })
        .from(messages)
        .where(inArray(messages.id, messageIds))
    : [];
  const asked = actionIds.length
    ? await tx
        .select({ id: actions.id, text: sql<string | null>`${actions.candidate} ->> 'text'` })
        .from(actions)
        .where(inArray(actions.id, actionIds))
    : [];
  return new Map(
    reached.flatMap((row): Array<[number, FirstSent]> => {
      const { kind, id } = row.firstSend!;
      const at = row.contactedAt!;
      if (kind === "action") {
        const invite = asked.find((action) => action.id === id);
        return invite ? [[row.id, { kind: "invite", text: invite.text, at }]] : [];
      }
      const message = said.find((sent) => sent.id === id);
      return message ? [[row.id, { kind: message.kind === "comment" ? "comment" : "reply", text: message.text, at }]] : [];
    }),
  );
}

/**
 * Whose post each comment among `signals` sits under: the author of the post
 * when Scout met the post itself, else the creator or competitor whose thread
 * it read. By the signal's id; a comment whose post's author is not known, and
 * every post, is left out. Names are LinkedIn text.
 */
export async function commentAuthors(
  tx: Tx,
  signals: ReadonlyArray<Pick<LeadSignalView, "id" | "kind" | "postUrn"> & { phraseId: number | null }>,
): Promise<Map<number, string>> {
  const commented = signals.filter((signal) => signal.kind === "comment");
  if (commented.length === 0) return new Map();
  const posts = await tx
    .select({ postUrn: leadSignals.postUrn, name: leadSignals.name })
    .from(leadSignals)
    .where(and(inArray(leadSignals.postUrn, commented.map((signal) => signal.postUrn)), eq(leadSignals.kind, "post")));
  const phraseIds = commented.flatMap((signal) => (signal.phraseId === null ? [] : [signal.phraseId]));
  const sources = phraseIds.length
    ? await tx
        .select({ id: searches.id, name: searches.displayName, term: searches.term, lane: searches.lane })
        .from(searches)
        .where(inArray(searches.id, phraseIds))
    : [];
  return new Map(
    commented.flatMap((signal) => {
      const author = posts.find((post) => post.postUrn === signal.postUrn && post.name)?.name;
      const source = sources.find((row) => row.id === signal.phraseId);
      const name =
        author ?? (source && (source.lane === "creators" || source.lane === "competitors") ? (source.name ?? source.term) : null);
      return name ? [[signal.id, name] as const] : [];
    }),
  );
}

/** Whether this lead's `lead_served` event names the run. */
function servedBy(runId: number): SQL {
  return sql`exists (
    select 1 from ${conversationEvents} served
    where served.type = 'lead_served'
      and (served.source_ref -> 'lead' ->> 'leadId')::bigint = ${leads.id}
      and (served.source_ref -> 'lead' ->> 'runId')::bigint = ${runId})`;
}

/**
 * Whether the owner has this lead within reach, by the rule room discovery
 * reads for any person (`eligiblePersonSql`): not erased or excluded (member
 * ids resolved to their profile), not on the do-not-engage list, not on a
 * conversation they closed in the lead's campaign's channel with none opened since.
 * A lead with no campaign has no channel to have closed a conversation on, so only
 * the lists bind it.
 */
function inReach(): SQL {
  const profile = sql`${leads.profileId}`;
  return sql`exists (
    with member_profiles as (${memberProfilesSql()})
    select 1 from (select 1) as person
    left join campaigns current on current.id = ${leads.campaignId}
    where ${eligiblePersonSql(profile, sql`null::text`, sql`'p.' || ${profile}`, "all")})`;
}

/** A lead's newest passed words, and where they were. */
type NewestSignal = Pick<LeadSignalView, "id" | "kind" | "postUrn" | "words" | "seenAt"> & { at: number; phraseId: number | null };

/** The newest passed words of each lead, by the lead's key. Signals are filed
 *  under a lead's profile, or under a member id some row ties to it. */
async function newestSignals(tx: Tx, keys: readonly string[]): Promise<Map<string, NewestSignal>> {
  if (keys.length === 0) return new Map();
  const filed = await signalKeys(tx, keys.map((key) => key.slice("p.".length)));
  const owner = new Map(keys.flatMap((key) => filed.get(key.slice("p.".length))!.map((under) => [under, key] as const)));
  const said = sql`coalesce(${leadSignals.saidAt}, ${leadSignals.seenAt})`;
  const rows = await tx
    .selectDistinctOn([leadSignals.personKey], {
      personKey: leadSignals.personKey,
      words: leadSignals.words,
      at: said.mapWith(Number),
      seenAt: leadSignals.seenAt,
      id: leadSignals.id,
      kind: leadSignals.kind,
      postUrn: leadSignals.postUrn,
      phraseId: leadSignals.phraseId,
    })
    .from(leadSignals)
    .where(and(inArray(leadSignals.personKey, [...owner.keys()]), eq(leadSignals.verdict, "passed")))
    .orderBy(leadSignals.personKey, desc(said), desc(leadSignals.id));
  // One row per key a lead's signals are filed under: the newest of them.
  const newest = new Map<string, NewestSignal>();
  for (const { personKey, ...row } of rows) {
    const key = owner.get(personKey)!;
    const held = newest.get(key);
    if (!held || row.at > held.at || (row.at === held.at && row.id > held.id)) newest.set(key, row);
  }
  return newest;
}

/** One of a lead's signals: their own words, where they were and what the
 *  screen made of them. */
export type LeadSignalView = {
  id: number;
  kind: LeadSignalKind;
  postUrn: string;
  commentUrn: string | null;
  url: string | null;
  languageType: LanguageType | null;
  verdict: SignalVerdict;
  role: LeadRole | null;
  dropReason: SignalDropReason | null;
  reason: string | null;
  seenAt: number;
  saidAt: number | null;
  /** The phrase that found it, when one did, and the name of a source. */
  term: string | null;
  lane: SearchLane | null;
  sourceName: string | null;
  words: string;
  /** Present for evidence retained from Find posts, not a new screen. */
  retained?: boolean;
};

export type LeadDetail = LeadView & { signals: LeadSignalView[] };

/**
 * The keys each person's signals may be filed under: their profile's own, and
 * each member id some row of Engager's ties to that profile. By the profile id
 * as asked.
 */
async function signalKeys(tx: Tx, profileIds: readonly string[]): Promise<Map<string, string[]>> {
  const profiles = new Map(profileIds.map((id) => [id, authorIdentity(id)] as const));
  const keys = new Map<string, string[]>(profileIds.map((id) => [id, [`p.${profiles.get(id)}`]]));
  if (profileIds.length === 0) return keys;
  const { rows } = await tx.execute<{ urn: string; profile: string }>(sql`
    with member_profiles as (${memberProfilesSql()})
    select urn, profile_id as profile from member_profiles
    where profile_id in (${sql.join([...new Set(profiles.values())].map((profile) => sql`${profile}`), sql`, `)})`);
  const members = new Map<string, string[]>();
  for (const { urn, profile } of rows) {
    const id = memberId(urn);
    if (id !== null) members.set(profile, [...(members.get(profile) ?? []), `m.${id}`]);
  }
  for (const [id, profile] of profiles) keys.get(id)!.push(...(members.get(profile) ?? []));
  return keys;
}

/** The row `getLead` finds for a lead id or a person key, when there is one. */
async function findLead(tx: Tx, which: { leadId: number } | { personKey: string }): Promise<Lead | null> {
  if ("leadId" in which) {
    const [row] = await tx.select().from(leads).where(eq(leads.id, which.leadId));
    return row ?? null;
  }
  const key = (await resolvePersonKeys(tx, [which.personKey])).get(which.personKey);
  const person = key === undefined ? null : parsePersonKey(key);
  if (person?.kind !== "profile") return null;
  const [row] = await tx.select().from(leads).where(eq(leads.profileId, authorIdentity(person.profileId)));
  return row ?? null;
}

/** A lead row with its newest signals, filed under any of `keys`. */
async function detailOf(tx: Tx, row: Lead, keys: readonly string[], now: number): Promise<LeadDetail> {
  const signals = await tx
    .select({
      signal: leadSignals,
      term: searches.term,
      lane: searches.lane,
      sourceName: searches.displayName,
    })
    .from(leadSignals)
    .leftJoin(
      searches,
      and(eq(searches.organizationId, leadSignals.organizationId), eq(searches.id, leadSignals.phraseId)),
    )
    .where(inArray(leadSignals.personKey, [...keys]))
    .orderBy(desc(sql`coalesce(${leadSignals.saidAt}, ${leadSignals.seenAt})`), desc(leadSignals.id))
    .limit(LEAD_SIGNALS_PAGE);
  return {
    ...leadView(
      row,
      now,
      await standsAside(tx, row.id),
      (await signalPhases(tx, [row], now)).get(row.id) ?? null,
      (await newAmong(tx, [row.id])).has(row.id),
      (await readDeclined(tx, [row.profileId])).get(authorIdentity(row.profileId)) ?? null,
    ),
    signals: signals.map(({ signal, term, lane, sourceName }) => ({
      id: signal.id,
      kind: signal.kind,
      postUrn: signal.postUrn,
      commentUrn: signal.commentUrn,
      url: signal.url,
      languageType: signal.languageType,
      verdict: signal.verdict,
      role: signal.role,
      dropReason: signal.dropReason,
      reason: signal.reason,
      seenAt: signal.seenAt,
      saidAt: signal.saidAt,
      term,
      lane,
      sourceName,
      words: signal.words,
      ...(signal.reason === LEGACY_SIGNAL_REASON ? { retained: true } : {}),
    })),
  };
}

/**
 * A lead, found by id or by person key, with its signals newest first. A key
 * that is a member id some row ties to a profile finds that profile's lead.
 * Null when there is none in this organization, or only a deleted campaign
 * found them (`foundViaLiveCampaign`).
 */
export async function getLead(
  tx: Tx,
  which: { leadId: number } | { personKey: string },
  now = Date.now(),
): Promise<LeadDetail | null> {
  const row = await findLead(tx, which);
  if (!row) return null;
  const [standing] = await tx.select({ id: leads.id }).from(leads).where(and(eq(leads.id, row.id), foundViaLiveCampaign()));
  if (!standing) return null;
  return detailOf(tx, row, (await signalKeys(tx, [row.profileId])).get(row.profileId)!, now);
}

/** A lead as the Leads page's pane opens it. */
export type PageLeadDetail = Omit<LeadDetail, "stage"> & {
  stage: LeadPageStage;
  /** When Scout first read words of theirs that the screen passed — the
   *  Signal phase's moment; the signals above are only the newest fifty. */
  firstSignalAt: number | null;
  /** When Engager last saw something of theirs (`leads/newLeads.ts`): opening
   *  them marks them read as of then. */
  seenAt: number;
  /** What Qualify concluded and why; null before it judged them. */
  qualification: LeadQualificationJson | null;
  /** The posts their profile read held, by urn, and when each went up. */
  recentPosts: Array<{ postUrn: string; postedAt: number | null }>;
  /** Their work and reach as their profile read gave them, LinkedIn text
   *  held as data; null before Research. */
  profile: { title: string | null; company: string | null; companySize: string | null; followers: number | null } | null;
  /** What went out first to them; null before anything did. */
  sent: FirstSent | null;
  /** Where they stand aside; null while they do not, or once their words
   *  since brought them back. */
  aside: Aside | null;
};

/**
 * The lead whose pane the Leads page opens for a key: one of the people it
 * lists, whether or not this address's search, campaign or page shows them
 * (`getLead`, with the same rules as {@link listPageLeads}). Null for a key no
 * lead answers to, and for a person the page is not for: today's intake, a
 * Relationship, a peer the owner did not rate one, someone out of the owner's
 * reach, someone only a deleted campaign found.
 */
export async function getPageLead(tx: Tx, personKey: string, now = Date.now()): Promise<PageLeadDetail | null> {
  const row = await findLead(tx, { personKey });
  if (!row) return null;
  const stage = leadStage(row);
  if (leadOrigin(row) !== "find_leads" || !isPageStage(stage)) return null;
  if (row.role !== null && row.role !== "buyer" && row.setAsideReason !== "a_peer") return null;
  const [reachable] = await tx
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.id, row.id), inReach(), foundViaLiveCampaign()));
  if (!reachable) return null;
  return { ...(await researchedDetail(tx, row, now)), stage };
}

/** What Scout found and read of someone it found, whatever became of them
 *  since: the Leads page's detail without its stage. */
export type FoundLeadDetail = Omit<PageLeadDetail, "stage">;

/**
 * The same detail for anyone Scout found, past the Leads page too: someone
 * who answered is a Relationship the page lists no more, and what Scout read
 * of them is still what the owner writes from. Null for a key no lead Scout
 * found answers to. Reads only.
 */
export async function getFoundLeadDetail(tx: Tx, personKey: string, now = Date.now()): Promise<FoundLeadDetail | null> {
  const row = await findLead(tx, { personKey });
  return row && leadOrigin(row) === "find_leads" ? researchedDetail(tx, row, now) : null;
}

async function researchedDetail(tx: Tx, row: Lead, now: number): Promise<FoundLeadDetail> {
  const keys = (await signalKeys(tx, [row.profileId])).get(row.profileId)!;
  const read = (await profileReads(tx, [row.profileId])).get(row.profileId)?.read;
  const detail = await detailOf(tx, row, keys, now);
  const { stage: _stage, ...rest } = detail;
  return {
    ...rest,
    firstSignalAt: await firstSignalAt(tx, keys),
    seenAt: await seenAtOf(tx, row.id),
    qualification: row.qualification,
    recentPosts: (read?.recentPosts ?? []).map((post) => ({ postUrn: post.postUrn, postedAt: post.postedAt ?? null })),
    profile: read
      ? {
          title: read.currentRole?.title?.trim() || null,
          company: read.currentRole?.company?.trim() || null,
          companySize: read.currentRole?.companySize?.trim() || null,
          followers: read.followers ?? null,
        }
      : null,
    sent: (await firstSends(tx, [row])).get(row.id) ?? null,
    aside: detail.setAside ? storedAside(row) : null,
  };
}


/** Someone Research judged not a buyer: the person the Leads page found, no
 *  longer one of its people. */
export type JudgedOut = { name: string | null; role: Exclude<LeadRole, "buyer"> };

/**
 * The person a key names when Research judged them a peer, competitor,
 * partner or noise and the Leads page lists them no more — what its pane says
 * of them while the address still names them. Null for anyone else: no lead,
 * a buyer, someone the owner rated A peer (set aside, and still the page's),
 * someone past Lead, out of the owner's reach or only a deleted campaign
 * found.
 */
export async function getJudgedOut(tx: Tx, personKey: string): Promise<JudgedOut | null> {
  const row = await findLead(tx, { personKey });
  if (!row || leadOrigin(row) !== "find_leads" || !isPageStage(leadStage(row))) return null;
  if (row.role === null || row.role === "buyer" || row.setAsideReason === "a_peer") return null;
  const [reachable] = await tx
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.id, row.id), inReach(), foundViaLiveCampaign()));
  return reachable ? { name: row.name, role: row.role } : null;
}

/** When Scout first read words of theirs that the screen passed, filed under
 *  any of `keys`; null with none. */
async function firstSignalAt(tx: Tx, keys: readonly string[]): Promise<number | null> {
  const [first] = await tx
    .select({ at: sql<number | null>`min(${leadSignals.seenAt})::float8` })
    .from(leadSignals)
    .where(and(inArray(leadSignals.personKey, [...keys]), eq(leadSignals.verdict, "passed")));
  return first?.at ?? null;
}

/** A person Find leads found, as the Inbox's pane tells them once they have
 *  answered: what Scout made of them and why, where it found them, and the
 *  three steps before the conversation. */
export type FoundLead = {
  fit: LeadFit | null;
  intent: ScoutIntent | null;
  /** Their words the intent rests on, and the kind of language they are in. */
  intentQuote: string | null;
  language: LanguageType | null;
  /** Qualify's first reason they fit; null before Research. */
  firstReason: string | null;
  /** The same qualification and stored sources the Leads pane reads. */
  evidence?: Pick<PageLeadDetail, "personKey" | "signals" | "intentQuote" | "researchedAt" | "fit" | "intent" | "qualification" | "recentPosts">;
  /** What found the words: a phrase, or the source whose thread it read. */
  foundVia: { term: string; lane: SearchLane; sourceName: string | null } | null;
  signalAt: number | null;
  researchedAt: number | null;
  /** The first send of ours that reached them. */
  contacted: FirstSent | null;
};

/**
 * The person a key names as Find leads found them, whatever their stage —
 * someone who answered is the Inbox's — or null for anyone else: no lead row,
 * or one today's intake wrote. Reads only.
 */
export async function getFoundLead(tx: Tx, personKey: string, now = Date.now()): Promise<FoundLead | null> {
  const row = await findLead(tx, { personKey });
  if (!row || leadOrigin(row) !== "find_leads") return null;
  const keys = (await signalKeys(tx, [row.profileId])).get(row.profileId)!;
  const read = (await profileReads(tx, [row.profileId])).get(row.profileId)?.read;
  const detail = await detailOf(tx, row, keys, now);
  const passed = detail.signals.filter((signal) => signal.verdict === "passed");
  const quote = row.intentQuote;
  // The words their intent rests on, else their newest.
  const holder = recommendedSignal(row, passed);
  return {
    fit: row.fit,
    intent: row.intent,
    intentQuote: quote,
    language: holder?.languageType ?? null,
    firstReason: row.qualification?.reasons[0]?.text ?? null,
    evidence: {
      personKey: detail.personKey, signals: detail.signals,
      intentQuote: quote, researchedAt: row.researchedAt, fit: row.fit, intent: row.intent,
      qualification: row.qualification,
      recentPosts: (read?.recentPosts ?? []).map((post) => ({ postUrn: post.postUrn, postedAt: post.postedAt ?? null })),
    },
    foundVia: holder?.term && holder.lane ? { term: holder.term, lane: holder.lane, sourceName: holder.sourceName } : null,
    signalAt: await firstSignalAt(tx, keys),
    researchedAt: row.researchedAt,
    contacted: (await firstSends(tx, [row])).get(row.id) ?? null,
  };
}
