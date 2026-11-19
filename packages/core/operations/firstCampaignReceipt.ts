import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { campaignStrategies, campaigns } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { FIRST_CAMPAIGN_COMPILER_VERSION } from "../strategy/firstCampaign";

/** The campaign actually created by this setup, including after its working
 * copy is cleared. RLS scopes the immutable provenance receipt to this org. */
export async function firstCampaignReceipt(tx: Tx): Promise<{ id: number } | null> {
  const [row] = await tx.select({ id: campaigns.id }).from(campaigns)
    .innerJoin(campaignStrategies, eq(campaignStrategies.campaignId, campaigns.id))
    .where(and(isNull(campaigns.deletedAt),
      sql`${campaignStrategies.patchProvenance}->>'compilerVersion' = ${FIRST_CAMPAIGN_COMPILER_VERSION}`,
      sql`${campaignStrategies.patchProvenance}->>'approver' = 'dashboard:setup'`))
    .orderBy(asc(campaigns.id)).limit(1);
  return row ?? null;
}
