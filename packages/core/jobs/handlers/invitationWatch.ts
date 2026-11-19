import { conversationPayload } from "../conversationPayload";
import { eq } from "drizzle-orm";
import { conversations, type ConversationRow } from "@engager/database/schema";
import { withOrg } from "@engager/database/tenant";
import { nextInvitationRecheck, type InvitationWatchPayload } from "../../actions/invite";
import type { WithdrawalReadPayload } from "../../actions/withdrawInvite";
import { isGrant } from "../../connector/resolve";
import { outstandingInvitation } from "../../conversations/record";
import { refreshRelationship, type RelationshipRefresh } from "../../conversations/refresh";
import { relationshipOf } from "../../conversations/relationship";
import { isConnectorBackoff } from "../../linkedin/connectorError";
import { claimExclusiveRun, releaseExclusiveRun } from "../../pacing";
import { pauseChannelForConnectorBackoff } from "../../ratelimit/killswitch";
import { refuseChannel } from "../../refusal";
import { grantFor } from "../context";
import { RescheduleError } from "../queue";
import {
  assertHostedJobSpendStillAllowed,
  assertHostedJobSpendStillAllowedInTx,
} from "../spendAccess";
import type { JobResult, SelfScopedCtx } from "../worker";

const MINUTE = 60_000;
/** Held across the one profile read, which the job's own timeout ends first. */
const READ_LEASE_MS = 5 * MINUTE;

/**
 * Worker handler for `invitation_watch`: the wait on an invitation's answer
 * (spec §11 R08 `InvitationAccepted`, §17 "Observe acceptance"). The person's
 * own profile is read again in the account's session — their page's own
 * data, the one thing that records an acceptance (`recordRelationshipRead`);
 * a notification never does — on a backoff from the send (`nextInvitationRecheck`:
 * an hour after it, then 3, 6 and 12 hours, then a day apart), until a read shows
 * them connected, or their invitation switch back on Connect or on Withdrawn
 * (`invitation_gone`: LinkedIn no longer lists it — withdrawn, or expired),
 * or the wait expires. Enqueued by the invitation's settlement
 * (`actions/invite.ts`), never by a model.
 *
 * An acceptance is a conversation event like a reply: the read that records it
 * wakes the campaign's Ambassador and ends the step waits it matches, where
 * the eligibility table judged it a thing to answer (`refreshRelationship`) —
 * accepting is not interest, so by default it wakes nothing and no DM follows
 * it.
 *
 * The watch is keyed on the invitation's own record — the `invitation_confirmed`
 * its settlement wrote, whether a read or the owner's word settled it — not on
 * the relationship a read last showed. Nothing to wait for ends it: the
 * conversation closed (reopened among the reasons), or the invitation answered —
 * accepted, withdrawn by the owner, or gone. Pending waits for the next point
 * of the schedule, counted from the send; a read that
 * could not tell changes nothing and waits on, as does one the budget refuses
 * (`reserveResearchRead`, the account's profile reads), one that fails, or one
 * that shows anything else: a watch is a read, and a missed one only delays
 * an answer. Never a press, never a second invitation: the watch only reads.
 *
 * The read holds the account's run lease (`worker-run:<channelId>`), as a
 * worker run and the inbox check do — one browser profile, one reader. A
 * lease another run holds reads nothing, and the watch looks again shortly.
 *
 * SELF_SCOPED: the read is a page load in no transaction, between two short
 * ones (`refreshRelationship`).
 */
export async function handleInvitationWatch(
  ctx: SelfScopedCtx,
  payload: InvitationWatchPayload,
): Promise<JobResult> {
  payload = conversationPayload(payload);
  const org = ctx.organizationId;
  const now = Date.now();
  const [conversation, outstanding] = await withOrg(org, async (tx) => [
    (await tx.select().from(conversations).where(eq(conversations.id, payload.conversationId)))[0],
    await outstandingInvitation(tx, payload.conversationId),
  ] as const);
  if (!conversation || conversation.closedReason !== null || !outstanding) return { settled: 1 };
  if (now >= payload.expiresAt) return { expired: 1 };
  const next = Math.min(nextInvitationRecheck(outstanding.occurredAt, now), payload.expiresAt);
  const refreshed = await leasedRead(ctx, conversation, { now, next, expiresAt: payload.expiresAt });
  if (refreshed === null) return { settled: 1 };
  if (refreshed.accepted) return { accepted: 1 };
  if (refreshed.gone) return { gone: 1 };
  throw new RescheduleError(
    relationshipOf(refreshed.read, conversation.authorProfileId) === "outgoing_pending" ? "pending" : "unanswered",
    next,
  );
}

