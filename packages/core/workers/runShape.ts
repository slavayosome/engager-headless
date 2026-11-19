import type { SearchDepth } from "@engager/database/schema";
import { pagesPerRun } from "../linkedin/searchLimits";
import type { SearchSort } from "../discovery/tactics";
const RANK_BATCH_MAX = 50;

/**
 * HOW MUCH OF LINKEDIN ONE SCOUT RUN READS, AND HOW IT JUDGES WHAT IT READ —
 * by the campaign's search depth (SPEC §4.1), from one resolver, so a run
 * never sizes itself from two answers.
 *
 * Standard is how Scout has always worked, and its shape is today's numbers
 * exactly: a null leaves a knob where it always was — the sweep's size to the
 * pool's health (`sweepBudget`), a search's depth and order to the search
 * itself. Deep reads the same: what makes it Deep is its Research, which the
 * run reads off the campaign (`verifyStage`) and walks in rounds as a
 * Research-on campaign always has. Quick reads a small, fresh slice — two
 * searches, a page each, newest first — and judges it in one batch.
 *
 * Nothing here touches the account's caps: every page still reserves against
 * the hourly and daily discovery budget, and Quick reads less, never faster.
 */
export type RunShape = {
  /** The most searches one sweep reads; null leaves it to the pool's health. */
  maxSearches: number | null;
  /** The most pages one search reads in a sweep; null leaves it to the
   *  search's own depth. */
  pagesPerSearch: number | null;
  /** The most pages one sweep reads across its searches. */
  pagesPerRun: number;
  /** The order every page is asked for in, whatever each search saved; null
   *  reads each search in its own. A search's saved sort is never rewritten. */
  sortOverride: SearchSort | null;
  /** Posts one triage model call judges. */
  triageBatch: number;
  /** The most posts one run judges. */
  maxTriage: number;
  /** Whether a first look plans its searches before it sweeps. */
  planInFirstLook: boolean;
};

/** Posts one judging call reads. */
const TRIAGE_BATCH_SIZE = 25;

/** Quick's slice: two searches, one page each, newest first. */
const QUICK_SEARCHES = 2;
const QUICK_PAGES_PER_SEARCH = 1;

export function runShapeFor(depth: SearchDepth): RunShape {
  if (depth === "quick") {
    return {
      maxSearches: QUICK_SEARCHES,
      pagesPerSearch: QUICK_PAGES_PER_SEARCH,
      pagesPerRun: QUICK_SEARCHES * QUICK_PAGES_PER_SEARCH,
      sortOverride: "latest",
      triageBatch: TRIAGE_BATCH_SIZE,
      maxTriage: TRIAGE_BATCH_SIZE,
      planInFirstLook: false,
    };
  }
  return {
    maxSearches: null,
    pagesPerSearch: null,
    pagesPerRun: pagesPerRun(),
    sortOverride: null,
    triageBatch: TRIAGE_BATCH_SIZE,
    maxTriage: RANK_BATCH_MAX,
    planInFirstLook: true,
  };
}
