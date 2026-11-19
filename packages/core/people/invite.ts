import { and, eq, inArray } from "drizzle-orm";
import { jobs, conversations, type ActionRow } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { openWithdrawal } from "../actions/withdrawInvite";
import { askOwner } from "../execution/reconcileReads";
import { goneInvitation, outstandingInvitation } from "../conversations/record";

/**
 * AN INVITE OF OURS NOT ANSWERED YET — what a person's pane shows at the
 * bottom of the thread it went out from, until they accept it: when it went,
 * and whether Engager still reads them for their answer (an hour after the
 * send, then daily).
 *
 * Pending means what the log and the last read agree on: an
 * `invitation_confirmed` no acceptance has answered, on an open conversation whose
 * relationship a read showed `outgoing_pending`. The read is the watch
 * its settlement enqueued (`invitation_watch`, `actions/invite.ts`), queued
 * or running; it ends three weeks after the send at the latest, and nothing
 * here ever sends a second invite. The owner's withdrawal of it, while one is
 * open, says where it stands (`actions/withdrawInvite.ts`); once confirmed,
 * the invitation is answered and nothing is pending. One a read found
 * LinkedIn no longer lists (`invitation_gone`: withdrawn, or expired) stays
 * on the pane as that, and is never sent again.
 *
 * Reads only, inside the caller's `withOrg`; `jobs`, outside RLS, is read by
 * the conversation's own organization.
 */

export type PendingInvite = {
  /** Its ledger row, which the thread it went out from names; null where the
   *  log holds it with none behind it. */
  actionId: number | null;
  sentAt: number;
  /** Engager still reads them for their answer. */
  watched: boolean;
  /** The owner's withdrawal of it while one is open — its ledger row, and
   *  where it stands — else null. */
  withdrawal: { actionId: number; standing: WithdrawalStanding } | null;
  /** When a read of them found LinkedIn no longer lists it — withdrawn, or
   *  expired — else null while it is pending. */
  goneAt: number | null;
};

/** `going` — approved, on its way to the press; `checking` — pressed, and its
 *  outcome being read, never pressed again; `unclear` — the reads gave up,
 *  and what LinkedIn shows is the owner's to say. */
export type WithdrawalStanding = "going" | "checking" | "unclear";

/** Where an open withdrawal stands, as the block says it. One whose yes
 *  lapsed stands nowhere: the next press approves it again. */
export function withdrawalStanding(
  row: ActionRow | null,
  now: number = Date.now(),
): WithdrawalStanding | null {
  if (row === null || row.status === "awaiting_review") return null;
  if (row.status !== "uncertain") return "going";
  return askOwner(row, now) ? "unclear" : "checking";
}

export async function readPendingInvite(tx: Tx, conversationId: number): Promise<PendingInvite | null> {
  const [conversation] = await tx
    .select({
      organizationId: conversations.organizationId,
      relationship: conversations.relationship,
      closedReason: conversations.closedReason,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  if (!conversation || conversation.closedReason !== null) return null;
  if (conversation.relationship !== "outgoing_pending") {
    const gone = await goneInvitation(tx, conversationId);
    if (!gone) return null;
    return {
      actionId: gone.sent.sourceRef.actionExecutionId ?? null,
      sentAt: gone.sent.occurredAt,
      watched: false,
      withdrawal: null,
      goneAt: gone.gone.occurredAt,
    };
  }
  const sent = await outstandingInvitation(tx, conversationId);
  if (!sent) return null;
  const actionId = sent.sourceRef.actionExecutionId ?? null;
  const [watch] =
    actionId === null
      ? []
      : await tx
          .select({ id: jobs.id })
          .from(jobs)
          .where(
            and(
              eq(jobs.organizationId, conversation.organizationId),
              eq(jobs.idempotencyKey, `invitation_watch:${actionId}`),
              inArray(jobs.status, ["queued", "running"]),
            ),
          )
          .limit(1);
  const open = await openWithdrawal(tx, conversationId);
  const standing = withdrawalStanding(open);
  return {
    actionId,
    sentAt: sent.occurredAt,
    watched: watch !== undefined,
    withdrawal: open && standing ? { actionId: open.id, standing } : null,
    goneAt: null,
  };
}