/** How soon a withdrawal's read that left nothing read is tried again. */
const WITHDRAWAL_READ_RETRY_MS = 60 * MINUTE;

/**
 * Worker handler for `withdrawal_read`: one read of a person whose invitation
 * of ours was withdrawn on the owner's word alone (`settleWithdrawal`,
 * `actions/withdrawInvite.ts`). The withdrawal is on the log, but no read
 * moved the relationship off `outgoing_pending`; this read is what does —
 * recorded as any read is (`recordRelationshipRead`), whatever it shows. A
 * read since that moved it ends the job with nothing read; one the budget,
 * the lease or the page leaves undone is tried again hourly until
 * `WITHDRAWAL_READ_WINDOW_MS` has passed. Never a press: the job only reads.
 */
export async function handleWithdrawalRead(
  ctx: SelfScopedCtx,
  payload: WithdrawalReadPayload,
): Promise<JobResult> {
  payload = conversationPayload(payload);
  const now = Date.now();
  const [conversation] = await withOrg(ctx.organizationId, (tx) =>
    tx.select().from(conversations).where(eq(conversations.id, payload.conversationId)),
  );
  if (!conversation || conversation.closedReason !== null || conversation.relationship !== "outgoing_pending") return { settled: 1 };
  if (now >= payload.expiresAt) return { expired: 1 };
  const refreshed = await leasedRead(ctx, conversation, {
    now,
    next: Math.min(now + WITHDRAWAL_READ_RETRY_MS, payload.expiresAt),
    expiresAt: payload.expiresAt,
  });
  return refreshed === null ? { settled: 1 } : { read: 1 };
}

/**
 * One read of a conversation's person in the account's session, holding the
 * account's run lease (`worker-run:<channelId>`), as a worker run and the
 * inbox check do — one browser profile, one reader. Everything that leaves
 * nothing read reschedules the job: no grant, or a lease another run holds,
 * shortly; a read the budget refuses, when it says; one that fails or cannot
 * tell — which changes nothing — at `next`. Never past `expiresAt`. Null when
 * the connector has no relationship read or the conversation is gone.
 */
async function leasedRead(
  ctx: SelfScopedCtx,
  conversation: ConversationRow,
  at: { now: number; next: number; expiresAt: number },
): Promise<Extract<RelationshipRefresh, { status: "read" }> | null> {
  const org = ctx.organizationId;
  const { now, next, expiresAt } = at;
  const granted = await withOrg(org, async (tx) => {
    await assertHostedJobSpendStillAllowedInTx(tx, ctx);
    return grantFor(ctx, tx, "relationship");
  });
  if (!isGrant(granted)) {
    throw new RescheduleError(
      granted.detail ?? "LinkedIn account is not connected",
      Math.min(now + 5 * MINUTE, expiresAt),
      granted,
    );
  }
  await assertHostedJobSpendStillAllowed(ctx);
  const leaseKey = `worker-run:${conversation.channelId}`;
  const lease = await withOrg(org, (tx) => claimExclusiveRun(tx, leaseKey, READ_LEASE_MS, now));
  if (!lease.claimed) throw new RescheduleError("lease_held", Math.min(now + 5 * MINUTE, expiresAt));
  let refreshed: RelationshipRefresh;
  try {
    refreshed = await refreshRelationship({
      organizationId: org,
      driver: granted.use,
      conversationId: conversation.id,
      now,
      recordUnclear: false,
    });
  } catch (error) {
    if (isConnectorBackoff(error)) await pauseChannelForConnectorBackoff(org, error);
    throw new RescheduleError(`unreadable: ${error instanceof Error ? error.message : String(error)}`, next);
  } finally {
    await withOrg(org, (tx) => releaseExclusiveRun(tx, leaseKey, lease.expiresAt, Date.now()));
  }
  if (refreshed.status === "refused") {
    // The refusal is the row's receipt: the scheduler leaves a watch the
    // budget put off where the budget said (`scheduleInvitationWatches`).
    const retryAt = Math.min(refreshed.retryAt ?? next, expiresAt);
    throw new RescheduleError(refreshed.reason, retryAt, refuseChannel(refreshed.reason, undefined, retryAt));
  }
  if (refreshed.status === "unclear") throw new RescheduleError("unclear", next);
  return refreshed.status === "read" ? refreshed : null;
}
