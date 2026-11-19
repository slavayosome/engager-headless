import { and, eq, sql } from "drizzle-orm";
import {
  actionApprovals,
  actions,
  campaigns,
  messages,
  rateLimitLedger,
  type ActionRow,
  type Message,
} from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import type {
  ActionReceipt,
  ActionSurface,
  OperationContext,
  Preflight,
} from "../execution/actionGate";
import type { PostInput } from "../linkedin/driver";
import { assignSlots } from "../operations/schedule";
import { postExactlyOnce, type PostWrite } from "../posting";
import { pauseChannel } from "../ratelimit/killswitch";
import { enqueueActionDispatch } from "./drain";

/**
 * THE SEND OF A MESSAGE'S WORDS AS AN ACTION — what a comment, a room reply and
 * a public reply share. The `messages` row stays the record every surface
 * reads, and the action is what sends: the gate's hooks write the message's
 * state back as the action's moves, and the message leaving `approved` cancels
 * a queued action in the same transaction (`engager_withdraw_message_send`,
 * `packages/database/triggers.ts`). The kinds differ only in what they check
 * before the click and in what a confirmed send leaves behind
 * (`actions/comment.ts`, `actions/roomReply.ts`, `actions/reply.ts`).
 */
/** How stale a planned slot may be and still fire. Past this, the message is
 *  re-slotted through the day plan: a backlog flushed after downtime must
 *  reshuffle the plan, never machine-gun the account. */
export const SLOT_GRACE_MS = 15 * 60_000;

/** How long a send the connector never attempted waits before the next try. */
export const NOT_ATTEMPTED_RETRY_MS = 5 * 60_000;

/** Why a message send was returned for another look rather than failed. */
const REVIEW_REASONS = /^(room_|lead_|mode_off$|review_required$|country_unknown$|do_not_engage$|opt_out$|approval_|ceiling_reached$|paused:|superseded:)/;

/** What stops a send the gate has just written `dispatching`: the gate turns it
 *  into the refusal it names, in the same transaction, so nothing is marked
 *  and nothing is sent. */
export type PostingRefusal = { kind: "cancel" | "block"; reason: string };

export const blockedBefore = (reason: string, detail: Record<string, unknown> = {}): Preflight => ({
  proceed: false,
  receipt: { status: "blocked", evidence: { reason, ...detail } },
});

/** The message a queued send is for, or the preflight that ends its turn: a
 *  settled or withdrawn message sends nothing, a slot not yet reached holds,
 *  and a worker's send with no slot or a long-overdue one is re-slotted rather
 *  than fired. Otherwise the message is due and the kind's own checks may run. */
export async function dueMessage(
  tx: Tx,
  row: ActionRow,
  now: number,
): Promise<{ message: Message } | { preflight: Preflight }> {
  const [message] = row.messageId === null ? [] : await tx.select().from(messages).where(eq(messages.id, row.messageId));
  if (!message) return { preflight: blockedBefore("message_gone") };
  if (message.status === "posted" && message.externalUrn) {
    return { preflight: { proceed: false, receipt: { status: "confirmed", noop: true, evidence: { externalUrn: message.externalUrn, reason: "already_posted" } } } };
  }
  if (message.status !== "approved") return { preflight: blockedBefore("message_not_approved", { messageStatus: message.status }) };
  if (message.scheduledAt != null && now < message.scheduledAt) {
    return { preflight: { proceed: false, hold: "before_scheduled_slot", retryAt: message.scheduledAt } };
  }
  // Nor does a worker's send go out without a slot in the day plan.
  const unslotted = message.scheduledAt == null && message.publishOrigin === "worker";
  if ((unslotted || (message.scheduledAt != null && now > message.scheduledAt + SLOT_GRACE_MS)) && message.campaignId !== null) {
    const [campaign] = await tx.select().from(campaigns).where(eq(campaigns.id, message.campaignId));
    await tx.update(messages).set({ scheduledAt: null }).where(eq(messages.id, message.id));
    const [slot] = campaign ? await assignSlots(tx, { campaign, origin: message.publishOrigin, now, items: [{ messageId: message.id, kind: message.kind }] }) : [];
    return { preflight: { proceed: false, hold: unslotted ? "slot_unassigned" : "slot_overdue_replanned", retryAt: slot ? slot.scheduledAt : now + NOT_ATTEMPTED_RETRY_MS } };
  }
  return { message };
}

/** The click, and what its answer means for the action: a rate limit or a
 *  browser that never tried is not sent and clears on its own, a 5xx or a
 *  timeout may have landed and is never retried blind, and a success flag
 *  without the comment's receipt proves no contact. */
