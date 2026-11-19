import type { AudienceProfileInput } from "../audience/model";
import { checkTerm, type SeedSource } from "../linkedin/searchTerms";

/** How many keyword searches a Quick campaign starts with (SPEC §4.2: 2–3
 *  pain keywords). */
export const QUICK_SEARCH_COUNT = 3;

/** How many words one keyword search reads. */
const MAX_WORDS = 6;

/** Characters a keyword search does not read, quotes among them: each one
 *  `checkTerm` refuses in a keyword. */
const UNREADABLE = /[^\p{L}\p{N}\p{M} '’&+\-./]/gu;

/** LinkedIn's operators: capitals standing alone, bounded as `countOrs`
 *  bounds an OR (discovery/orCount.ts). */
const OPERATOR = /(?<![\p{L}\p{N}])(?:AND|OR|NOT)(?![\p{L}\p{N}])/gu;

/**
 * QUICK'S FIRST SEARCHES — the keyword searches a Quick campaign made without
 * an agent's turn starts with, so its first look reads something: a Scout with
 * no search finds nothing (`no_seeds`). Create and start holds only the
 * audience — its one line and the pains the Brain filled in — so they come
 * from the active pains: up to three, their own words before their summaries,
 * a phrase from each pain in turn so one pain's synonyms do not crowd out the
 * others.
 *
 * Each is the start of the owner's words as a keyword search reads them: at
 * most six words, without the characters it cannot read, and with a capital
 * AND, OR or NOT lowercased, so none is an operator and none counts against
 * the OR bound. One `checkTerm` refuses is left out, and so is one that is
 * another's search already, or the who line's: a search on who they are finds
 * posts about them, not by them. No active pain, no search.
 */
export function quickSearchTerms(audience: Pick<AudienceProfileInput, "who" | "pains">): string[] {
  const pains = audience.pains.filter((pain) => pain.status === "active");
  const rounds = Math.max(0, ...pains.map((pain) => pain.phrases.length));
  const phrases = Array.from({ length: rounds }, (_, round) =>
    pains.flatMap((pain) => pain.phrases.slice(round, round + 1)),
  ).flat();
  const who = keywordSearch(audience.who.summary);
  const taken = new Set(who ? [who.sourceKey] : []);
  const terms: string[] = [];
  for (const words of [...phrases, ...pains.map((pain) => pain.text)]) {
    const search = keywordSearch(words);
    if (!search || taken.has(search.sourceKey)) continue;
    taken.add(search.sourceKey);
    terms.push(search.term);
    if (terms.length === QUICK_SEARCH_COUNT) break;
  }
  return terms;
}

/** The keyword search `words` begin, as the source it becomes; null where
 *  nothing it can read is left. */
function keywordSearch(words: string): SeedSource | null {
  const kept = words
    .replace(UNREADABLE, " ")
    .replace(OPERATOR, (operator) => operator.toLowerCase())
    // A keyword search starts at a letter or a digit.
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_WORDS);
  // Too long for a keyword search, its last words go first.
  for (let count = kept.length; count > 0; count -= 1) {
    const checked = checkTerm("keyword", kept.slice(0, count).join(" "));
    if (checked.ok) return checked.source;
    if (checked.refusal !== "too_long") return null;
  }
  return null;
}
