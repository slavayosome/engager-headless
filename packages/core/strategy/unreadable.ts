import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { campaignStrategies, campaigns, channels } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { NETWORK_CATALOGS } from "./catalog";
import { parseStrategy } from "./contract";

/**
 * THE STRATEGIES IN FORCE THAT NO LONGER READ — what the alert bar says when
 * a start could not project a campaign (`operations/reprojectStrategies.ts`).
 *
 * A start that cannot project a campaign leaves its workers on the switches
 * they had and writes a line to a log nobody opens. What would stop it is
 * always the stored document — it no longer satisfies today's contract, or the
 * account default it resolves through does not — so the answer is derived from
 * the rows, the same check activation makes first (`parseStrategy`, which
 * reads a document stored in an older schema as today's). It needs no record
 * of its own and clears the moment the document reads again: the owner's next
 * change to it, or a start that finds it fixed.
 *
 * Scoped to one campaign, it keeps that campaign's and the account's, because
 * every campaign resolves through the account.
 */

export type UnreadableStrategy = {
  /** Null for the account default. */
  campaignId: number | null;
  /** The campaign's name; null for the account default. */
  name: string | null;
  /** The first thing the contract refuses, in its own words. */
  reason: string;
};

const firstIssue = (issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string => {
  const [issue] = issues;
  if (!issue) return "it does not satisfy the strategy contract";
  const path = issue.path.map(String).join(".");
  return path === "" ? issue.message : `${path}: ${issue.message}`;
};

export async function unreadableStrategies(
  tx: Tx,
  options: { campaignId?: number } = {},
): Promise<UnreadableStrategy[]> {
  const found: UnreadableStrategy[] = [];
  const rows = await tx
    .select({
      campaignId: campaigns.id,
      name: campaigns.name,
      network: channels.network,
      document: campaignStrategies.document,
    })
    .from(campaigns)
    .innerJoin(campaignStrategies, eq(campaignStrategies.campaignId, campaigns.id))
    .leftJoin(channels, eq(channels.id, campaigns.channelId))
    .where(
      and(
        isNull(campaigns.deletedAt),
        eq(campaignStrategies.status, "active"),
        ...(options.campaignId === undefined ? [] : [eq(campaigns.id, options.campaignId)]),
      ),
    )
    .orderBy(asc(campaigns.id));
  for (const row of rows) {
    const parsed = parseStrategy(row.document, { network: row.network ? NETWORK_CATALOGS[row.network] : null });
    if (!parsed.success) {
      found.push({ campaignId: row.campaignId, name: row.name, reason: firstIssue(parsed.error.issues) });
    }
  }
  const accounts = await tx
    .select({ network: channels.network, document: campaignStrategies.document })
    .from(campaignStrategies)
    .innerJoin(channels, eq(channels.id, campaignStrategies.channelId))
    .where(and(isNotNull(campaignStrategies.channelId), eq(campaignStrategies.status, "active")))
    .orderBy(asc(campaignStrategies.channelId));
  for (const account of accounts) {
    const parsed = parseStrategy(account.document, { network: NETWORK_CATALOGS[account.network] });
    if (!parsed.success) found.push({ campaignId: null, name: null, reason: firstIssue(parsed.error.issues) });
  }
  return found;
}
