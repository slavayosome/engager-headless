import { and, asc, eq } from "drizzle-orm";
import { campaigns, type Campaign } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { openPauses, scopesOf } from "../actions/pause";
import { loadStrategy } from "../agentStep/select";
import { modeFor } from "../strategy/mode";
import { pacedRunDueAt } from "../pacing";

/**
 * Which step of this campaign's strategy a wake of its Ambassador serves by
 * reading the account's incoming invitations — the one binding Accept invite
 * in an Ambassador step the owner has not set Off — or null when the wake
 * reads none: the campaign does not run on its strategy, has no such step,
 * or sits on a connector that cannot read the list.
 */
export async function invitationsStepOf(
  tx: Tx,
  campaign: Pick<Campaign, "id" | "channelId">,
): Promise<string | null> {
  const strategy = await loadStrategy(tx, campaign);
  if (!strategy?.connector.invitations_read) return null;
  const accept = await modeFor(tx, { campaignId: campaign.id, capability: "accept_invitation" });
  return accept.effective === "review" || accept.effective === "auto" ? accept.step_id : null;
}

/** The pacing key of the account's light look at who invited it. */
export function invitationsCheckKind(channelId: number): string {
  return `invitations_check:${channelId}`;
}

/** Whether the account's look at who invited it has gone stale: its light
 *  check's slot is due, or nothing has looked yet. Every read pushes the slot
 *  out, whoever made it (`observe.ts`). */
export async function invitationsReadDue(tx: Tx, channelId: number, now: number): Promise<boolean> {
  return ((await pacedRunDueAt(tx, invitationsCheckKind(channelId))) ?? 0) <= now;
}

/**
 * The campaign the account's light check reads its incoming invitations for
 * (`jobs/handlers/inboxCheck.ts`): the oldest active one whose Ambassador
 * reads them ({@link invitationsStepOf}) and no Stop holds — or null when none
 * does. Which one only says where the read begins: an invitation it ties to a
 * conversation reserves its acceptance on the campaign that owns it.
 */
export async function invitationsReader(tx: Tx, channelId: number): Promise<Campaign | null> {
  const active = await tx
    .select()
    .from(campaigns)
    .where(
      and(
        eq(campaigns.channelId, channelId),
        eq(campaigns.status, "active"),
      ),
    )
    .orderBy(asc(campaigns.id));
  for (const campaign of active) {
    if ((await invitationsStepOf(tx, campaign)) === null) continue;
    const stops = await openPauses(tx, scopesOf({ channelId, campaignId: campaign.id, conversationId: null }));
    if (stops.length === 0) return campaign;
  }
  return null;
}