export async function performSend(write: PostWrite, noun: string): Promise<ActionReceipt> {
  const res = await postExactlyOnce(write);
  if (res.rateLimited) {
    return { status: "definitely_not_sent", evidence: { reason: "rate_limited", error: res.error, rateLimited: true, retry: true } };
  }
  if (!res.ok && res.notAttempted && res.retryable) {
    return { status: "definitely_not_sent", evidence: { reason: "not_attempted", error: res.error, retry: true } };
  }
  if (!res.ok && res.retryable) return { status: "uncertain", evidence: { error: res.error ?? "post failed (outcome unknown)" } };
  if (!res.ok) return { status: "definitely_not_sent", evidence: { reason: "provider_rejected", error: res.error ?? "post failed", code: res.code ?? null } };
  if (!res.externalUrn?.trim()) return { status: "uncertain", evidence: { error: `${noun} returned no confirmed receipt.` } };
  return { status: "confirmed", evidence: { externalUrn: res.externalUrn, reconciled: res.reconciled ?? false } };
}

/** The gate refused a queued send before any click. A send short of an owner's
 *  look goes back to `proposed`; one the account may never send fails. Either
 *  way no action stays queued: a fresh yes queues a fresh one. */
export async function returnMessage(
  tx: Tx,
  row: ActionRow,
  refusal: { kind: "review" | "invalidate" | "cancel" | "block"; reason: string },
  now: number,
): Promise<void> {
  const failed = (refusal.kind === "block" || refusal.kind === "cancel") && !REVIEW_REASONS.test(refusal.reason);
  await tx.update(actions)
    .set({ status: "cancelled", statusReason: refusal.reason, settledAt: now, updatedAt: now })
    .where(and(eq(actions.id, row.id), eq(actions.status, "awaiting_review")));
  await tx.update(messages)
    .set(failed
      ? { status: "failed", error: refusal.reason, errorCode: refusal.reason, lastAttemptAt: now, scheduledAt: null }
      : { status: "proposed", error: refusal.reason, scheduledAt: null })
    .where(and(eq(messages.id, row.messageId!), eq(messages.status, "approved")));
}

/** What a settled send does to its message, in the transaction that settles
 *  it, whoever settled it: the gate, a reconciliation read, the owner.
 *  `posted` is what the kind leaves behind when the send is confirmed. */
export async function settleMessageSend(
  tx: Tx,
  row: ActionRow,
  receipt: ActionReceipt,
  now: number,
  posted: (tx: Tx, row: ActionRow, message: Message, urn: string, settledBy: "gate" | "reconcile" | "owner", now: number) => Promise<void>,
): Promise<void> {
  if (row.messageId === null) return;
  const [message] = await tx.select().from(messages).where(eq(messages.id, row.messageId)).for("update");
  if (!message || message.status === "posted") return;
  const attempt = row.attempts.find((candidate) => candidate.operationId === row.fenceToken);
  const settledBy = attempt?.settledBy ?? "gate";
  const evidence = receipt.evidence;
  const reason = String(evidence.error ?? evidence.reason ?? receipt.status);
  const clearPosting = { postingStartedAt: null } as const;
  // The message moved out from under the send: its own state stands. So does
  // one that already shows the answer an update took from the old resolver.
  if (receipt.status === "blocked" && ["message_gone", "message_not_approved"].includes(String(evidence.reason))) return;
  if (evidence.folded === true) return;
  switch (receipt.status) {
    case "confirmed": {
      const urn = String(evidence.externalUrn ?? evidence.observedTarget ?? "").trim();
      if (!urn) throw new Error("A reply requires a confirmed comment receipt before settlement.");
      await posted(tx, row, message, urn, settledBy, now);
      return;
    }
    case "uncertain":
      await tx.update(messages).set({
        status: "needs_review", ...clearPosting,
        error: "posting was interrupted mid-flight and the outcome could not be verified — check LinkedIn, then say whether it went out",
      }).where(eq(messages.id, message.id));
      return;
    case "definitely_not_sent": {
      if (settledBy === "owner") {
        await tx.update(messages).set({ status: "proposed", error: null, scheduledAt: null, ...clearPosting, redraftRequestVersion: message.redraftRequestVersion + 1 })
          .where(eq(messages.id, message.id));
        return;
      }
      if (evidence.retry === true) {
        if (evidence.rateLimited === true) await pauseChannel(tx, "429 / checkpoint", 120);
        await rearm(tx, row, message, now);
        return;
      }
      await tx.update(messages).set({ status: "failed", error: reason, errorCode: String(evidence.code ?? evidence.reason ?? "failed"), lastAttemptAt: now, scheduledAt: null, ...clearPosting })
        .where(eq(messages.id, message.id));
      return;
    }
    case "blocked": {
      const review = REVIEW_REASONS.test(String(evidence.reason ?? ""));
      await tx.update(messages).set(review
        ? { status: "proposed", error: String(evidence.message ?? evidence.reason), scheduledAt: null, ...clearPosting }
        : { status: "failed", error: reason, errorCode: reason, lastAttemptAt: now, scheduledAt: null, ...clearPosting })
        .where(eq(messages.id, message.id));
      return;
    }
  }
}

/** What a confirmed send does to the budget: the gate minted the row before the
 *  click, and it now names the message it counts toward. An attempt the
 *  migration fenced uncertain has none, so its confirmation mints it. */
