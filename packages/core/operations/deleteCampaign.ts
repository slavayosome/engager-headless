import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { AppError } from "@engager/common/errors";
import {
  campaigns,
  chatPendingChanges,
  jobs,
  conversations,
  leads,
  leadSignals,
  messages,
  stepRuns,
  workers,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { cancelQueued, lockPauses, resumeScope } from "../actions/pause";
import { consumeWait } from "../agentStep/wait";
import { STRATEGY_PATCH } from "../strategy/patch";
import { setCampaignStatusOp } from "./campaigns";

/**
 * DELETING A CAMPAIGN — the owner's, and final.
 *
 * A soft delete: the row stays, stamped `deleted_at` and archived, because it
 * is what its ledger rows, conversations and sent messages point at, and the
 * account's caps go on counting what it sent (INV-4). A hard delete would
 * null those pointers and let the budget forget sends that happened. Every
 * list reads only the campaigns that stand (`listCampaigns`, `getCampaign`,
 * `listWorkers`), and no update, status or patch reaches a deleted one again.
 *
 * In the caller's transaction, everything that was waiting in it ends:
 *
 *   - it is archived, which on a campaign that runs on its strategy takes
 *     every worker's wake with it, and its other workers' Auto is turned off;
 *     their queued runs are cancelled;
 *   - its queued ledger actions — reserved, awaiting a yes, approved — are
 *     cancelled with their approvals, as a Stop cancels them;
 *   - its comments and replies waiting for a yes or scheduled are taken back;
 *   - the changes about it waiting for the owner's yes are settled;
 *   - the Ambassador's waits on its conversations end, wakes and follow-ups
 *     alike, and its open conversations are released from it;
 *   - a lead is one row per person and follows the campaign that found it, so
 *     a person another campaign that stands also found follows that one now,
 *     by their newest signal; the people only this one found keep their row,
 *     their signals and what was read about them, which the leads read leaves
 *     out (`foundByLiveCampaign`) and a campaign that finds them again brings
 *     back (`mergeSignals`);
 *   - and a Stop it carried is closed, since nothing is left for it to hold.
 *
 * What is past the click is left exactly where it is — a send in flight
 * settles, one whose outcome is unknown waits for its reconciliation — and an
 * archived campaign's sends are refused for good at `canEngage` either way.
 */

export const CAMPAIGN_DELETE = "campaign.delete";

/** A card asking the owner to delete one campaign: what `delete_campaign`
 *  draws, so an agent never deletes one itself. */
export const campaignDeleteSchema = z
  .object({
    kind: z.literal(CAMPAIGN_DELETE),
    campaignId: z.number().int().positive(),
  })
  .strict();
export type CampaignDelete = z.infer<typeof campaignDeleteSchema>;

export class CampaignNotFoundError extends AppError {
  readonly recovery = "Call list_campaigns and retry with an id from this organization.";

  constructor(campaignId: number) {
    super("campaign_not_found", `campaign ${campaignId} not found`, 404);
  }
}

/** Said beside a proposed delete, so no caller reports it as done — and so
 *  the owner can be told exactly where it waits for them. */
export function deletePending(campaignName: string): string {
  return `Nothing has changed. Deleting ${campaignName} takes effect only when the owner confirms it in Engager — Campaigns → ${campaignName} shows that a change is waiting for their yes, and Review opens it — and it expires in 30 minutes. Do not describe it as done.`;
}

/** The reason every row this cancels carries. */
const REASON = "cancelled:campaign_deleted";

export type DeletedCampaign = {
  campaignId: number;
  name: string;
  deletedAt: number;
  /** Workers whose wake this turned off. */
  stoppedWorkers: number;
  /** Their runs that were queued and will not start. */
  cancelledRuns: number;
  /** Ledger actions short of the click. */
  cancelledActions: number;
  /** Comments and replies waiting for a yes or scheduled. */
  cancelledMessages: number;
  /** Changes about it that waited for the owner's yes. */
  cancelledProposals: number;
  /** Waits the Ambassador held on its conversations: wakes and follow-ups. */
  cancelledWaits: number;
  /** Open conversations it owned, now owned by no campaign. */
  releasedConversations: number;
  /** Leads another campaign that stands also found, now following it. */
  rehomedLeads: number;
};

export async function deleteCampaign(
  tx: Tx,
  campaignId: number,
  options: { by: string; now: number },
): Promise<DeletedCampaign> {
  const { now } = options;
  const [campaign] = await tx
    .select({ id: campaigns.id, name: campaigns.name })
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), isNull(campaigns.deletedAt)));
  if (!campaign) throw new CampaignNotFoundError(campaignId);
  const awake = await tx
    .select({ id: workers.id })
    .from(workers)
    .where(and(eq(workers.campaignId, campaign.id), eq(workers.auto, true)));

  // Archived first, through the status's own writer: it takes the locks every
  // campaign control takes, in their order, revokes what was scheduled to run
  // as it, and on a campaign on its strategy projects the wake off.
  if (!(await setCampaignStatusOp(tx, campaign.id, "archived", now, { surface: "internal" }))) {
    throw new CampaignNotFoundError(campaignId);
  }
  await tx
    .update(campaigns)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(campaigns.id, campaign.id));
  const workerIds = (
    await tx.select({ id: workers.id }).from(workers).where(eq(workers.campaignId, campaign.id))
  ).map((row) => row.id);

  // The pause lock before any action row, in the order every writer takes them.
  await lockPauses(tx);
  const cancelledActions = await cancelQueued(tx, { scope: "campaign", scopeId: campaign.id }, REASON, now);
  await resumeScope(tx, { scope: "campaign", scopeId: campaign.id, by: options.by, now });

  const cancelledMessages = await tx
    .update(messages)
    .set({ status: "rejected", error: REASON, scheduledAt: null })
    .where(and(eq(messages.campaignId, campaign.id), inArray(messages.status, ["proposed", "approved"])))
    .returning({ id: messages.id });

  const cancelledRuns =
    workerIds.length === 0
      ? []
      : await tx
          .update(jobs)
          .set({ status: "done", lastError: REASON, updatedAt: now })
          .where(
            and(
              // `jobs` is outside RLS, so the org predicate is explicit: the
              // transaction's own.
              sql`${jobs.organizationId} = nullif(current_setting('app.current_org', true), '')::uuid`,
              eq(jobs.type, "worker_run"),
              eq(jobs.status, "queued"),
              inArray(sql`(${jobs.payload} ->> 'workerId')::bigint`, workerIds),
            ),
          )
          .returning({ id: jobs.id });

  const waits = await tx
    .select({ id: stepRuns.id, wait: stepRuns.wait })
    .from(stepRuns)
    .where(
      and(
        eq(stepRuns.campaignId, campaign.id),
        eq(stepRuns.status, "waiting"),
        sql`${stepRuns.wait} ->> 'consumedAt' is null`,
      ),
    )
    .for("update");
  for (const row of waits) await consumeWait(tx, row, "owner", now);

  const released = await tx
    .update(conversations)
    .set({ owningCampaignId: null, updatedAt: now })
    .where(and(eq(conversations.owningCampaignId, campaign.id), isNull(conversations.closedReason)))
    .returning({ id: conversations.id });

  const rehomed = await tx
    .update(leads)
    .set({ campaignId: sql`pick.campaign_id`, updatedAt: now })
    .from(
      sql`(
        select distinct on (signal.lead_id) signal.lead_id, signal.campaign_id
        from ${leadSignals} signal
        join ${campaigns} live on live.id = signal.campaign_id and live.deleted_at is null
        where signal.lead_id in (select ${leads.id} from ${leads} where ${leads.campaignId} = ${campaign.id})
        order by signal.lead_id, coalesce(signal.said_at, signal.seen_at) desc, signal.id desc
      ) pick`,
    )
    .where(and(eq(leads.campaignId, campaign.id), sql`${leads.id} = pick.lead_id`))
    .returning({ id: leads.id });

  // Settled `stale`: what each card was drawn against is gone. A card whose
  // own yes is this delete is settled here too, and then `applied` by the
  // decision that spends it, in this same transaction.
  const proposals = await tx
    .update(chatPendingChanges)
    .set({ status: "stale", decidedAt: now, outcome: { campaignDeleted: campaign.id } })
    .where(
      and(
        eq(chatPendingChanges.status, "pending"),
        inArray(chatPendingChanges.kind, [STRATEGY_PATCH, CAMPAIGN_DELETE]),
        sql`${chatPendingChanges.payload} ->> 'campaignId' = ${String(campaign.id)}`,
      ),
    )
    .returning({ id: chatPendingChanges.id });

  return {
    campaignId: campaign.id,
    name: campaign.name,
    deletedAt: now,
    stoppedWorkers: awake.length,
    cancelledRuns: cancelledRuns.length,
    cancelledActions,
    cancelledMessages: cancelledMessages.length,
    cancelledProposals: proposals.length,
    cancelledWaits: waits.length,
    releasedConversations: released.length,
    rehomedLeads: rehomed.length,
  };
}
