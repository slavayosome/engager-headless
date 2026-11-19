import { and, count, eq, gte, inArray, sql } from "drizzle-orm";
import { actions, campaigns, leads, leadSignals } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { cameBackPeople } from "../operations/cameBack";
import { memberProfilesSql } from "../people/directory";
import { FOUND_SIGNAL, PERSON } from "./scout/mapSummary";
import { leadTemperatureOf } from "./temperature";
import { readDeclined } from "../people/declined";
import { authorIdentity } from "../people/key";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A lead-mode campaign's last seven days — or the period from `since` — from
 * the people Scout found to the people who came back (US-LME-10): the
 * Overview's Results, and the lead funnel `get_campaign` answers an agent
 * with (US-LMF-15).
 */
export type LeadWeek = {
  /** People with a signal in it: the words Scout read, each person once. */
  found: number;
  /** People who became a Lead — a buyer Research judged, served — and of
   *  them those asking for help, those with the problem and those on the
   *  topic only; and as many in the seven days before the period. */
  leads: number;
  asking: number;
  hasProblem: number;
  topicOnly: number;
  leadsWeekBefore: number;
  /** People whose first send settled, and of them those still waiting for an
   *  answer. */
  contacted: number;
  waiting: number;
  /** Invitations that went out (`actions` confirmed), and the ones accepted
   *  (`cameBackWeek`'s `accepted`) — each counted in the week it happened,
   *  so an accept may answer an earlier week's invitation. */
  invited: number;
  connected: number;
  /** People who came back (`cameBackWeek`'s people), and how many of them
   *  are Hot and Warm by their words to the owner. */
  cameBack: number;
  hot: number;
  warm: number;
};

const NO_LEAD_WEEK: LeadWeek = {
  found: 0,
  leads: 0,
  asking: 0,
  hasProblem: 0,
  topicOnly: 0,
  leadsWeekBefore: 0,
  contacted: 0,
  waiting: 0,
  invited: 0,
  connected: 0,
  cameBack: 0,
  hot: 0,
  warm: 0,
};

/** The Leads of `campaignIds` that Research judged buyers and served, set
 *  aside or not. */
function servedLeads(campaignIds: number[]) {
  return and(
    inArray(leads.campaignId, campaignIds),
    eq(leads.origin, "find_leads"),
    eq(leads.role, "buyer"),
    inArray(leads.stage, ["lead", "contacted", "relationship", "no_answer"]),
  );
}

/**
 * The last seven days of each lead-mode campaign, in grouped reads. Every
 * number is a count of rows the server wrote: Found the people behind its
 * `lead_signals` seen in the week, by the filter its Searches tab counts
 * people found by (`FOUND_SIGNAL`: judged, a profile known — a member urn some
 * row ties to a profile is that profile, so a person is one — and within the
 * owner's reach), and never a post a lead's opener was saved on; Leads the
 * people Research first judged in it (`researched_at`, "Lead since") who were
 * served, set aside or not — people who became a Lead this week, not the
 * Searches tab's leads among the people found; Contacted the people whose
 * first send settled (`contacted_at`), still at Contacted when they wait;
 * Invited the invitations confirmed sent (`settled_at`), Connected the accepts
 * Activity counts for the campaign; Came back Activity's own read
 * (`cameBackPeople`), Hot and Warm by `leadTemperatureOf`. A person is counted
 * under the campaign their lead row follows. `since` moves the period's
 * start, every count's the same: 0 is all time.
 */