export async function countSend(
  tx: Tx,
  row: ActionRow,
  message: Message,
  now: number,
  how: { settledBy: "gate" | "reconcile" | "owner"; postAge: number | null; targetMemberUrn?: string },
): Promise<void> {
  const meta = { postAge: how.postAge, reconciled: how.settledBy !== "gate", loopVersion: message.loopVersion ?? null };
  const counted = await tx.update(rateLimitLedger)
    .set({ messageId: message.id, targetMemberUrn: how.targetMemberUrn, meta: sql`${rateLimitLedger.meta} || ${JSON.stringify(meta)}::jsonb` })
    .where(and(
      sql`${rateLimitLedger.meta} ->> 'kind' = 'action_execution_receipt'`,
      sql`${rateLimitLedger.meta} ->> 'actionExecutionId' = ${String(row.id)}`,
      sql`${rateLimitLedger.meta} ->> 'state' = 'confirmed'`,
    )).returning({ id: rateLimitLedger.id });
  if (counted.length > 0) return;
  await tx.insert(rateLimitLedger).values({
    action: row.kind, channelId: row.channelId, campaignId: message.campaignId, targetProfileId: message.targetProfileId,
    targetMemberUrn: how.targetMemberUrn, messageId: message.id,
    meta: { kind: "action_execution_receipt", actionExecutionId: row.id, operationId: row.fenceToken, state: "confirmed", settledAt: now, ...meta },
  });
}

/** The owner's answer on an uncertain send, handed to the sidecar's journal
 *  entry for the attempt (`resolveUncertainWriteOutcome`), which records it as
 *  said. The action settles, and the account's fence is let go, only once the
 *  journal has taken it. A journal that holds the write the other way is a
 *  contradiction neither answer wins (`contradicted`). */
export async function closeMessageJournal(
  driver: ActionSurface,
  organizationId: string,
  connector: OperationContext["connector"],
  row: ActionRow,
  prior: (tx: Tx, message: Message) => Promise<PostInput>,
  answer: { observed: "went_out" | "not_sent"; target?: string; version?: number },
): Promise<"recorded" | "not_journaled" | "contradicted"> {
  const frozen = await withOrg(organizationId, async (tx) => {
    const [message] = await tx.select().from(messages).where(eq(messages.id, row.messageId!));
    return message ? { input: await prior(tx, message), version: answer.version ?? message.redraftRequestVersion + 1 } : null;
  });
  if (!frozen) return "not_journaled";
  const resolve = driver.resolveUncertainWriteOutcome;
  // Connectors with no sidecar journal have nothing local to settle.
  if (!resolve) {
    if (connector === "local_browser") throw new Error("write journal unavailable");
    return "not_journaled";
  }
  const session = await driver.ensureSession();
  if (!session.ok) throw new Error("account unavailable");
  const postedUrn = answer.observed === "went_out" ? answer.target : undefined;
  const result = await resolve.call(driver, frozen.input, frozen.version, postedUrn);
  if (result.operationId !== frozen.input.marker || result.resolutionVersion !== frozen.version) {
    throw new Error("The connector returned a different write resolution.");
  }
  if (postedUrn) return result.state === "already_committed" && result.externalUrn === postedUrn ? "recorded" : "contradicted";
  return result.state === "already_committed" ? "contradicted" : "recorded";
}

/** A send the connector never attempted, on something that clears on its own:
 *  the row goes back to the queue on the yes it already has, to the day plan's
 *  next slot at least five minutes on. The yes keeps its own expiry. */
async function rearm(tx: Tx, row: ActionRow, message: Message, now: number): Promise<void> {
  const [used] = await tx.select().from(actionApprovals)
    .where(eq(actionApprovals.actionExecutionId, row.id)).orderBy(sql`${actionApprovals.id} desc`).limit(1);
  const retryAfter = now + NOT_ATTEMPTED_RETRY_MS;
  await tx.update(actions)
    .set({ status: used ? "approved" : "reserved", statusReason: null, settledAt: null, updatedAt: now })
    .where(eq(actions.id, row.id));
  if (used) {
    await tx.insert(actionApprovals).values({
      actionExecutionId: row.id, approver: used.approver, contentHash: used.contentHash, targetHash: used.targetHash,
      dependencyVersions: used.dependencyVersions, expiresAt: used.expiresAt, createdAt: used.createdAt,
    });
  }
  await tx.update(messages).set({ status: "approved", postingStartedAt: null, scheduledAt: null }).where(eq(messages.id, message.id));
  const [campaign] = message.campaignId === null ? [] : await tx.select().from(campaigns).where(eq(campaigns.id, message.campaignId));
  const [slot] = campaign ? await assignSlots(tx, { campaign, origin: message.publishOrigin, now: retryAfter, items: [{ messageId: message.id, kind: message.kind }] }) : [];
  const retryAt = Math.max(slot?.scheduledAt ?? 0, retryAfter);
  if (!slot || slot.scheduledAt < retryAt) await tx.update(messages).set({ scheduledAt: retryAt }).where(eq(messages.id, message.id));
  await enqueueActionDispatch(tx, row.channelId, retryAt);
}
