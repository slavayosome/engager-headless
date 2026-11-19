import { and, eq, isNull, or } from "drizzle-orm";
import { exemplars } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import type { Exemplar } from "../ai/writer";

type ExemplarRow = typeof exemplars.$inferSelect;

/** Immutable DB-side input for exemplar relevance ranking. */
export type ExemplarRetrievalSnapshot = readonly ExemplarRow[];

export type ExemplarRetrievalInput = {
  campaignId: number;
  kind: "comment" | "reply";
  voiceId?: number | null;
};

/** DB-only half of exemplar retrieval. No embedder can run here — and none
 *  exists anywhere anymore (INV-14). */
export async function prepareExemplarRetrieval(
  tx: Tx,
  opts: ExemplarRetrievalInput,
): Promise<ExemplarRetrievalSnapshot> {
  const voicePredicate =
    opts.voiceId != null
      ? or(isNull(exemplars.voiceId), eq(exemplars.voiceId, opts.voiceId))
      : isNull(exemplars.voiceId);
  return tx
    .select()
    .from(exemplars)
    .where(
      and(
        eq(exemplars.label, "good"),
        eq(exemplars.kind, opts.kind),
        or(
          eq(exemplars.campaignId, opts.campaignId),
          isNull(exemplars.campaignId),
        ),
        voicePredicate,
      ),
    );
}

/**
 * Provider-free half of exemplar retrieval over detached rows. The cosine arm
 * is gone (INV-14): the recency fallback that every keyless install already
 * ran is now the whole retrieval — most-recent good exemplars, no vectors.
 */
export async function retrieveExemplarsFromSnapshot(opts: {
  rows: ExemplarRetrievalSnapshot;
  queryText: string;
  k?: number;
}): Promise<Exemplar[]> {
  const rows = [...opts.rows];
  const k = opts.k ?? 3;
  if (rows.length === 0) return [];

  return rows
    .slice(-k)
    .map((r: ExemplarRow): Exemplar => ({
      context: r.contextText,
      response: r.responseText,
    }));
}

/**
 * Retrieve the user's best-rated past comments for this post: the voice-scoped,
 * most-recent good exemplars (the recency fallback, now the only arm).
 */
export async function retrieveExemplars(opts: {
  campaignId: number;
  kind: "comment" | "reply";
  queryText: string;
  k?: number;
  db: Tx;
  /** The campaign's resolved voice id: voice-stamped exemplars only surface
   *  under THEIR voice (register compatibility); legacy null-voice rows stay
   *  retrievable everywhere. Omit/null = null-voice rows only. */
  voiceId?: number | null;
}): Promise<Exemplar[]> {
  const rows = await prepareExemplarRetrieval(opts.db, opts);
  return retrieveExemplarsFromSnapshot({
    rows,
    queryText: opts.queryText,
    k: opts.k,
  });
}