export async function leadWeek(
  tx: Tx,
  campaignIds: readonly number[],
  now: number,
  since = now - WEEK_MS,
): Promise<Map<number, LeadWeek>> {
  const weeks = new Map<number, LeadWeek>(campaignIds.map((id) => [id, { ...NO_LEAD_WEEK }]));
  if (campaignIds.length === 0) return weeks;
  const ids = [...campaignIds];
  const week = (campaignId: number | null) => (campaignId === null ? undefined : weeks.get(campaignId));

  const found = await tx.execute<{ campaignId: number; found: number }>(sql`
    with member_profiles as (${memberProfilesSql()})
    select signal.campaign_id::float8 as "campaignId", count(distinct lower(${PERSON}))::int as found
    from ${leadSignals} signal
    join ${campaigns} current on current.id = signal.campaign_id
    left join member_profiles alias on alias.urn = signal.member_urn
    where signal.campaign_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) and signal.seen_at >= ${since}
      and ${FOUND_SIGNAL}
    group by signal.campaign_id`);
  for (const row of found.rows) {
    const into = week(Number(row.campaignId));
    if (into) into.found = row.found;
  }

  const served = servedLeads(ids);
  const became = await tx
    .select({
      campaignId: leads.campaignId,
      leads: sql<number>`count(*) filter (where ${leads.researchedAt} >= ${since})::int`,
      asking: sql<number>`count(*) filter (where ${leads.researchedAt} >= ${since} and ${leads.intent} = 'asking')::int`,
      hasProblem: sql<number>`count(*) filter (where ${leads.researchedAt} >= ${since} and ${leads.intent} = 'has_problem')::int`,
      topicOnly: sql<number>`count(*) filter (where ${leads.researchedAt} >= ${since} and ${leads.intent} = 'topic_only')::int`,
      before: sql<number>`count(*) filter (where ${leads.researchedAt} < ${since})::int`,
    })
    .from(leads)
    .where(and(served, gte(leads.researchedAt, since - WEEK_MS)))
    .groupBy(leads.campaignId);
  for (const row of became) {
    const into = week(row.campaignId);
    if (into) {
      Object.assign(into, {
        leads: row.leads,
        asking: row.asking,
        hasProblem: row.hasProblem,
        topicOnly: row.topicOnly,
        leadsWeekBefore: row.before,
      });
    }
  }

  const contacted = await tx
    .select({
      campaignId: leads.campaignId,
      contacted: count(),
      waiting: sql<number>`count(*) filter (where ${leads.stage} = 'contacted')::int`,
    })
    .from(leads)
    .where(and(inArray(leads.campaignId, ids), eq(leads.origin, "find_leads"), gte(leads.contactedAt, since)))
    .groupBy(leads.campaignId);
  for (const row of contacted) {
    const into = week(row.campaignId);
    if (into) Object.assign(into, { contacted: row.contacted, waiting: row.waiting });
  }

  const invited = await tx
    .select({ campaignId: actions.campaignId, invited: count() })
    .from(actions)
    .where(
      and(
        inArray(actions.campaignId, ids),
        eq(actions.kind, "invite"),
        eq(actions.status, "confirmed"),
        gte(actions.settledAt, since),
      ),
    )
    .groupBy(actions.campaignId);
  for (const row of invited) {
    const into = week(row.campaignId);
    if (into) into.invited = row.invited;
  }

  const cameBack = await cameBackPeople(tx, { now, campaignIds: ids, since });
  const profiles = [...cameBack.values()].flatMap(({ people: keys }) =>
    [...keys].flatMap((key) => (key.startsWith("p.") ? [key.slice("p.".length)] : [])),
  );
  const people = profiles.length
    ? await tx
        .select()
        .from(leads)
        .where(inArray(leads.profileId, [...new Set(profiles)]))
    : [];
  const declined = await readDeclined(tx, people.map((row) => row.profileId));
  const heat = new Map(people.map((row) => [`p.${row.profileId}`, leadTemperatureOf(row, now, declined.get(authorIdentity(row.profileId)) ?? null)?.temperature]));
  for (const [campaignId, { people: keys, accepted }] of cameBack) {
    const into = week(campaignId);
    if (!into) continue;
    into.cameBack = keys.size;
    into.connected = accepted;
    for (const key of keys) {
      const temperature = heat.get(key.toLowerCase());
      if (temperature === "hot") into.hot += 1;
      if (temperature === "warm") into.warm += 1;
    }
  }
  return weeks;
}

/**
 * Each campaign's new Leads a week, oldest week first, for the `weeks` weeks
 * before `now`: the people Research first judged in each (`researched_at`)
 * and served, the set `leadWeek` counts as the last one's `leads`. Home draws
 * it as a campaign's trend; a week with none is a 0, never a gap.
 */
export async function leadsByWeek(
  tx: Tx,
  campaignIds: readonly number[],
  now: number,
  weeks = 8,
): Promise<Map<number, number[]>> {
  const series = new Map<number, number[]>(campaignIds.map((id) => [id, Array<number>(weeks).fill(0)]));
  if (campaignIds.length === 0) return series;
  const since = now - weeks * WEEK_MS;
  const rows = await tx
    .select({
      campaignId: leads.campaignId,
      week: sql<number>`floor((${now} - ${leads.researchedAt}) / ${WEEK_MS})::int`,
      n: count(),
    })
    .from(leads)
    .where(and(servedLeads([...campaignIds]), gte(leads.researchedAt, since)))
    .groupBy(leads.campaignId, sql`2`);
  for (const row of rows) {
    const into = row.campaignId === null ? undefined : series.get(row.campaignId);
    // Week 0 is the last seven days, so it lands at the end of the series.
    if (into && row.week >= 0 && row.week < weeks) into[weeks - 1 - row.week] = row.n;
  }
  return series;
}
