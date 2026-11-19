import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { campaignStrategies, campaigns } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { parseStrategy, type CampaignAgentStrategy } from "./contract";

/** One scope's active version, parsed for its shape alone. A stored document
 *  that no longer parses states nothing, and the next scope answers. */
export type ScopeStrategy = {
  version: number;
  document: CampaignAgentStrategy | null;
};

/** What a campaign's policy groups inherit from: its own active strategy,
 *  then its channel's account default. */
export type InheritedStrategies = {
  campaign: ScopeStrategy | null;
  account: ScopeStrategy | null;
};

/**
 * Each campaign's active strategy and its channel's account default, read
 * in two queries however many campaigns ask — the way the resolver inherits a
 * mode, applied to the policy groups (`observation`, `eligibility`,
 * `retention`) a runtime path reads. Validation is shape-only: a group's
 * fields do not depend on the network.
 */
export async function inheritedStrategies(
  tx: Tx,
  campaignIds: number[],
): Promise<Map<number, InheritedStrategies>> {
  const ids = [...new Set(campaignIds)];
  if (ids.length === 0) return new Map();
  const targets = await tx
    .select({ id: campaigns.id, channelId: campaigns.channelId })
    .from(campaigns)
    .where(inArray(campaigns.id, ids));
  const active = await tx
    .select({
      campaignId: campaignStrategies.campaignId,
      channelId: campaignStrategies.channelId,
      version: campaignStrategies.version,
      document: campaignStrategies.document,
    })
    .from(campaignStrategies)
    .where(
      and(
        eq(campaignStrategies.status, "active"),
        or(
          inArray(campaignStrategies.campaignId, ids),
          isNotNull(campaignStrategies.channelId),
        ),
      ),
    );
  const scope = (row: (typeof active)[number]): ScopeStrategy => {
    const parsed = parseStrategy(row.document, { network: null });
    return { version: row.version, document: parsed.success ? parsed.data : null };
  };
  const byCampaign = new Map(
    active.flatMap((row) =>
      row.campaignId !== null ? [[row.campaignId, scope(row)] as const] : [],
    ),
  );
  const byChannel = new Map(
    active.flatMap((row) =>
      row.channelId !== null ? [[row.channelId, scope(row)] as const] : [],
    ),
  );
  return new Map(
    targets.map((target) => [
      target.id,
      {
        campaign: byCampaign.get(target.id) ?? null,
        account:
          target.channelId !== null ? (byChannel.get(target.channelId) ?? null) : null,
      },
    ]),
  );
}

/** The first scope that states `group`: the campaign's own document, else the
 *  account default's; null when neither does and the caller's constant
 *  answers. */
export function inheritedGroup<K extends keyof CampaignAgentStrategy>(
  strategies: InheritedStrategies | undefined,
  group: K,
): NonNullable<CampaignAgentStrategy[K]> | null {
  return (
    strategies?.campaign?.document?.[group] ??
    strategies?.account?.document?.[group] ??
    null
  );
}
