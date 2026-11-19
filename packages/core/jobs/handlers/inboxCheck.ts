import type { Campaign } from "@engager/database/schema";
import { withOrg } from "@engager/database/tenant";
import { getLLM } from "../../ai/client";
import { invitationsCheckKind, invitationsReader } from "../../invitations/wake";
import { inboxCheckKind, observeInbox, syncConversation } from "../../conversations/inbox";
import { inboxCheckGate } from "../../conversations/inboxCheck";
import {
  claimExclusiveRun,
  claimPacedRun,
  deferPacedRun,
  releaseExclusiveRun,
  renewExclusiveRun,
} from "../../pacing";
import { capabilityGrant } from "../context";
import {
  assertHostedJobSpendStillAllowed,
  assertHostedJobSpendStillAllowedInTx,
} from "../spendAccess";
import { RescheduleError } from "../queue";
import type { JobResult, SelfScopedCtx } from "../worker";
import { readInvitations } from "./workerRun";

const MINUTE = 60_000;

/** How long the check holds the account's run lease before it must renew:
 *  an inbox read is the inbox page and at most three spaced conversations. */
const CHECK_LEASE_MS = 10 * MINUTE;

/**
 * Worker handler for `inbox_check`: the account's light look at its inbox
 * between Ambassador wakes, so a DM is seen within the owner's "Check
 * messages every" rather than whenever the comment day plan next wakes a
 * worker.
 *
 * Enqueued every five-minute slot and SELF-PACED, as `poll_incoming` is: the
 * gate (`conversations/inboxCheck.ts`) decides whether the inbox may be read at
 * all, and `claimPacedRun` whether this slot is the one — a jittered interval
 * on the account's cadence, never a fixed one. A shut window claims nothing
 * and holds the check to a random point in the first interval after it opens,
 * so the first look of the day does not land on the same minute every day.
 *
 * The read is the Ambassador's own (`observeInbox`): the same budget
 * reservation, the same recording, and the same wake of the campaign that owns
 * a conversation when a message is a thing to answer — keyed on the event, so
 * a message seen twice wakes it once. The read itself pushes the next check
 * out, as a wake's read does.
 *
 * Who invited the account is looked at the same way, on a paced slot of its
 * own at the same cadence, wherever an active campaign's Ambassador binds
 * Accept invite (`invitations/wake.ts`): the Ambassador's own read
 * (`readInvitations`), so an invitation tied to a conversation has its
 * acceptance reserved for the owner's yes within one interval of arriving,
 * rather than at the Ambassador's next wake. That read pushes its slot out
 * too, as a wake's does. A slot comes due on its own: an inbox not due still
 * lets a due invitations look go ahead, and the other way round.
 *
 * It holds the account's run lease (`worker-run:<channelId>`) across the
 * read, so it serializes with worker runs in every process: one browser
 * profile, one reader. A lease another run holds claims nothing — not even the
 * paced slot — and the next tick asks again.
 *
 * A job naming a conversation is the owner's Check LinkedIn now on it
 * (`requestConversationSync`): no paced slot, that conversation alone.
 *
 * SELF_SCOPED: one short scope for the gate and the claims, the read between
 * scopes of its own, no transaction held across a page load or a model call.
 */
