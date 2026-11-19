import type { ProductFact } from "@engager/database/schema";

/**
 * Whether a fact a draft is bound to may still be claimed (spec §18 R14:
 * stale or conflicting claims block drafting). Pure.
 *
 * A fact's `checked_at` is its `updated_at`: a successful product ingest
 * REPLACES the web set rather than refreshing it in place
 * (`products/ingest.ts`), so a web fact's row is exactly as old as the last
 * read of its source, and an edit stamps the owner's own facts the same way.
 * The recheck policy is per source: what came off a page goes stale on a
 * timer, because the page can change under it; what the owner told Engager
 * holds until the owner changes it.
 */

const DAY = 86_400_000;

export const FACT_RECHECK_DAYS: Readonly<Record<ProductFact["source"], number | null>> = {
  web: 30,
  linkedin: 30,
  manual: null,
  interview: null,
  obsidian: null,
};

export type FactFreshness = {
  factId: number;
  checkedAt: number;
  /** When the fact must be read again, or null when nothing ages it. */
  recheckBy: number | null;
  stale: boolean;
};

export function factFreshness(
  fact: Pick<ProductFact, "id" | "source" | "updatedAt">,
  now: number,
): FactFreshness {
  const days = FACT_RECHECK_DAYS[fact.source];
  const recheckBy = days === null ? null : fact.updatedAt + days * DAY;
  return {
    factId: fact.id,
    checkedAt: fact.updatedAt,
    recheckBy,
    stale: recheckBy !== null && now > recheckBy,
  };
}

/** The first of a draft's bound facts it may not claim — stale, or gone since
 *  the step was handed it — or null when every one holds. */
export function firstUnusableFact(
  factIds: readonly number[],
  facts: ReadonlyMap<number, Pick<ProductFact, "id" | "source" | "updatedAt">>,
  now: number,
): number | null {
  for (const id of factIds) {
    const fact = facts.get(id);
    if (!fact || factFreshness(fact, now).stale) return id;
  }
  return null;
}
