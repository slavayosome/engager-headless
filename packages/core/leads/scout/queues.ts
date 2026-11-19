import { and, eq, exists, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { authorProfiles, campaigns, channels, leads, leadSignals, type LanguageType, type Lead, type PipelineHold, type ScoutIntent, type SignalDropReason } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { envInt } from "../../config";
import { currentSearchDepth } from "../../strategy/searchDepth";
import { PROFILE_READ_TTL_MS } from "../../operations/researchReads";
import { memberProfilesSql } from "../../people/directory";
import { profileReadsFreeAt, profileReadsLeft, profileReadsToday } from "../../ratelimit/ledger";
import { withinActiveWindow } from "../../time";
import { eligibleLeadSql, signalStandingsSql, standings, type SignalStanding } from "./eligibility";

/**
 * THE QUEUES: what each Find leads phase has waiting, answered in one place. The
 * screen takes words, Read profiles takes people owed a read and Judge takes
 * people owed a judgment. A phase takes its work from the list its predicate
 * cuts, and `pipelineCounts` counts by that same predicate, so a count can never
 * disagree with what a phase would take. Nothing here writes, reads LinkedIn or
 * calls a model.
 */

/** The words waiting to be screened at which Scout stops reading new posts: more
 *  reading would only lengthen a queue it has not worked through. */
export const LEAD_SCREEN_GATE = 200;

/** The gate as it stands: `LEAD_SCREEN_GATE`, or what `ENGAGER_LEAD_SCREEN_GATE`
 *  sets it to. */
export function leadScreenGate(): number {
  return Math.max(1, envInt("ENGAGER_LEAD_SCREEN_GATE", LEAD_SCREEN_GATE));
}

/** The days past the post age a campaign reads that a word may wait for the
 *  screen before the 5-minute check expires it. */
export const EXPIRY_GRACE_DAYS = 2;

/** How far back `pipelineCounts` looks for words that went stale. */
const STALE_WINDOW_DAYS = 7;

const DAY = 86_400_000;

/** A person owed a read, or an answer from the one they have. */
export type Owed = { lead: Lead; /** Already a Lead or further: judged again on the read they have. */ again: boolean };

/**
 * The people owed Research, in the order it takes them.
 *
 * First, Leads past Signal who have a read and new words since they were last
 * judged: they are judged again on that read, which costs nothing, so a
 * refusal later never stops them. Then the people at stage Signal who are
 * buyers or not yet judged, with at least one signal the screen passed: those
 * with a signal from an earlier run before the rest (a refusal leaves them for
 * "the next run takes them first"), newest words first within each. A buyer
 * already judged on all their words who was left unserved is not owed a read:
 * serve takes them. Nobody the owner rated Not a fit is owed anything.
 */
export async function owed(tx: Tx, campaignId: number, runId: number): Promise<Owed[]> {
  const passed = and(
    eq(leadSignals.organizationId, leads.organizationId),
    eq(leadSignals.leadId, leads.id),
    eq(leadSignals.verdict, "passed"),
  );
  const rows = await tx
    .select({
      lead: leads,
      newest: sql<number>`max(coalesce(${leadSignals.saidAt}, ${leadSignals.seenAt}))`,
      earlier: sql<boolean>`coalesce(bool_or(${leadSignals.runId} is distinct from ${runId}), false)`,
      // Words Scout met after it last judged them.
      newWords: sql<boolean>`coalesce(bool_or(${leadSignals.seenAt} > coalesce((${leads.qualification} ->> 'at')::bigint, 0)), false)`,
    })
    .from(leads)
    .innerJoin(leadSignals, passed)
    .where(
      and(
        eq(leads.campaignId, campaignId),
        eq(leads.origin, "find_leads"),
        eligibleLeadSql(sql`${leads.profileId}`, sql`${leads.campaignId}`),
        // The owner said Not a fit: they stay where the owner put them.
        sql`${leads.rating} is distinct from 'not_a_fit'`,
        or(
          and(eq(leads.stage, "signal"), or(isNull(leads.role), eq(leads.role, "buyer"))),
          and(
            inArray(leads.stage, ["lead", "contacted", "no_answer", "relationship"]),
            eq(leads.role, "buyer"),
            exists(
              tx
                .select({ one: sql`1` })
                .from(authorProfiles)
                .where(
                  and(
                    eq(authorProfiles.organizationId, leads.organizationId),
                    eq(authorProfiles.profileId, leads.profileId),
                    isNotNull(authorProfiles.profileRead),
                  ),
                ),
            ),
          ),
        ),
      ),
    )
    .groupBy(leads.id);
  const again = (row: (typeof rows)[number]) => row.lead.stage !== "signal";
  return rows
    .filter((row) => row.newWords || (!again(row) && row.lead.qualification === null))
    .sort(
      (a, b) =>
        Number(again(b)) - Number(again(a)) ||
        Number(b.earlier) - Number(a.earlier) ||
        Number(b.newest) - Number(a.newest) ||
        a.lead.id - b.lead.id,
    )
    .map((row) => ({ lead: row.lead, again: again(row) }));
}

/** The campaign's pending words whose person a profile is known for: a person
 *  none is known for waits out of sight, so they cannot fill the screen's room. */
const pendingWords = (campaignId: number) => (profile: SQL) =>
  sql`signal.campaign_id = ${campaignId} and signal.verdict = 'pending' and ${profile} is not null`;

const UNMERGED = sql`word.verdict = 'passed' and word.lead_id is null`;

/** The campaign's signals the screen has not judged and could judge, oldest
 *  first, with whether the owner's rules leave each person within reach. */
export function pendingStandings(tx: Tx, campaignId: number, limit: number): Promise<SignalStanding[]> {
  return standings(tx, pendingWords(campaignId), limit);
}

/**
 * What the screen takes: the campaign's pending words that are within reach and
 * have a known profile, newest words first, at most `limit`. A word nobody could
 * be reached by is not in the queue, and nor is one that has no profile yet.
 */
export async function screenQueue(tx: Tx, campaignId: number, limit: number): Promise<SignalStanding[]> {
  const read = await tx.execute<SignalStanding>(sql`
    with member_profiles as (${memberProfilesSql()})
    select queued.id, queued."profileId", queued.eligible
    from (${signalStandingsSql(pendingWords(campaignId))}) queued
    where queued.eligible
    order by queued."saidAt" desc, queued.id desc
    limit ${limit}`);
  return read.rows;
}

/**
 * The words Read profiles takes first while the day's profile reads bind: the
 * kinds most often judged Asking or Has the problem, the leads Comment on
 * posts writes to on its own. A direct ask and a failed alternative became one
 * nearly twice as often as pain, and pain four times as often or more as a
 * desired outcome or a comparison. Words of no kind come last.
 */
const READ_FIRST: readonly LanguageType[] = ["direct_ask", "failed_alternative", "pain", "desired_outcome", "comparison"];

/** A passed word's place in `READ_FIRST`, as `word`: past its end for words
 *  of no kind. */
const WORDS_RANK = sql`coalesce(array_position(array[${sql.join(READ_FIRST.map((kind) => sql`${kind}`), sql`, `)}]::text[], word.language_type::text), ${READ_FIRST.length + 1})`;

/** A person a phase takes: their lead row and their profile id. */
export type QueuedPerson = { id: number; profileId: string };

/**
 * The people Scout owes work to, each with where they stand: the stage they
 * are at, when their newest passed words were said, and whether they have a
 * read and one inside its window. They are `owed()`'s people without the order
 * a run gives them, minus anyone a phase gave up on (`pipeline_hold`): Signals
 * who are buyers or not yet judged, and Leads past Signal who have a read, each
 * with a signal the screen passed, owed again for words newer than their
 * judgment or, at Signal, for none yet. Never anyone the owner rated Not a fit.
 */
function owedPeople(campaignId: number, now: number): SQL {
  return sql`
    select lead.id::int as id, lead.profile_id as "profileId", lead.stage,
      passed.newest, passed."firstRun", passed."wordsRank", reading.profile_read is not null as "hasRead",
      coalesce(reading.profile_read_at >= ${now - PROFILE_READ_TTL_MS}, false) as fresh
    from leads lead
    left join author_profiles reading on reading.organization_id = lead.organization_id and reading.profile_id = lead.profile_id
    join lateral (
      select max(coalesce(word.said_at, word.seen_at)) as newest,
        min(word.run_id) as "firstRun",
        min(${WORDS_RANK}) as "wordsRank",
        bool_or(word.seen_at > coalesce((lead.qualification ->> 'at')::bigint, 0)) as "newWords"
      from lead_signals word
      where word.organization_id = lead.organization_id and word.lead_id = lead.id and word.verdict = 'passed'
    ) passed on passed.newest is not null
    where lead.campaign_id = ${campaignId} and lead.origin = 'find_leads'
      and ${eligibleLeadSql(sql`lead.profile_id`, sql`lead.campaign_id`)}
      and lead.rating is distinct from 'not_a_fit' and lead.pipeline_hold is null
      and (
        (lead.stage = 'signal' and (lead.role is null or lead.role = 'buyer'))
        or (lead.stage in ('lead', 'contacted', 'no_answer', 'relationship') and lead.role = 'buyer' and reading.profile_read is not null)
      )
      and (passed."newWords" or (lead.stage = 'signal' and lead.qualification is null))`;
}

/** Over `owedPeople`, as `owed`: a Signal with no read inside its window. */
const WAITING_FOR_READ = sql`owed.stage = 'signal' and not owed.fresh`;

/** Over `owedPeople`, as `owed`: a person with a read to judge them on. A
 *  Signal whose read is out of its window is read again first. */
const WAITING_TO_JUDGE = sql`owed."hasRead" and (owed.stage <> 'signal' or owed.fresh)`;

/** Quick stops at Signal: it reads no profile and judges no one
 *  (`leadRunShapeFor`), so nobody waits for either. */
async function readsPeople(tx: Tx, campaignId: number): Promise<boolean> {
  return (await currentSearchDepth(tx, campaignId)) !== "quick";
}

/**
 * What Read profiles takes: the campaign's Signals who passed the screen and
 * are owed a read, with none inside its window, the likeliest buyers' words
 * first (`READ_FIRST`, by the best kind a person's passed words are), then
 * earlier runs first and then newest words. Empty at Quick. Nobody held or
 * rated Not a fit.
 */
export async function readQueue(tx: Tx, campaignId: number, limit: number, now: number = Date.now()): Promise<QueuedPerson[]> {
  if (!(await readsPeople(tx, campaignId))) return [];
  const read = await tx.execute<QueuedPerson>(sql`
    select owed.id, owed."profileId"
    from (${owedPeople(campaignId, now)}) owed
    where ${WAITING_FOR_READ}
    order by owed."wordsRank", owed."firstRun" asc nulls first, owed.newest desc, owed.id
    limit ${limit}`);
  return read.rows;
}

/**
 * What Judge takes: the campaign's people with a read and either no judgment
 * or words newer than it, Leads past Signal before Signals, earlier runs first
 * and then newest words. Empty at Quick. Nobody held or rated Not a fit.
 */
export async function judgeQueue(tx: Tx, campaignId: number, limit: number, now: number = Date.now()): Promise<QueuedPerson[]> {
  if (!(await readsPeople(tx, campaignId))) return [];
  const read = await tx.execute<QueuedPerson>(sql`
    select owed.id, owed."profileId"
    from (${owedPeople(campaignId, now)}) owed
    where ${WAITING_TO_JUDGE}
    order by (owed.stage <> 'signal') desc, owed."firstRun" asc nulls first, owed.newest desc, owed.id
    limit ${limit}`);
  return read.rows;
}

/** What holds the account's next profile read, and when it lifts: the day's
 *  reads are used up, or its active hours are shut. `timeZone` is the one those
 *  hours are in. */
export type ReadsHeld = { at: number; by: "reads_used" | "window"; timeZone: string | null };

/** Where a Signal stands in the pipeline. */
export type SignalPhase =
  /** Owed a profile read, which Read profiles makes as the account's reads and
   *  hours allow: `held` says what delays it, null while one can be made now. */
  | { phase: "waiting_for_read"; held: ReadsHeld | null }
  /** Their profile is read and Judge has not given its verdict. */
  | { phase: "being_judged" }
  /** A phase gave up on them: `hold` names it and `note` is why, as it recorded it. */
  | { phase: "set_aside"; hold: PipelineHold; note: string | null };

/** What holds the next profile read on the campaign's account: its day's reads
 *  once they are used, until the oldest ages out, or its active hours while
 *  they are shut, whichever lifts later. Null while a read can be made now. */
async function readsHeld(tx: Tx, campaignId: number, now: number): Promise<ReadsHeld | null> {
  const [account] = await tx
    .select({ id: channels.id, cap: channels.dailyProfileReadCap, hours: channels.activeHours, days: channels.activeDays })
    .from(campaigns)
    .innerJoin(channels, eq(channels.id, campaigns.channelId))
    .where(eq(campaigns.id, campaignId));
  if (!account) return null;
  const used = account.cap > 0 && (await profileReadsToday(tx, account.id, now)) >= account.cap;
  const freesAt = used ? await profileReadsFreeAt(tx, account.id, now) : null;
  const timeZone = account.hours?.tz || null;
  const window = withinActiveWindow(freesAt ?? now, account.hours, account.days);
  if (freesAt !== null && window.within) return { at: freesAt, by: "reads_used", timeZone };
  return window.within ? null : { at: window.nextOpen, by: "window", timeZone };
}

/** A lead row, as far as `signalPhases` reads one. */
export type PhasedLead = Pick<Lead, "id" | "campaignId" | "stage" | "origin" | "pipelineHold" | "pipelineHoldNote">;

/**
 * Where each Signal among `people` stands in the pipeline, by lead id: waiting
 * for a read or being judged by the predicates the phases take from, or set
 * aside by the phase that gave up on them. Anyone else is left out, and so is
 * everyone on a campaign at Quick, which stops at Signal. Reads only.
 */
export async function signalPhases(tx: Tx, people: readonly PhasedLead[], now: number = Date.now()): Promise<Map<number, SignalPhase>> {
  const phases = new Map<number, SignalPhase>();
  const signals = people.filter((one) => one.stage === "signal" && one.origin === "find_leads");
  for (const campaignId of new Set(signals.flatMap((one) => one.campaignId ?? []))) {
    if (!(await readsPeople(tx, campaignId))) continue;
    const owedNow = await tx.execute<{ id: number; waiting: boolean }>(sql`
      select owed.id, (${WAITING_FOR_READ}) as waiting
      from (${owedPeople(campaignId, now)}) owed
      where ${WAITING_FOR_READ} or ${WAITING_TO_JUDGE}`);
    const waiting = new Map(owedNow.rows.map((row) => [row.id, row.waiting]));
    const held = owedNow.rows.some((row) => row.waiting) ? await readsHeld(tx, campaignId, now) : null;
    for (const one of signals.filter((signal) => signal.campaignId === campaignId)) {
      if (one.pipelineHold !== null) {
        phases.set(one.id, { phase: "set_aside", hold: one.pipelineHold, note: one.pipelineHoldNote });
      } else if (waiting.has(one.id)) {
        phases.set(one.id, waiting.get(one.id) ? { phase: "waiting_for_read", held } : { phase: "being_judged" });
      }
    }
  }
  return phases;
}

/** How much waits at each phase. `setAside` is the words the screen gave up on
 *  and the people a phase gave up on; `stale` the words that went stale in the
 *  last week, expired before the screen took them. */
export type PipelineCounts = {
  toScreen: number;
  waitingForRead: number;
  toJudge: number;
  setAside: number;
  stale: number;
};

/**
 * The campaign's queues, counted by the predicates the phases take from: one
 * statement, so asking is cheap enough for the 5-minute check to ask of every
 * campaign.
 */
export async function pipelineCounts(tx: Tx, campaignId: number, now: number = Date.now()): Promise<PipelineCounts> {
  const reads = await readsPeople(tx, campaignId);
  const read = await tx.execute<PipelineCounts>(sql`
    with member_profiles as (${memberProfilesSql()}),
    owed as (${owedPeople(campaignId, now)})
    select
      ((select count(*) from (${signalStandingsSql(pendingWords(campaignId))}) queued where queued.eligible)
        + (select count(*) from lead_signals word where word.campaign_id = ${campaignId} and ${UNMERGED}))::int as "toScreen",
      (select count(*) from owed where ${WAITING_FOR_READ})::int as "waitingForRead",
      (select count(*) from owed where ${WAITING_TO_JUDGE})::int as "toJudge",
      ((select count(*) from leads lead where lead.campaign_id = ${campaignId} and lead.origin = 'find_leads' and lead.pipeline_hold is not null)
        + (select count(*) from lead_signals word where word.campaign_id = ${campaignId} and word.verdict = 'unscreenable'))::int as "setAside",
      (select count(*) from lead_signals word
        where word.campaign_id = ${campaignId} and word.verdict = 'expired'
          and word.expired_at >= ${now}::bigint - ${STALE_WINDOW_DAYS * DAY}::bigint)::int as stale`);
  const counts = read.rows[0]!;
  return reads ? counts : { ...counts, waitingForRead: 0, toJudge: 0 };
}

/** What stops Scout reading new posts, in the owner's words: the words and the
 *  people the steps after the sweep have yet to work through. */
export function backlogNote(counts: Pick<PipelineCounts, "toScreen" | "waitingForRead">): string {
  return `Still working through what it found: ${counts.toScreen} to screen, ${counts.waitingForRead} waiting for a profile read`;
}

/**
 * Whether Scout may read new posts for the campaign: it may while fewer words
 * wait to be screened than `leadScreenGate()` and no more people wait for a
 * profile read than the account has reads left today, since a word or a person
 * read for now would only wait behind them. Quick reads no profiles, so only
 * the words gate it. `note` is why not, null while it may, and `counts` are the
 * queues it was read from.
 */
export async function sweepGate(
  tx: Tx,
  campaignId: number,
  channelId: number,
  now: number = Date.now(),
): Promise<{ counts: PipelineCounts; note: string | null }> {
  const counts = await pipelineCounts(tx, campaignId, now);
  const shut =
    counts.toScreen >= leadScreenGate() ||
    (counts.waitingForRead > 0 && counts.waitingForRead > (await profileReadsLeft(tx, channelId, now)));
  return { counts, note: shut ? backlogNote(counts) : null };
}

/**
 * The campaign's Read posts passes, oldest first, that have nothing left
 * waiting: a run that left words and is over, none of whose words the screen
 * has yet to take, and none of whose people who passed it is owed a read or a
 * judgment. A pass the map's plan has settled (`search_plans` names it)
 * is not listed. The predicates are the steps' own, so a pass is finished when
 * no phase would take anything of it.
 */
export async function finishedPasses(tx: Tx, campaignId: number, now: number = Date.now()): Promise<number[]> {
  const reads = await readsPeople(tx, campaignId);
  const read = await tx.execute<{ runId: number }>(sql`
    with member_profiles as (${memberProfilesSql()}),
    owed as (${owedPeople(campaignId, now)}),
    waiting as (
      select word.run_id from lead_signals word
      join (${signalStandingsSql(pendingWords(campaignId))}) queued on queued.id = word.id
      where queued.eligible and word.run_id is not null
      ${
        reads
          ? sql`union
      select word.run_id from lead_signals word
      where word.campaign_id = ${campaignId} and word.verdict = 'passed' and word.run_id is not null
        and (word.lead_id is null or word.lead_id in (select owed.id from owed))`
          : sql``
      }
    )
    select word.run_id::int as "runId"
    from lead_signals word
    where word.campaign_id = ${campaignId} and word.run_id is not null
      and word.run_id not in (select waiting.run_id from waiting)
      and not exists (select 1 from worker_runs run where run.id = word.run_id and run.status = 'running')
      and not exists (select 1 from search_plans plan where plan.campaign_id = word.campaign_id and plan.run_id = word.run_id)
    group by word.run_id
    order by word.run_id`);
  return read.rows.map((row) => row.runId);
}

/** Where one Find leads run's people stand now, from the rows it tagged. */
export type RunPeople = {
  /** People whose words the run kept, whatever became of the words. */
  found: number;
  /** People with a word that passed the screen. */
  screenedIn: number;
  /** The people none of whose words passed, each under the reason their newest
   *  dropped word gives. */
  dropped: Record<SignalDropReason, number>;
  /** Words to screen, waiting for a read and to judge, as the queues count
   *  them, and the sum of the three. */
  toScreen: number;
  waitingForRead: number;
  toJudge: number;
  stillWorked: number;
  /** Screened-in people with a profile read, and what the judgments made of
   *  them. */
  researched: number;
  buyers: number;
  notFit: number;
  peers: number;
  partners: number;
  /** The people now past Signal, by what their words show. */
  leads: Record<ScoutIntent, number>;
};

type RunPeopleRow = {
  runId: number;
  found: number;
  screenedIn: number;
  noWords: number;
  notAudience: number;
  selling: number;
  solved: number;
  recruiter: number;
  student: number;
  toScreen: number;
  waitingForRead: number;
  toJudge: number;
  researched: number;
  buyers: number;
  notFit: number;
  peers: number;
  partners: number;
  asking: number;
  hasProblem: number;
  topicOnly: number;
};

const NO_PEOPLE: RunPeople = {
  found: 0,
  screenedIn: 0,
  dropped: { no_own_words: 0, not_audience: 0, selling_similar: 0, already_solved: 0, recruiter: 0, student: 0 },
  toScreen: 0,
  waitingForRead: 0,
  toJudge: 0,
  stillWorked: 0,
  researched: 0,
  buyers: 0,
  notFit: 0,
  peers: 0,
  partners: 0,
  leads: { asking: 0, has_problem: 0, topic_only: 0 },
};

/**
 * The people of each of these runs of the campaign, counted from the words
 * tagged with the run (`lead_signals.run_id`) and the campaign's own leads they
 * were merged into, so a run that only reads keeps counting as the steps after
 * it work; a person merged into a lead of another campaign counts only as
 * found and screened in. A
 * run with no words is all zeros. What still waits is cut by the steps' own
 * predicates (`pendingWords`, `WAITING_FOR_READ`, `WAITING_TO_JUDGE`), so a
 * count can never disagree with what a phase would take; a person is counted
 * once under the reason their newest dropped word gives, as the screen counted
 * its people when a run screened them itself. Quick reads no profile and
 * judges no one, so nobody waits for either.
 */
export async function runPeople(
  tx: Tx,
  campaignId: number,
  runIds: readonly number[],
  now: number = Date.now(),
): Promise<Map<number, RunPeople>> {
  const people = new Map(runIds.map((id) => [id, NO_PEOPLE]));
  if (runIds.length === 0) return people;
  const reads = await readsPeople(tx, campaignId);
  const runs = sql.join(runIds.map((id) => sql`${id}`), sql`, `);
  const read = await tx.execute<RunPeopleRow>(sql`
    with member_profiles as (${memberProfilesSql()}),
    owed as (${owedPeople(campaignId, now)}),
    person as (
      select word.run_id, coalesce('p.' || coalesce(linked.profile_id, word.profile_id, alias.profile_id), word.person_key) as person_key, max(word.lead_id) as "leadId",
        bool_or(word.verdict = 'passed') as passed,
        (array_agg(word.drop_reason order by coalesce(word.said_at, word.seen_at) desc) filter (where word.verdict = 'dropped'))[1] as reason
      from lead_signals word
      left join leads linked on linked.id = word.lead_id
      left join member_profiles alias on alias.urn = word.member_urn
      where word.campaign_id = ${campaignId} and word.run_id in (${runs})
      group by word.run_id, coalesce('p.' || coalesce(linked.profile_id, word.profile_id, alias.profile_id), word.person_key)
    ),
    counted as (
      select person.run_id::int as "runId",
        count(*)::int as found,
        (count(*) filter (where person.passed))::int as "screenedIn",
        (count(*) filter (where not person.passed and person.reason = 'no_own_words'))::int as "noWords",
        (count(*) filter (where not person.passed and person.reason = 'not_audience'))::int as "notAudience",
        (count(*) filter (where not person.passed and person.reason = 'selling_similar'))::int as selling,
        (count(*) filter (where not person.passed and person.reason = 'already_solved'))::int as solved,
        (count(*) filter (where not person.passed and person.reason = 'recruiter'))::int as recruiter,
        (count(*) filter (where not person.passed and person.reason = 'student'))::int as student,
        (count(*) filter (where ${WAITING_FOR_READ}))::int as "waitingForRead",
        (count(*) filter (where ${WAITING_TO_JUDGE}))::int as "toJudge",
        (count(*) filter (where person.passed and reading.profile_read is not null))::int as researched,
        (count(*) filter (where lead.qualification is not null and lead.role = 'buyer'))::int as buyers,
        (count(*) filter (where lead.qualification is not null and lead.role = 'noise'))::int as "notFit",
        (count(*) filter (where lead.qualification is not null and lead.role in ('peer', 'competitor')))::int as peers,
        (count(*) filter (where lead.qualification is not null and lead.role = 'partner'))::int as partners,
        (count(*) filter (where lead.stage in ('lead', 'contacted', 'no_answer', 'relationship') and lead.role = 'buyer' and lead.intent = 'asking'))::int as asking,
        (count(*) filter (where lead.stage in ('lead', 'contacted', 'no_answer', 'relationship') and lead.role = 'buyer' and lead.intent = 'has_problem'))::int as "hasProblem",
        (count(*) filter (where lead.stage in ('lead', 'contacted', 'no_answer', 'relationship') and lead.role = 'buyer' and lead.intent = 'topic_only'))::int as "topicOnly"
      from person
      left join leads lead on lead.id = person."leadId" and lead.campaign_id = ${campaignId}
      left join author_profiles reading on reading.organization_id = lead.organization_id and reading.profile_id = lead.profile_id
      left join owed on owed.id = person."leadId"
      group by person.run_id
    ),
    waiting as (
      select word.run_id, count(*)::int as "toScreen"
      from lead_signals word
      join (${signalStandingsSql((profile) => sql`${pendingWords(campaignId)(profile)} and signal.run_id in (${runs})`)}) queued on queued.id = word.id
      where queued.eligible
      group by word.run_id
      union all
      select word.run_id, count(*)::int as "toScreen"
      from lead_signals word
      where word.campaign_id = ${campaignId} and word.run_id in (${runs}) and ${UNMERGED}
      group by word.run_id
    )
    select counted.*, coalesce(waiting."toScreen", 0)::int as "toScreen"
    from counted
    left join (select run_id, sum("toScreen")::int as "toScreen" from waiting group by run_id) waiting on waiting.run_id = counted."runId"`);
  for (const row of read.rows) {
    const [waitingForRead, toJudge] = reads ? [row.waitingForRead, row.toJudge] : [0, 0];
    people.set(row.runId, {
      found: row.found,
      screenedIn: row.screenedIn,
      dropped: {
        no_own_words: row.noWords,
        not_audience: row.notAudience,
        selling_similar: row.selling,
        already_solved: row.solved,
        recruiter: row.recruiter,
        student: row.student,
      },
      toScreen: row.toScreen,
      waitingForRead,
      toJudge,
      stillWorked: row.toScreen + waitingForRead + toJudge,
      researched: row.researched,
      buyers: row.buyers,
      notFit: row.notFit,
      peers: row.peers,
      partners: row.partners,
      leads: { asking: row.asking, has_problem: row.hasProblem, topic_only: row.topicOnly },
    });
  }
  return people;
}
