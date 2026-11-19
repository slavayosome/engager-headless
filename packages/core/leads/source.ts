import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { leads, leadSignals, type Lead, type LeadSignalRow } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { normalize } from "../workers/evidenceReview";

/** The source supporting the qualification, else their newest passed words. */
export function recommendedSignal<T extends { words: string }>(
  lead: Pick<Lead, "intentQuote">,
  signals: readonly T[],
): T | undefined {
  const quote = lead.intentQuote ? normalize(lead.intentQuote) : null;
  const sentences = quote?.match(/[^.!?…]+(?:[.!?…]+["”’)]*|$)/gu)?.map((part) => part.trim()).filter(Boolean) ?? [];
  return (quote ? signals.find((signal) => {
    const words = normalize(signal.words);
    return words.includes(quote) || (sentences.length > 0 && sentences.every((sentence) => words.includes(sentence)));
  }) : undefined) ?? signals[0];
}

/** Only sources linked to this lead and passed by its screen may be answered. */
export async function leadSources(tx: Tx, leadId: number) {
  return (await leadSourcesFor(tx, [leadId])).get(leadId) ?? [];
}

/** {@link leadSources} for many leads in one read: each lead's sources, newest
 *  first; a lead with none is absent. */
export async function leadSourcesFor(tx: Tx, leadIds: readonly number[]): Promise<Map<number, LeadSignalRow[]>> {
  const sources = new Map<number, LeadSignalRow[]>();
  if (leadIds.length === 0) return sources;
  const rows = await tx.select().from(leadSignals)
    .where(and(inArray(leadSignals.leadId, [...leadIds]), eq(leadSignals.verdict, "passed")))
    .orderBy(desc(sql`coalesce(${leadSignals.saidAt}, ${leadSignals.seenAt})`), desc(leadSignals.id));
  for (const row of rows) {
    if (row.leadId !== null) sources.set(row.leadId, [...(sources.get(row.leadId) ?? []), row]);
  }
  return sources;
}

export async function recommendedSource(tx: Tx, leadId: number): Promise<number | null> {
  return (await recommendedSources(tx, [leadId])).get(leadId) ?? null;
}

/** {@link recommendedSource} for many leads in two reads; a lead with no
 *  words the screen passed, or none found, is absent. */
export async function recommendedSources(tx: Tx, leadIds: readonly number[]): Promise<Map<number, number>> {
  if (leadIds.length === 0) return new Map();
  const rows = await tx.select({ id: leads.id, intentQuote: leads.intentQuote }).from(leads).where(inArray(leads.id, [...leadIds]));
  const sources = await leadSourcesFor(tx, rows.map((lead) => lead.id));
  return new Map(rows.flatMap((lead) => {
    const id = recommendedSignal(lead, sources.get(lead.id) ?? [])?.id;
    return id === undefined ? [] : [[lead.id, id] as const];
  }));
}
