import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  actions,
  conversations,
  type ActionRow,
  type ConversationRow,
  type RelationshipReadJson,
} from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { enqueue } from "../jobs/queue";
import type { ActionOperation, ActionReceipt, ActionSurface, Preflight } from "../execution/actionGate";
import { outstandingInvitation, recordInvitationWithdrawn } from "../conversations/record";
import { refreshRelationship } from "../conversations/refresh";
import { relationshipOf } from "../conversations/relationship";
import { RelationshipReadSchema } from "../linkedin/browser-use/protocol";
import { isConnectorBackoff } from "../linkedin/connectorError";
import type { WithdrawInvitationResult } from "../linkedin/driver";
import { pauseChannelForConnectorBackoff } from "../ratelimit/killswitch";
import { approveAction } from "./approval";
import { ActionLedgerError } from "./errors";
import { INVITATION_RESOLVE_SETTLE_MS, inviteTargetFor } from "./invite";
import { reserveAction } from "./ledger";
import { currentGeneration } from "./pause";

/**
 * WITHDRAW INVITE — the owner's own press on an invitation of ours still
 * pending, on the action ledger (US-DM-12; INV-27, INV-31, INV-10).
 *
 * Only the owner withdraws. The kind is no catalog capability, so no step
 * binds it, no wake reserves one and no strategy can name it: the press
 * reserves one row through the ledger's one door, as the owner's
 * (`origin: owner`), and approves it in the same transaction
 * ({@link withdrawInvite}). The dispatch gate takes it from there like any
 * action — the kill switch, a Stop, the person's exclusion, the account's
 * spacing. The press is the yes, so there is no check to wait on: the
 * account's first confirmed withdrawal records `withdraw_invitation` as
 * verified (`liveChecks/records.ts`), and the owner's optional live check
 * queues its one write through {@link queueWithdrawal}.
 *
 * An invitation the owner sent to someone no campaign touched
 * (`ownerInvite.ts`) is withdrawn the same way: the conversation owns no
 * campaign, so the row names none, and the gate holds it on the account's own
 * guards alone (`ownerPress.ts`, `execution/actionGate.ts`) — no campaign's
 * Stop or pause reaches it.
 *
 * The browser half (`withdrawInviteOperation`) rides the sidecar's
 * `withdraw_invitation` on the write journal:
 *
 *   preflight  our `invitation_confirmed` on the conversation's log, then the
 *              person's own profile read in this browser session
 *              (`refreshRelationship`, a metered profile read, recorded on
 *              the conversation): only their page's data showing the invitation
 *              switch on Pending, for a member whose number keys it, goes on;
 *              connected, nothing pending, their invitation instead of ours,
 *              or none of ours on the log is blocked with nothing pressed; a
 *              read that cannot tell holds.
 *   perform    prepare re-reads the profile inside the op and binds the one
 *              control the page renders under the key that data names for
 *              their Pending, pressing nothing that withdraws; commit, once
 *              the journal holds the attempt, presses it and the
 *              confirmation's Withdraw and answers with a re-read showing
 *              their switch on Withdrawn or back on Connect — never the press.
 *   reconcile  a read of the profile against the attempt's journal entry:
 *              Withdrawn or Connect is the receipt; still Pending, read long
 *              enough after the press, is LinkedIn's data saying nothing was
 *              withdrawn; connected means nothing was left to withdraw.
 *              Nothing is pressed twice.
 *
 * Settled `confirmed`, the conversation takes `invitation_withdrawn`
 * ({@link settleWithdrawal}): the invitation is answered, its daily watch
 * ends, and the log's `invitation_confirmed` still forbids a second one on
 * the conversation — no step re-sends a withdrawn invitation. One the owner's word
 * settled has no read behind it, so the person is read once more
 * (`withdrawal_read`), and that read moves the relationship.
 */

/** A withdrawal on the ledger that has not settled for good: waiting for its
 *  yes again, on its way, or unsure. */
const OPEN_WITHDRAWAL = ["reserved", "awaiting_review", "approved", "dispatching", "uncertain"] as const;

/** The withdrawal of the conversation's invitation the ledger still holds open, if
 *  one is. */
export async function openWithdrawal(tx: Tx, conversationId: number): Promise<ActionRow | null> {
  const [row] = await tx
    .select()
    .from(actions)
    .where(
      and(
        eq(actions.conversationId, conversationId),
        eq(actions.kind, "withdraw_invite"),
        inArray(actions.status, [...OPEN_WITHDRAWAL]),
      ),
    )
    .orderBy(desc(actions.id))
    .limit(1);
  return row ?? null;
}

/**
 * The owner's Withdraw invite, on a person whose invitation from us is still
 * pending: queued and approved by the press ({@link queueWithdrawal}).
 */
export async function withdrawInvite(
  tx: Tx,
  input: { conversationId: number; by: string; now?: number },
): Promise<ActionRow> {
  const now = input.now ?? Date.now();
  // Unlocked: `reserveAction` re-reads it and takes the locks, in the order
  // the gate takes them.
  const [conversation] = await tx.select().from(conversations).where(eq(conversations.id, input.conversationId));
  if (!conversation) {
    throw new ActionLedgerError(
      "conversation_not_found",
      `Conversation ${input.conversationId} not found in this organization.`,
      "Open them from Inbox.",
    );
  }
  return queueWithdrawal(tx, { conversation, by: input.by, now });
}

