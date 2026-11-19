import { envInt } from "../config";
import { sha256 } from "../ai/prompts";
import { authorIdentity } from "../people/key";
import { overOrBound, quotesClose, REFUSED_BECAUSE } from "../linkedin/searchRefusal";
import { MAX_SEARCH_DEPTH, MIN_SEARCH_DEPTH } from "../discovery/tactics";

export type SeedSource = {
  sourceKey: string;
  sourceType: "keyword" | "hashtag" | "query" | "author";
  term: string;
};

function normKeyword(s: string): SeedSource | null {
  const t = s.trim();
  if (!t) return null;
  return { sourceKey: `kw:${t.toLowerCase()}`, sourceType: "keyword", term: t };
}
function normHashtag(s: string): SeedSource | null {
  const t = s.trim().replace(/^#+/, "");
  if (!t) return null;
  return {
    sourceKey: `tag:#${t.toLowerCase()}`,
    sourceType: "hashtag",
    term: `#${t}`,
  };
}
function normQuery(s: string): SeedSource | null {
  const t = s.trim();
  if (!t) return null;
  return { sourceKey: `query:${sha256(t)}`, sourceType: "query", term: t };
}
function normAuthor(s: string): SeedSource | null {
  const t = s.trim();
  if (!t) return null;
  // The term IS the author URN/identifier; the driver fetches their posts (kind:"author").
  return {
    sourceKey: `author:${t.toLowerCase()}`,
    sourceType: "author",
    term: t,
  };
}

/** One source of the given kind, normalized exactly as a seed of that kind is
 *  — so a term the Scout's plan or the owner adds becomes the same source a
 *  config seed would, and `#Tag` and `tag` are one source rather than two. */
export function seedSource(
  type: SeedSource["sourceType"],
  term: string,
): SeedSource | null {
  switch (type) {
    case "keyword":
      return normKeyword(term);
    case "hashtag":
      return normHashtag(term);
    case "query":
      return normQuery(term);
    case "author":
      return normAuthor(term);
  }
}


/** Sweeping (active) searches the Scout's plan may grow the pool to; parked
 *  searches are idle and do not count. */
export const MAX_ACTIVE_SOURCES = Math.max(
  1,
  envInt("ENGAGER_SCOUT_MAX_SOURCES", 12),
);
/** New searches one plan may start, revivals included. */
export const MAX_NEW_PER_PLAN = Math.max(0, envInt("ENGAGER_SCOUT_NEW_PER_PLAN", 4));
/** Searches one plan may retire. */
export const MAX_RETIRED_PER_PLAN = Math.max(
  0,
  envInt("ENGAGER_SCOUT_RETIRED_PER_PLAN", 4),
);
/** How long a search the Scout or the system retired stays retired unless a
 *  plan cites evidence newer than the retirement. */
export const RETIRED_COOLDOWN_DAYS = Math.max(
  0,
  envInt("ENGAGER_SCOUT_RETIRED_COOLDOWN_DAYS", 14),
);

/** Why a term cannot be a search, or why a change to one was refused. */
export type SourceRefusal =
  | "empty"
  | "too_long"
  | "too_many_words"
  | "bad_characters"
  | "url_not_allowed"
  | "unbalanced_query"
  | "too_many_ors"
  | "refused_by_linkedin"
  | "unknown_author"
  | "unknown_pain"
  | "stale_room_evidence"
  | "intent_mismatch"
  | "unknown_source"
  | "duplicate"
  | "parked_same_angle"
  | "retired_by_owner"
  | "retired_recently"
  | "retired_in_plan"
  | "pinned"
  | "last_source"
  | "over_run_cap"
  | "over_active_cap"
  | "owner_set"
  | "bad_depth"
  | "author_reading";

/** One sentence per refusal, for the owner, the agent and the panel. */
export const SOURCE_REFUSAL_COPY: Readonly<Record<SourceRefusal, string>> = {
  empty: "The search is empty.",
  too_long: "The search is longer than LinkedIn search reads well.",
  too_many_words: "A keyword search is at most six words; a longer one belongs in a boolean query.",
  bad_characters: "The search has characters LinkedIn search does not read.",
  url_not_allowed: "A link is not a search; add the person as an author instead.",
  unbalanced_query: "The query's quotes or parentheses do not close.",
  too_many_ors: REFUSED_BECAUSE.too_many_ors,
  refused_by_linkedin: "LinkedIn refused that search as too large; it comes back only rewritten as shorter searches.",
  unknown_author: "An author search names someone the Scout found on a post it judged.",
  unknown_pain: "That pain is not one of this campaign's active pains.",
  stale_room_evidence: "Those rooms no longer have current evidence for this Audience.",
  intent_mismatch: "That kind of search can't serve that reason.",
  unknown_source: "No live search has that key.",
  duplicate: "It is already a search.",
  parked_same_angle: "That search is parked dry; it comes back only as a new angle — a different term.",
  retired_by_owner: "You retired that search, so the Scout does not bring it back.",
  retired_in_plan: "The same plan retired it, so it cannot also add it back.",
  retired_recently: "It was retired recently, and nothing found since supports trying it again.",
  pinned: "It is pinned, so the Scout keeps it.",
  last_source: "It is the last live search, so retiring it would leave nothing to sweep.",
  over_run_cap: "The plan already made as many changes of that kind as one run may.",
  over_active_cap: "The campaign already has as many sweeping searches as the Scout may keep.",
  owner_set: "You set how it reads, so the Scout keeps your setting.",
  bad_depth: `A search reads ${MIN_SEARCH_DEPTH} to ${MAX_SEARCH_DEPTH} pages a sweep.`,
  author_reading: "An author search reads their own feed: sort and window apply to keyword searches.",
};

const KEYWORD_MAX_CHARS = 60;
const KEYWORD_MAX_WORDS = 6;
const HASHTAG_RE = /^[\p{L}\p{N}\p{M}_]{2,40}$/u;
const KEYWORD_RE = /^[\p{L}\p{N}][\p{L}\p{N}\p{M} '’&+\-./]*$/u;
const QUERY_MAX_CHARS = 200;
const QUERY_RE = /^[\p{L}\p{N}\p{M} "'’&+\-./()]+$/u;
const LINK_RE = /https?:\/\/|www\.|linkedin\.com/i;
const AUTHOR_RE = /^[\p{L}\p{N}\p{M}\-_%:.]{2,100}$/u;

/**
 * Whether `raw` is a plausible search of `type`, and the source it becomes.
 * LinkedIn search reads words, hashtags and simple boolean expressions; a
 * link, a paragraph or a stray operator character is not a search, nor is one
 * with more ORs than LinkedIn answers (`refused.ts`), and a search the sweep
 * cannot read spends the account's budget on nothing.
 */
export function checkTerm(
  type: SeedSource["sourceType"],
  raw: string,
): { ok: true; source: SeedSource } | { ok: false; refusal: SourceRefusal } {
  const term = raw.replace(/\s+/g, " ").trim();
  if (!term || term === "#") return { ok: false, refusal: "empty" };
  if (type === "author") {
    const identity = authorIdentity(term);
    if (!AUTHOR_RE.test(identity)) return { ok: false, refusal: "unknown_author" };
  } else if (LINK_RE.test(term)) {
    return { ok: false, refusal: "url_not_allowed" };
  } else if (overOrBound({ sourceType: type, term })) {
    return { ok: false, refusal: "too_many_ors" };
  } else if (type === "keyword") {
    if (term.length > KEYWORD_MAX_CHARS) return { ok: false, refusal: "too_long" };
    if (term.split(" ").length > KEYWORD_MAX_WORDS)
      return { ok: false, refusal: "too_many_words" };
    if (term.length < 2 || !KEYWORD_RE.test(term))
      return { ok: false, refusal: "bad_characters" };
  } else if (type === "hashtag") {
    if (!HASHTAG_RE.test(term.replace(/^#+/, "")))
      return { ok: false, refusal: "bad_characters" };
  } else {
    if (term.length > QUERY_MAX_CHARS) return { ok: false, refusal: "too_long" };
    if (term.length < 3 || !QUERY_RE.test(term))
      return { ok: false, refusal: "bad_characters" };
    if (!balanced(term)) return { ok: false, refusal: "unbalanced_query" };
  }
  const source = seedSource(type, term);
  return source ? { ok: true, source } : { ok: false, refusal: "empty" };
}

function balanced(query: string): boolean {
  let depth = 0;
  for (const char of query) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0 && quotesClose(query);
}

