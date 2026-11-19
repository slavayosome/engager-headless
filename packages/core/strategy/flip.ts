import { and, eq, sql } from "drizzle-orm";
import { campaignStrategies, type StrategyProvenance } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";

/**
 * THE FLAG FLIP, as history. Moving a campaign onto its strategy once
 * narrowed its sends and paused it when none of its workers woke on their own;
 * every campaign runs on its strategy now and nothing flips, but a pause the
 * flip made is still on the record (`flag_flip` provenance) and a campaign page
 * still says so. What stays is that record's reading, and the diff of two
 * documents every version's "values moved" is made of.
 */

/** Why the flip paused, narrowed or rested anything — the owner's answer to
 *  "why is this off". */
export const NOT_WAKING_REASON = "was not waking on its own";

/** Whether the flip is what paused the campaign at `pausedAt`: it wrote the
 *  `flag_flip` version in the very transaction that stamped the pause. The
 *  status stamp alone says only that Engager did it, so the reason the flip
 *  gives ("was not waking on its own") is read off this record, never off the
 *  stamp. */
export async function pausedByFlip(tx: Tx, campaignId: number, pausedAt: number): Promise<boolean> {
  const [version] = await tx
    .select({ id: campaignStrategies.id })
    .from(campaignStrategies)
    .where(
      and(
        eq(campaignStrategies.campaignId, campaignId),
        eq(campaignStrategies.createdAt, pausedAt),
        sql`${campaignStrategies.patchProvenance} ->> 'source' = 'flag_flip'`,
      ),
    )
    .limit(1);
  return version !== undefined;
}

type Change = StrategyProvenance["changes"][number];

/** The stamps every version carries, which say nothing about what it does. */
const VERSION_STAMPS = new Set(["version", "previous_version", "effective_at"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A value with its keys sorted, so a document read back out of jsonb and one
 *  built here compare by content rather than by key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value ?? null);
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
}

/** The stable ids a document's lists are keyed by (`contract.ts`). */
const LIST_IDS = ["action_binding_id", "step_id"] as const;

/** A list of records that all carry one stable id, as a record keyed by it —
 *  so a change inside one names that item rather than the whole list. Null
 *  for any other list, which is compared whole. */
function keyed(list: unknown[]): Record<string, unknown> | null {
  for (const id of LIST_IDS) {
    if (list.length > 0 && list.every((item) => isRecord(item) && typeof item[id] === "string")) {
      return Object.fromEntries(list.map((item) => [(item as Record<string, string>)[id], item]));
    }
  }
  return null;
}

/** Every value that differs between two documents, by path — objects walked,
 *  lists of steps and bindings walked by their stable id, any other list
 *  compared whole. Pure. */
export function documentChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  prefix = "",
): Change[] {
  const changes: Change[] = [];
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (!prefix && VERSION_STAMPS.has(key)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const [old, next] = [before[key], after[key]];
    const [oldItems, nextItems] = [
      Array.isArray(old) ? keyed(old) : null,
      Array.isArray(next) ? keyed(next) : null,
    ];
    if (isRecord(old) && isRecord(next)) {
      changes.push(...documentChanges(old, next, path));
    } else if (oldItems && nextItems) {
      changes.push(...documentChanges(oldItems, nextItems, path));
    } else if (canonical(old) !== canonical(next)) {
      changes.push({ path, old: old ?? null, new: next ?? null });
    }
  }
  return changes;
}
