import { and, eq, sql } from "drizzle-orm";
import { searches, type WorkerRun } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";

/**
 * What a Find leads run counted, as the `worker_runs` columns hold it.
 * Every count is a row the server wrote or accepted: a page or read the ledger
 * reserved, a signal inserted, a verdict accepted for an id the run froze, a
 * lead inserted or moved. No number a model returns is ever written here, and
 * each stage writes its counts as it lands, so a run that stops keeps them.
 */
export const LEAD_COUNTERS = [
  "leadReadCount",
  "leadFoundCount",
  "leadScreenedInCount",
  "leadResearchedCount",
  "leadResearchDeferredCount",
  "leadServedAskingCount",
  "leadServedProblemCount",
  "leadServedTopicCount",
  "leadMergedCount",
  "leadDropNoWordsCount",
  "leadDropNotAudienceCount",
  "leadDropSellingCount",
  "leadDropSolvedCount",
  "leadDropRecruiterCount",
  "leadDropStudentCount",
  "leadBuyerCount",
  "leadNotFitCount",
  "leadPeerCount",
  "leadPartnerCount",
  "searchPagesCount",
  "threadReadsCount",
  "profileReadsCount",
] as const satisfies readonly (keyof WorkerRun)[];

export type LeadRunCounts = Record<(typeof LEAD_COUNTERS)[number], number>;

export function emptyLeadCounts(): LeadRunCounts {
  return Object.fromEntries(LEAD_COUNTERS.map((name) => [name, 0])) as LeadRunCounts;
}

/** What a run that only reads keeps: the pages and threads it read and the
 *  people its words came from. Every other counter is a later step's work on a
 *  person: the screen, the profile reads, the judgment, the serve. */
const SWEEP_COUNTERS = [
  "leadReadCount",
  "leadFoundCount",
  "searchPagesCount",
  "threadReadsCount",
] as const satisfies readonly (typeof LEAD_COUNTERS)[number][];

/** The counters a run writes only when it screens, researches or serves its
 *  people itself, as a test and a first look's round do. On any other run they
 *  stay at zero, because the steps after the sweep do that work and count it
 *  from the rows (`runPeople`). */
export const PEOPLE_COUNTERS = LEAD_COUNTERS.filter(
  (name) => !(SWEEP_COUNTERS as readonly string[]).includes(name),
);

/** The counters a run writes only for people it screened, researched or served
 *  itself. */
const OWN_PEOPLE = [
  "leadScreenedInCount",
  "leadResearchedCount",
  "leadResearchDeferredCount",
  "leadServedAskingCount",
  "leadServedProblemCount",
  "leadServedTopicCount",
  "leadBuyerCount",
] as const satisfies readonly (typeof LEAD_COUNTERS)[number][];

/**
 * Whether a run's own counters say what became of its people: it screened,
 * researched or served them inside itself, as every run did before the steps
 * took that work and as a test and a first look's round still do. Any other run
 * only reads, so its people are counted from the rows it tagged (`runPeople`).
 */
export function ownsItsPeople(run: Pick<LeadRunCounts, (typeof OWN_PEOPLE)[number]>): boolean {
  return OWN_PEOPLE.some((name) => run[name] > 0);
}

/** What `countsPeopleFromRows` reads of a run row. */
export type PeopleCountedRun = Pick<WorkerRun, "searchDepth"> & Pick<LeadRunCounts, (typeof OWN_PEOPLE)[number]>;

/**
 * Whether what became of a run's people is tallied from the rows it tagged
 * (`runPeople`) and not read off its own columns: it is a Find leads run (it
 * has a depth) that did not work them itself. Its person counters are zeros
 * by construction, so a reader that shows them beside the tally contradicts it.
 */
export function countsPeopleFromRows(run: PeopleCountedRun): boolean {
  return run.searchDepth !== null && !ownsItsPeople(run);
}

/**
 * What a campaign's Find leads listens to now: the keyword phrases it
 * searches (the Keywords lane) and the places it reads (the Creators,
 * Competitors and One thread lanes), active rows only. A waiting, refused or
 * retired row is not listened to, so it is not counted.
 */
export async function searchCounts(
  tx: Tx,
  campaignId: number,
): Promise<{ phrases: number; sources: number }> {
  const [row] = await tx
    .select({
      phrases: sql<number>`count(*) filter (where ${searches.lane} = 'keywords')::int`,
      sources: sql<number>`count(*) filter (where ${searches.lane} <> 'keywords')::int`,
    })
    .from(searches)
    .where(and(eq(searches.campaignId, campaignId), eq(searches.status, "active")));
  return { phrases: row?.phrases ?? 0, sources: row?.sources ?? 0 };
}