export async function handleInboxCheck(
  ctx: SelfScopedCtx,
  payload: unknown,
): Promise<JobResult> {
  const org = ctx.organizationId;
  const now = Date.now();
  const conversationId = (payload as { conversationId?: unknown } | null)?.conversationId;
  if (typeof conversationId === "number") return checkConversationNow(ctx, conversationId, now);
  const begun = await withOrg(
    org,
    async (
      tx,
    ): Promise<
      | {
          channelId: number;
          /** The campaign the inbox is read for; null when it is not due. */
          inbox: Campaign | null;
          /** Whether the look at who invited the account is due. */
          invitations: boolean;
          leaseKey: string;
          leaseExpiry: number;
        }
      | { skipped: JobResult }
    > => {
      await assertHostedJobSpendStillAllowedInTx(tx, ctx);
      const gate = await inboxCheckGate(tx, now);
      if (gate.kind === "off" || gate.kind === "stopped") {
        return { skipped: { [gate.reason]: 1 } };
      }
      const channelId = gate.channel.id;
      const kind = inboxCheckKind(channelId);
      const baseMs = gate.channel.inboxCheckBaseMin * MINUTE;
      const inviters = await invitationsReader(tx, channelId);
      if (gate.kind === "closed") {
        await deferPacedRun(tx, kind, gate.nextOpen, baseMs, now);
        if (inviters) await deferPacedRun(tx, invitationsCheckKind(channelId), gate.nextOpen, baseMs, now);
        return { skipped: { outside_window: 1 } };
      }
      const leaseKey = `worker-run:${channelId}`;
      const lease = await claimExclusiveRun(tx, leaseKey, CHECK_LEASE_MS, now);
      if (!lease.claimed) return { skipped: { lease_held: 1 } };
      const inbox = (await claimPacedRun(tx, kind, baseMs, now)).due ? gate.campaign : null;
      const invitations =
        inviters !== null && (await claimPacedRun(tx, invitationsCheckKind(channelId), baseMs, now)).due;
      if (!inbox && !invitations) {
        await releaseExclusiveRun(tx, leaseKey, lease.expiresAt, now);
        return { skipped: { not_due: 1 } };
      }
      return { channelId, inbox, invitations, leaseKey, leaseExpiry: lease.expiresAt };
    },
  );
  if ("skipped" in begun) return begun.skipped;

  const { leaseKey } = begun;
  let leaseExpiry = begun.leaseExpiry;
  // Between page loads: the job still wanted, and the lease still ours.
  const continueRun = async () => {
    if (ctx.signal?.aborted) return false;
    const renewed = await withOrg(org, (tx) =>
      renewExclusiveRun(tx, leaseKey, CHECK_LEASE_MS, Date.now(), leaseExpiry),
    );
    if (renewed === null) return false;
    leaseExpiry = renewed;
    return true;
  };
  try {
    await assertHostedJobSpendStillAllowed(ctx);
    let result: Record<string, number> = {};
    if (begun.inbox) {
      const observed = await observeInbox({
        organizationId: org,
        campaign: begun.inbox,
        grant: capabilityGrant(ctx),
        llm: ctx.llm ?? getLLM(),
        runId: null,
        now,
        continueRun,
      });
      result =
        observed.status === "read"
          ? {
              read: 1,
              threadsRead: observed.threadsRead,
              messagesRecorded: observed.recorded,
              ...(observed.reader === "agent" ? { agentReader: 1 } : {}),
            }
          : { [observed.status]: 1 };
    }
    if (begun.invitations && (await continueRun())) {
      // Asked again: a Stop written while the inbox was read holds this look.
      const reader = await withOrg(org, (tx) => invitationsReader(tx, begun.channelId));
      const read = reader !== null && (await readInvitations(ctx, reader, begun.channelId, now)) === null;
      result[read ? "invitationsRead" : "invitationsNotRead"] = 1;
    }
    return result;
  } finally {
    await withOrg(org, (tx) => releaseExclusiveRun(tx, leaseKey, leaseExpiry, Date.now()));
  }
}

/**
 * The owner's Check LinkedIn now on one conversation: the account's stops as
 * the check's own, and its run lease — one browser profile, one reader. A
 * lease another run holds puts the job back a minute rather than dropping
 * what the owner asked for.
 */
async function checkConversationNow(ctx: SelfScopedCtx, conversationId: number, now: number): Promise<JobResult> {
  const org = ctx.organizationId;
  const begun = await withOrg(org, async (tx) => {
    await assertHostedJobSpendStillAllowedInTx(tx, ctx);
    const gate = await inboxCheckGate(tx, now);
    if (gate.kind === "off" || gate.kind === "stopped") return { kind: "skipped", result: { [gate.reason]: 1 } } as const;
    const leaseKey = `worker-run:${gate.channel.id}`;
    const lease = await claimExclusiveRun(tx, leaseKey, CHECK_LEASE_MS, now);
    if (!lease.claimed) return { kind: "busy" } as const;
    return { kind: "claimed", leaseKey, leaseExpiry: lease.expiresAt } as const;
  });
  if (begun.kind === "skipped") return begun.result;
  if (begun.kind === "busy") throw new RescheduleError("another read holds the account", now + MINUTE);
  try {
    const synced = await syncConversation({
      organizationId: org,
      conversationId,
      grant: capabilityGrant(ctx),
      llm: ctx.llm ?? getLLM(),
      now,
    });
    return synced.status === "read" ? { read: 1, messagesRecorded: synced.recorded } : { [synced.status]: 1 };
  } finally {
    await withOrg(org, (tx) => releaseExclusiveRun(tx, begun.leaseKey, begun.leaseExpiry, Date.now()));
  }
}
