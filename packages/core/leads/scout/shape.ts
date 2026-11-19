import { SEARCH_LANES, type LanguageType, type SearchLane, type SearchDepth } from "@engager/database/schema";

/**
 * HOW FAR ONE FIND LEADS RUN CARRIES A PERSON, by the campaign's search depth
 * (SPEC §5.6): the one resolver every Find leads stage sizes itself from, as
 * `runShapeFor` is Find posts' (`workers/runShape.ts`), so a run never sizes
 * itself from two answers.
 *
 *   Quick    — three phrases, a page each, newest first; the posts' authors
 *              only. Everyone who passes the screen stays a Signal: no profile
 *              read, no qualify call, fit not checked.
 *   Standard — every row of the map, sources included, each to its own pages,
 *              and the top threads opened. Each screened person is researched,
 *              and fit is judged from their profile.
 *   Deep     — Standard, then the company page of each researched buyer
 *              (US-LMF-02), a fit that must cite a product fact (US-LMF-03),
 *              and every signal of theirs across days.
 *
 * Sources are read at Standard and Deep alike (the lead's ruling 4), so the two
 * sweep the same map. A company page source is kept and never read yet
 * (ruling 23). Nothing here touches a cap: every page and every read still
 * reserves against the account's budgets, and a depth only reads less.
 *
 * The depth is the one control for how far Scout carries a person (ruling 27):
 * Research is On at every depth, and `research` here is the depth's answer to
 * it. The owner's own Research switch still wins, so above Quick with it Off
 * no one is researched (`RESEARCH_OFF_NOTE`).
 */

/** What a run's sweep reads of the map. */
export type LeadSweepShape = {
  lanes: readonly SearchLane[];
  /** The most rows one sweep reads; null reads every row its lanes hold. */
  maxRows: number | null;
  /** Language types read before the rest — a pinned row before an unpinned
   *  one, then by the buyers each found. Empty reads the owner's pins first,
   *  then the rows checked longest ago. */
  first: readonly LanguageType[];
  /** Pages a row reads, from the top, newest first, in place of its own: its
   *  cursor and its order are left as they were. Null reads each row's own
   *  pages, in its own order, from where it stopped. */
  pagesPerRow: number | null;
  /** Whether the top threads are opened, for the people commenting there. */
  threads: boolean;
};

/** How fit is judged: not at all (a Signal), from the profile, or only where
 *  a fresh product fact shows it (US-LMF-03). */
export type FitCheck = "not_checked" | "profile" | "product_fact";

export type LeadRunShape = {
  sweep: LeadSweepShape;
  /** Each person who passes the screen has their profile read and is
   *  qualified. Off, they are served as Signals. */
  research: boolean;
  /** Each researched buyer's company page is read (US-LMF-02). */
  companyPage: boolean;
  fit: FitCheck;
  /** The words a qualify call is handed: those met since the person was last
   *  judged (`run`), or every stored signal of theirs on the campaign inside
   *  its Oldest post to search (`across_days`). */
  signals: "run" | "across_days";
};

/** What a depth above Quick says where Find leads' Research is Off: the
 *  depth reads, and no one is carried past Signal. */
export const RESEARCH_OFF_NOTE = "Research is off, so no one is researched.";

const QUICK_PHRASES = 3;

const QUICK: LeadRunShape = {
  sweep: { lanes: ["keywords"], maxRows: QUICK_PHRASES, first: ["pain", "direct_ask"], pagesPerRow: 1, threads: false },
  research: false,
  companyPage: false,
  fit: "not_checked",
  signals: "run",
};

const STANDARD: LeadRunShape = {
  sweep: { lanes: SEARCH_LANES, maxRows: null, first: [], pagesPerRow: null, threads: true },
  research: true,
  companyPage: false,
  fit: "profile",
  signals: "run",
};

const DEEP: LeadRunShape = {
  ...STANDARD,
  companyPage: true,
  fit: "product_fact",
  signals: "across_days",
};

export function leadRunShapeFor(depth: SearchDepth): LeadRunShape {
  return depth === "quick" ? QUICK : depth === "deep" ? DEEP : STANDARD;
}
