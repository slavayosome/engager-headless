import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import {
  discoveryAuthorDismissals,
  searches,
  type LanguageType,
  type SearchLane,
  type SearchOrigin,
  type Search,
  type SearchChange,
  type SourceRole,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { checkTerm, type SourceRefusal } from "../../linkedin/searchTerms";

/**
 * Find leads' search map: what Scout listens for when it looks for people.
 * Its rows live in `searches`, apart from Find posts' searches
 * (`discovery_sources`), which nothing here reads or writes.
 */

/** The bounds Find leads' plan works inside are Find posts' own numbers,
 *  under the map's names, so the two plans can never drift apart. */
export {
  MAX_ACTIVE_SOURCES as MAP_MAX_SWEEPING,
  MAX_NEW_PER_PLAN as MAP_MAX_STARTED_PER_PLAN,
  MAX_RETIRED_PER_PLAN as MAP_MAX_RETIRED_PER_PLAN,
  RETIRED_COOLDOWN_DAYS as MAP_RETIRED_COOLDOWN_DAYS,
} from "../../linkedin/searchTerms";

/** What a run says when the map's plan could not be asked. The plan's own row
 *  (`search_plans.failed`) is what the Searches tab reads. */
/** A phrase as a search: a keyword up to six words, longer a query, as Find
 *  posts' own check reads them, keyed as the map keys a phrase. */
export function phraseSource(
  raw: string,
): { ok: true; term: string; sourceKey: string; type: "keyword" | "query" } | { ok: false; refusal: SourceRefusal } {
  const term = raw.replace(/\s+/g, " ").trim();
  const type = term.split(" ").length > 6 ? "query" : "keyword";
  const checked = checkTerm(type, term);
  return checked.ok
    ? { ok: true, term: checked.source.term, sourceKey: `kw:${checked.source.term.toLowerCase()}`, type }
    : { ok: false, refusal: checked.refusal };
}

/** What the Searches tab says of a company page the map keeps: the backend
 *  reads a person's posts only, so a Competitors row waits, parked and never
 *  swept, until a company-page read exists. */
export const COMPANY_PAGES_NOT_READ = "Company pages are not read yet.";

/** The state a source starts, or comes back, in: a Competitors row waits. */
export const startingStatus = (lane: SearchLane): "active" | "parked" => (lane === "competitors" ? "parked" : "active");

/**
 * Serializes every change to one campaign's search map, the Scout's plan
 * and the owner's edit alike, so the bounds a change is measured against are
 * the ones it lands on.
 */
export async function lockSearchMap(tx: Tx, campaignId: number): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('lead_searches:' || coalesce(current_setting('app.current_org', true), '') || ':' || ${String(campaignId)}))`,
  );
}

/** The people and pages the owner dismissed from Where buyers gather for a
 *  campaign, as identities in lower case: Scout suggests none of them again,
 *  not as a place to read it starts and not as one a room proposes. */
export async function dismissedAuthors(tx: Tx, campaignId: number): Promise<Set<string>> {
  const rows = await tx
    .select({ identity: discoveryAuthorDismissals.authorIdentity })
    .from(discoveryAuthorDismissals)
    .where(eq(discoveryAuthorDismissals.campaignId, campaignId));
  return new Set(rows.map((row) => row.identity.toLowerCase()));
}

/** The four segments the map's board groups rows into. */
export const SEARCH_SEGMENTS = ["active", "waiting", "refused", "retired"] as const;
export type SearchSegment = (typeof SEARCH_SEGMENTS)[number];

/** Active sweeps; Waiting is parked with nothing wrong; Refused is parked
 *  because LinkedIn refuses it outright; Retired is out of the rotation. */
export function searchSegment(row: Pick<Search, "status" | "refusedAt">): SearchSegment {
  if (row.status === "active") return "active";
  if (row.status === "retired") return "retired";
  return row.refusedAt == null ? "waiting" : "refused";
}

/** Searches lists one segment at a time, at most this many rows. */
export const SEARCH_ROWS_MAX = 200;

/** A row of the map as a read shows it. `term` and `rationale` can be
 *  LinkedIn text (a creator's name, a phrase lifted from a post's comments). */
export type SearchMapRow = {
  /** The row an edit of the owner's names. */
  id: number;
  lane: SearchLane;
  languageType: LanguageType | null;
  term: string;
  origin: SearchOrigin;
  pinned: boolean;
  painId: string | null;
  sourceRole: SourceRole | null;
  rationale: string | null;
  buyers: number;
  peers: number;
  noise: number;
  lastCheckedAt: number | null;
  retiredAt: number | null;
  retiredBy: "scout" | "owner" | null;
};

/** `searchSegment`, as a condition on the table. */
const inSegment = (segment: SearchSegment): SQL =>
  segment === "active"
    ? eq(searches.status, "active")
    : segment === "retired"
      ? eq(searches.status, "retired")
      : and(
          eq(searches.status, "parked"),
          segment === "waiting" ? sql`${searches.refusedAt} is null` : sql`${searches.refusedAt} is not null`,
        )!;

/** One segment's rows, the owner's pins first, then the most buyers found,
 *  at most {@link SEARCH_ROWS_MAX}. */
export function segmentRows(tx: Tx, campaignId: number, segment: SearchSegment): Promise<Search[]> {
  return tx
    .select()
    .from(searches)
    .where(and(eq(searches.campaignId, campaignId), inSegment(segment)))
    .orderBy(desc(searches.pinned), desc(searches.buyers), asc(searches.id))
    .limit(SEARCH_ROWS_MAX);
}

/** The size of each of a campaign's four segments. */
export async function segmentCounts(tx: Tx, campaignId: number): Promise<Record<SearchSegment, number>> {
  const sizes = await tx
    .select({ status: searches.status, refused: sql<boolean>`${searches.refusedAt} is not null`, n: sql<number>`count(*)::int` })
    .from(searches)
    .where(eq(searches.campaignId, campaignId))
    .groupBy(searches.status, sql`${searches.refusedAt} is not null`);
  const counts: Record<SearchSegment, number> = { active: 0, waiting: 0, refused: 0, retired: 0 };
  for (const size of sizes) {
    counts[searchSegment({ status: size.status, refusedAt: size.refused ? 1 : null })] += size.n;
  }
  return counts;
}

/** A row as a read shows it. */
export function mapRow(row: Search): SearchMapRow {
  return {
    id: row.id,
    lane: row.lane,
    languageType: row.languageType,
    term: row.term,
    origin: row.origin,
    pinned: row.pinned,
    painId: row.painId,
    sourceRole: row.sourceRole,
    rationale: row.rationale,
    buyers: row.buyers,
    peers: row.peers,
    noise: row.noise,
    lastCheckedAt: row.lastCheckedAt,
    retiredAt: row.retiredAt,
    retiredBy: row.retiredBy,
  };
}

/**
 * Whether a change has an undo: one the Scout made — an add, a source it
 * started reading, a retirement — that no undo has taken back, on a row that
 * still stands as the change left it. The Searches tab and the run page offer
 * it where this says so.
 */
export function canUndo(
  change: Pick<SearchChange, "actor" | "action" | "phraseId">,
  row: Pick<Search, "status" | "retiredBy"> | null,
  undone: boolean,
): boolean {
  if (change.actor !== "scout" || undone || row === null || change.phraseId === null) return false;
  if (change.action === "add") return row.status !== "retired";
  return change.action === "retire" && row.status === "retired" && row.retiredBy === "scout";
}
