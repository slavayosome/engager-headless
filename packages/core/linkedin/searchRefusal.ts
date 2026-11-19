import { countOrs as orOperators, MAX_SEARCH_ORS } from "../discovery/orCount";
export { countOrs as orOperators, MAX_SEARCH_ORS } from "../discovery/orCount";

/** Whether every quote in the term closes. A quote left open puts the rest of
 *  the term inside a phrase the counter skips, so the count of a term that
 *  fails this is short — and every place that counts first refuses one. */
export function quotesClose(term: string): boolean {
  return term.split('"').length % 2 === 1;
}

/** Whether LinkedIn refuses the search for its ORs. An author has no operators
 *  to count; a hashtag has none either, unless a campaign's config holds one a
 *  boolean expression, which is sent as it stands. */
export function overOrBound(source: { sourceType: string; term: string }): boolean {
  return source.sourceType !== "author" && orOperators(source.term) > MAX_SEARCH_ORS;
}

/** Why a search is parked as one LinkedIn refuses, in the owner's words — the
 *  line its row on the Searches panel shows. */
export const REFUSED_BECAUSE = {
  too_many_ors: `LinkedIn refuses searches with more than ${MAX_SEARCH_ORS} ORs — split it into shorter searches.`,
  too_large: "LinkedIn refused this search as too large twice in a row — rewrite it as shorter searches.",
} as const;

export type RefusedReason = keyof typeof REFUSED_BECAUSE;

/** How far apart two refusals must be to count as two: the rounds of one run
 *  are minutes apart, and a refusal that returns minutes later is the same
 *  moment answering twice. */
export const STRIKE_SPACING_MS = 3 * 60 * 60_000;