/**
 * One withdrawal of the conversation's pending invitation, reserved through the
 * ledger's one door as the owner's and approved by the press — what
 * {@link withdrawInvite} queues, and what the optional live check withdraws
 * (`liveChecks/flow.ts`) as its one write. A withdrawal already open is never
 * doubled: one whose yes lapsed is approved again, and one on its way or
 * unsure is refused.
 */
export async function queueWithdrawal(
  tx: Tx,
  input: { conversation: ConversationRow; by: string; now: number },
): Promise<ActionRow> {
  const { conversation, now } = input;
  const open = await openWithdrawal(tx, conversation.id);
  if (open?.status === "awaiting_review") {
    return (await approveAction(tx, { id: open.id, approver: input.by, now })).action;
  }
  if (open) {
    throw new ActionLedgerError(
      "action_going_out",
      "A withdrawal of this invite is already on its way.",
      "Wait for it here: Engager settles it by reading their profile, never by pressing again.",
    );
  }
  const sent = conversation.relationship === "outgoing_pending" ? await outstandingInvitation(tx, conversation.id) : null;
  if (!sent) {
    throw new ActionLedgerError(
      "action_not_permitted",
      "No invite of ours to them is pending.",
      "Nothing to withdraw: the last read of their profile shows none.",
    );
  }
  // A key no row on the conversation holds: past every withdrawal numbered so far,
  // so one that settled without withdrawing never makes the next a duplicate.
  const [numbered] = await tx
    .select({ n: sql<number>`coalesce(max(${actions.sequence}), 0)::int` })
    .from(actions)
    .where(and(eq(actions.conversationId, conversation.id), eq(actions.kind, "withdraw_invite")));
  const reserved = await reserveAction(tx, {
    channelId: conversation.channelId,
    campaignId: conversation.owningCampaignId,
    conversationId: conversation.id,
    authorProfileId: conversation.authorProfileId,
    kind: "withdraw_invite",
    purpose: "withdrawal",
    sequence: (numbered?.n ?? 0) + 1,
    target: inviteTargetFor(conversation.authorProfileId),
    candidate: {
      text: null,
      sources: [{ eventId: sent.id, contentHash: null }],
      versions: { strategy: null, facts: [], memory: null, voice: null },
    },
    origin: "owner",
    mode: "review",
    generationSeen: await currentGeneration(tx),
    now,
  });
  if (reserved.status !== "reserved") {
    throw new ActionLedgerError(
      "action_not_permitted",
      reserved.status === "refused"
        ? `Engager will not withdraw it now: ${reserved.reason.replaceAll("_", " ")}.`
        : "A withdrawal of this invite is already on the ledger.",
      "Withdraw it on LinkedIn if it cannot wait.",
    );
  }
  return (await approveAction(tx, { id: reserved.action.id, approver: input.by, now })).action;
}

/** A preflight read that cannot tell is tried again this much later. */
const PREFLIGHT_RETRY_MS = 60 * 60_000;

