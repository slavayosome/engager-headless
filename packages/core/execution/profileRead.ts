import { eq } from "drizzle-orm";
import { channels, type ActionRow } from "@engager/database/schema";
import { withOrg } from "@engager/database/tenant";
import { reserveResearchRead } from "../ratelimit/ledger";

/**
 * One page load on the action's account, spent from its daily profile-read
 * budget before the read is made: null when the budget says yes, else why
 * not and when to try again. `profileId` is the member the load visits, where
 * it visits one — a read of the account's own received invitations visits
 * none.
 */
export async function spendProfileRead(
  context: { organizationId: string; now: () => number },
  row: Pick<ActionRow, "channelId" | "campaignId">,
  profileId?: string,
): Promise<{ reason: string; retryAt?: number } | null> {
  return withOrg(context.organizationId, async (tx) => {
    const [channel] = await tx.select().from(channels).where(eq(channels.id, row.channelId));
    if (!channel) return { reason: "account_gone" };
    const decision = await reserveResearchRead({
      db: tx,
      channel,
      read: "profile_read",
      campaignId: row.campaignId,
      ...(profileId === undefined ? {} : { profileId }),
      now: context.now(),
    });
    if (decision.ok) return null;
    return { reason: decision.reason, ...(decision.retryAt != null ? { retryAt: decision.retryAt } : {}) };
  });
}
