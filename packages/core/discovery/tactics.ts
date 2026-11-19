/**
 * HOW ONE SEARCH READS — its depth, its sort and its window. The Scout's plan
 * chooses them per search (`plan.ts`) and the owner can set any of them by
 * hand (`searches.ts`), which pins that one against the plan. The server
 * bounds them here: a depth is 1–15 pages a sweep, a sort and a window are
 * one of LinkedIn's own few.
 *
 * The campaign's `maxPostAgeDays` stays the last word on age whatever the
 * window: a post older than it is dropped at insert (`discovery.ts`).
 */

/** Pages one sweep of a search may read. */
export const MIN_SEARCH_DEPTH = 1;
export const MAX_SEARCH_DEPTH = 15;
/** What a new search reads until a plan or the owner says otherwise — the
 *  `pages_per_sweep` column default, as the sort and window below are theirs. */
export const DEFAULT_SEARCH_DEPTH = 5;

/** `relevance` is LinkedIn's Top match, on-topic first; `latest` is newest
 *  first. */
export const SEARCH_SORTS = ["relevance", "latest"] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];
export const DEFAULT_SEARCH_SORT: SearchSort = "relevance";

/** LinkedIn's date-posted filter. */
export const SEARCH_WINDOWS = ["past_day", "past_week", "past_month"] as const;
export type SearchWindow = (typeof SEARCH_WINDOWS)[number];
export const DEFAULT_SEARCH_WINDOW: SearchWindow = "past_week";

/** The owner's words for each, as LinkedIn's own filters say them. */
export const SORT_LABEL: Readonly<Record<SearchSort, string>> = {
  relevance: "Top match",
  latest: "Latest",
};
export const WINDOW_LABEL: Readonly<Record<SearchWindow, string>> = {
  past_day: "Past 24 hours",
  past_week: "Past week",
  past_month: "Past month",
};

/** How far back each window reaches, for the plan to weigh against the
 *  campaign's max post age. */
export const WINDOW_DAYS: Readonly<Record<SearchWindow, number>> = {
  past_day: 1,
  past_week: 7,
  past_month: 31,
};

/** The parts of a search's reading the owner can set and so pin. */
export const SEARCH_TACTICS = ["depth", "sort", "datePosted"] as const;
export type SearchTactic = (typeof SEARCH_TACTICS)[number];

/** A depth inside the bound: rounded, then clamped. A plan that asks for 16
 *  pages wants a deep read, and 15 is the deepest one there is. */
export function clampDepth(depth: number): number {
  if (!Number.isFinite(depth)) return DEFAULT_SEARCH_DEPTH;
  return Math.min(MAX_SEARCH_DEPTH, Math.max(MIN_SEARCH_DEPTH, Math.round(depth)));
}

/** Whether `depth` is one the owner may set as it stands. */
export function isDepth(depth: number): boolean {
  return Number.isInteger(depth) && depth >= MIN_SEARCH_DEPTH && depth <= MAX_SEARCH_DEPTH;
}