export function withdrawInviteOperation(
  driver: ActionSurface,
  context: { organizationId: string; now: () => number },
): ActionOperation {
  return {
    async preflight(row) {
      const profileId = row.authorProfileId;
      if (row.conversationId === null || profileId === null || row.target.kind !== "person" || row.target.id !== profileId) {
        return blockedBefore("target_unresolved");
      }
      if (!driver.readRelationship || !driver.withdrawInvitation) return blockedBefore("invitations_unavailable");
      // Ours to withdraw only where the log holds it sent and unanswered.
      const ours = await withOrg(context.organizationId, (tx) => outstandingInvitation(tx, row.conversationId!));
      if (!ours) return blockedBefore("invitation_not_ours");
      let refreshed: Awaited<ReturnType<typeof refreshRelationship>>;
      try {
        refreshed = await refreshRelationship({
          organizationId: context.organizationId,
          driver,
          conversationId: row.conversationId,
          now: context.now(),
        });
      } catch (error) {
        if (isConnectorBackoff(error)) await pauseChannelForConnectorBackoff(context.organizationId, error);
        return { proceed: false, hold: "preflight:unreadable", retryAt: context.now() + PREFLIGHT_RETRY_MS };
      }
      switch (refreshed.status) {
        case "refused":
          return {
            proceed: false,
            hold: `preflight:${refreshed.reason}`,
            ...(refreshed.retryAt === undefined ? {} : { retryAt: refreshed.retryAt }),
          };
        case "unsupported":
          return blockedBefore("relationship_unreadable");
        case "not_found":
          return blockedBefore("conversation_gone");
        case "read":
          break;
      }
      const read = refreshed.read;
      switch (relationshipOf(read, profileId)) {
        case "outgoing_pending":
          // Pending only where the switch itself says so, for a member whose
          // number keys the control the sidecar binds.
          if (read.invitation === "pending" && read.memberId !== undefined && read.profileUrn !== undefined) {
            return { proceed: true };
          }
          return { proceed: false, hold: "relationship_unknown", retryAt: context.now() + PREFLIGHT_RETRY_MS };
        case "connected":
          return blockedBefore("already_connected", refreshed.read);
        case "not_connected":
          return blockedBefore("invitation_not_pending", refreshed.read);
        case "incoming_pending":
          return blockedBefore("invitation_incoming", refreshed.read);
        case "unknown":
          return { proceed: false, hold: "relationship_unknown", retryAt: context.now() + PREFLIGHT_RETRY_MS };
      }
    },
    async perform(row) {
      if (!driver.withdrawInvitation) {
        return { status: "definitely_not_sent", evidence: { reason: "invitations_unavailable", notAttempted: true } };
      }
      return withdrawalReceipt(
        await driver.withdrawInvitation({ operationId: row.fenceToken!, profileId: row.authorProfileId! }),
      );
    },
    async reconcile(row) {
      if (!driver.resolveWithdrawal || row.fenceToken === null || row.authorProfileId === null) return null;
      const resolution = await driver.resolveWithdrawal({
        operationId: row.fenceToken,
        profileId: row.authorProfileId,
      });
      const evidence = { relationship: resolution.relationship, reconciled: true };
      switch (resolution.status) {
        case "withdrawn":
          return { status: "confirmed", evidence };
        case "blocked":
          return { status: "blocked", evidence: { ...evidence, reason: resolution.reason ?? "blocked" } };
        case "not_sent":
          // The attempt never reached its press: nothing was withdrawn.
          return { status: "definitely_not_sent", evidence: { ...evidence, notAttempted: true } };
        case "pending": {
          const attempt = row.attempts.find((candidate) => candidate.operationId === row.fenceToken);
          const settledLongEnough =
            attempt !== undefined && context.now() - attempt.startedAt >= INVITATION_RESOLVE_SETTLE_MS;
          return settledLongEnough ? { status: "definitely_not_sent", evidence } : null;
        }
        case "uncertain":
          return null;
      }
    },
  };
}

function blockedBefore(reason: string, relationship?: RelationshipReadJson): Preflight {
  return {
    proceed: false,
    receipt: { status: "blocked", evidence: { reason, ...(relationship ? { relationship } : {}) } },
  };
}

/** The sidecar's answer as the ledger settles it. A confirmation carries the
 *  read that shows nothing pending. */
export function withdrawalReceipt(result: WithdrawInvitationResult): ActionReceipt {
  switch (result.status) {
    case "confirmed":
      return { status: "confirmed", evidence: { relationship: result.relationship } };
    case "blocked":
      return {
        status: "blocked",
        evidence: {
          reason: result.reason,
          ...(result.detail ? { detail: result.detail } : {}),
          ...(result.relationship ? { relationship: result.relationship } : {}),
        },
      };
    case "not_sent":
      return { status: "definitely_not_sent", evidence: { reason: result.reason, notAttempted: true } };
    case "uncertain":
      return {
        status: "uncertain",
        evidence: { error: result.reason, ...(result.relationship ? { relationship: result.relationship } : {}) },
      };
  }
}

/** How long after a withdrawal the owner's word settled its person is read
 *  for, before the read gives up. */
export const WITHDRAWAL_READ_WINDOW_MS = 24 * 60 * 60_000;

/**
 * What a settled withdrawal proves on its conversation, in the transaction that
 * settles it — whoever settled it: the gate's press, a reconciliation read,
 * the owner. A confirmed one is `invitation_withdrawn` on the log, carrying
 * the read that showed nothing pending where there is one. With none — the
 * owner's word on one nobody saw land — nothing moves the relationship, so
 * one read of the person is queued (`withdrawal_read`), and that read does.
 * Nothing else moves the conversation here: the preflight read already recorded
 * what it saw, and one that never went out leaves the invitation pending as
 * it was.
 */
export async function settleWithdrawal(
  tx: Tx,
  row: ActionRow,
  receipt: ActionReceipt,
  now: number,
): Promise<void> {
  if (receipt.status !== "confirmed" || row.conversationId === null) return;
  const read = RelationshipReadSchema.safeParse(receipt.evidence.relationship);
  const recorded = await recordInvitationWithdrawn(tx, {
    conversationId: row.conversationId,
    actionExecutionId: row.id,
    read: read.success ? read.data : null,
    now,
  });
  if (read.success || !recorded?.recorded) return;
  const payload: WithdrawalReadPayload = {
    conversationId: row.conversationId,
    actionExecutionId: row.id,
    expiresAt: now + WITHDRAWAL_READ_WINDOW_MS,
  };
  await enqueue(tx, {
    type: "withdrawal_read",
    payload,
    nextRunAt: now,
    idempotencyKey: `withdrawal_read:${row.id}`,
  });
}

export type WithdrawalReadPayload = {
  conversationId: number;
  /** The withdrawal the owner's word settled. */
  actionExecutionId: number;
  /** When the read gives up. */
  expiresAt: number;
};
