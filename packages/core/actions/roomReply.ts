import { and, eq, sql } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import {
  actions,
  commentWatches,
  conversationEvents,
  messages,
  stepRuns,
  type ActionCandidate,
  type ActionRow,
  type ActionTarget,
  type Campaign,
  type Message,
} from "@engager/database/schema";
import { withOrg, type Tx } from "@engager/database/tenant";
import { config } from "../config";
import { CONNECTOR_DECLARATIONS, isExactlyOnce } from "../connector/capabilities";
import type { CapabilitySurface } from "../connector/resolve";
import type {
  ActionOperation,
  ActionReceipt,
  ActionSurface,
  OperationContext,
  Preflight,
} from "../execution/actionGate";
import { currentRoomWork } from "../agentStep/roomWork";
import { followLifecycle, markContacted, reachedProfile } from "../leads/lifecycle";
import { recordRoomReplyFirstSend } from "../liveChecks/records";
import { jitteredIntervalMs, watchCheckBaseMs } from "../pacing";
import { replyCheckBaseMin } from "../ratelimit/ledger";
import { readReplySource, roomReplyKey, sameLeadSignal } from "../rooms/replySource";
import { roomReplyInput } from "../rooms/replyInput";
import { modeFor } from "../strategy/mode";
import { approveAction, invalidateApproval, liveApproval } from "./approval";
import { enqueueActionDispatch } from "./drain";
import { contentHash, roomReplyActionKey } from "./keys";
import { candidateRefusal } from "./ledger";
import { blockedBefore, closeMessageJournal, countSend, dueMessage, performSend, settleMessageSend } from "./messageSend";
import { currentGeneration } from "./pause";

/**
 * ROOM REPLY AS AN ACTION — a reply under a room member's comment goes out
 * through the action ledger like every other write, so one gate, one status
 * vocabulary and one recovery serve it (`execution/actionGate.ts`).
 *
 * The `messages` row stays the reply's record: its words, its draft history,
 * and every surface that lists a reply read it. The action is what sends, and
 * the two move together — `sendRoomReply` queues the action when the message
 * is approved, the gate's hooks write the message's state back as the action's
 * moves (`markRoomReplyPosting`, `returnMessage`, `settleRoomReply`), and the
 * message leaving `approved` cancels a queued action in the same transaction
 * (`engager_withdraw_message_send`, `packages/database/triggers.ts`).
 *
 * An action of this kind is never `awaiting_review`: the owner's yes is given
 * on the message, in Engager, before the action exists, and a refusal that
 * would ask for another sends the message back to `proposed` and cancels the
 * action. An Automatic proposal is `reserved` with no yes: the gate sends it to
 * the owner until the account has confirmed a first room reply.
 */

const targetOf = (message: Message): ActionTarget => {
  const target = message.roomReplyTarget;
  if (!target) throw new AppError("room_reply_target_missing", "Room reply target is missing.", 409);
  return {
    kind: "room_comment",
    id: target.parentCommentUrn,
    urn: target.parentCommentUrn,
    postUrn: target.postUrn,
    memberUrn: target.memberUrn,
  };
};

/**
 * Queue the send of an approved room reply. `yes` is the owner's, given on the
 * dashboard or the app; without it the action is an Automatic reservation. A
 * worker's reply needs its Reply in the room above Off and the owner's own
 * words need nothing (INV-1). Re-queuing the same reply — after an edit, an
 * unschedule, a send that was refused — takes up its row again; one that is
 * going out, or went, is left as it is.
 */
export async function sendRoomReply(
  tx: Tx,
  input: { message: Message; campaign: Campaign; yes: { by: string } | null; now?: number },
): Promise<ActionRow> {
  const { message, campaign } = input;
  const now = input.now ?? Date.now();
  if (campaign.channelId === null) throw new AppError("room_reply_campaign_unavailable", "This campaign has no account to send from.", 409);
  const origin = message.publishOrigin;
  const key = roomReplyActionKey(campaign.channelId, message.dedupeKey);
  const [existing] = await tx.select().from(actions).where(eq(actions.idempotencyKey, key)).for("update");
  if (existing && ["dispatching", "uncertain", "confirmed"].includes(existing.status)) return existing;

  const generationSeen = await currentGeneration(tx);
  const refused = await candidateRefusal(tx, {
    channelId: campaign.channelId, campaignId: campaign.id, conversationId: null,
    authorProfileId: message.targetProfileId, generationSeen, origin,
  });
  if (refused) {
    throw new AppError("room_reply_stopped", refused === "excluded" ? "This person is excluded." : "Sending is stopped. Your saved words are still here.", 409);
  }
  // The owner's words are only spaced, never held to a mode.
  const mode = origin === "owner" ? null : await modeFor(tx, { campaignId: campaign.id, capability: "reply_to_comment", target: "room_comment" });
  if (mode && mode.effective !== "review" && mode.effective !== "auto") {
    throw new AppError("room_reply_mode_off", "Reply in the room is Off for this campaign.", 409);
  }
  const text = message.finalText ?? message.proposedText;
  const candidate: ActionCandidate = {
    text, sources: [],
    ...(message.assistRetention === null ? {} : { assist: { assistRetention: message.assistRetention, ownerOrigin: message.ownerOrigin } }),
    versions: { strategy: null, facts: [], memory: null, voice: null },
  };
  const fields = {
    campaignId: campaign.id,
    messageId: message.id,
    authorProfileId: message.targetProfileId,
    actionBindingId: mode?.action_binding_id ?? null,
    target: targetOf(message),
    contentHash: contentHash("room_reply", text),
    candidate,
    origin,
    status: input.yes ? "awaiting_review" : "reserved",
    statusReason: null,
    generationSeen,
    updatedAt: now,
  } as const;
  let action: ActionRow;
  if (existing) {
    const approval = await liveApproval(tx, existing.id);
    if (approval) await invalidateApproval(tx, approval, "text", now);
    [action] = await tx.update(actions)
      .set({ ...fields, fenceToken: null, submittedAt: null, externalReceipt: null, settledAt: null })
      .where(eq(actions.id, existing.id)).returning() as [ActionRow];
  } else {
    [action] = await tx.insert(actions).values({
      ...fields, channelId: campaign.channelId, conversationId: null, kind: "room_reply", purpose: "reply",
      sequence: 1, idempotencyKey: key, createdAt: now,
    }).returning() as [ActionRow];
  }
  if (input.yes) return (await approveAction(tx, { id: action.id, approver: input.yes.by, now, silent: true })).action;
  await enqueueActionDispatch(tx, campaign.channelId, now);
  return action;
}

/** The send's one validation, run before the click: the exact comment and
 *  recipient still stand, and an Automatic proposal's step authority and
 *  selected evidence still hold. */
async function validateRoomMessage(tx: Tx, message: Message, automatic: boolean): Promise<void> {
  const target = message.roomReplyTarget;
  if (!target) throw new Error("Room reply target is missing.");
  const source = await readReplySource(tx, target);
  if (source.campaignId !== message.campaignId || source.memberUrn !== target.memberUrn ||
    roomReplyKey(source) !== message.dedupeKey ||
    (source.source === "lead" || target.source === "lead" ? !sameLeadSignal(source, target)
      : source.discoveredPostId !== target.discoveredPostId)) {
    throw new AppError("room_reply_target_changed", "Room reply target changed. Review the exact comment again.", 409);
  }
  if (automatic && message.workerRunId !== null) {
    const [bound] = await tx.select({ event: conversationEvents }).from(stepRuns)
      .innerJoin(conversationEvents, eq(conversationEvents.id, stepRuns.eventId))
      .where(and(eq(stepRuns.campaignId, source.campaignId),
        sql`${stepRuns.drafts} @> ${JSON.stringify([{ kind: "room_reply", messageId: message.id }])}::jsonb`));
    const current = bound ? await currentRoomWork(tx, bound.event, source.campaignId, await currentGeneration(tx),
      Date.now(), { sendingMessageId: message.id }) : null;
    if (!current || current.kind === "held" || current.opportunity.mode !== "auto") {
      throw new AppError("room_step_send_held", "Review this room reply: its step authority or selected evidence changed.", 409);
    }
  }
}

export function roomReplyOperation(driver: ActionSurface, context: OperationContext): ActionOperation {
  const exactlyOnce = () => isExactlyOnce(CONNECTOR_DECLARATIONS[context.connector ?? "mock"].room_reply);
  const inputOf = (row: ActionRow) => withOrg(context.organizationId, async (tx) => {
    const [message] = await tx.select().from(messages).where(eq(messages.id, row.messageId!));
    return message ? roomReplyInput(message, row.channelId) : null;
  });
  return {
    async preflight(row) {
      return withOrg(context.organizationId, async (tx): Promise<Preflight> => {
        const due = await dueMessage(tx, row, context.now());
        if ("preflight" in due) return due.preflight;
        const { message } = due;
        try {
          await validateRoomMessage(tx, message, row.status === "reserved");
        } catch (error) {
          if (error instanceof AppError && (error.code.startsWith("room_") || error.code.startsWith("lead_"))) {
            return blockedBefore(error.code, { message: error.message });
          }
          throw error;
        }
        return { proceed: true };
      });
    },
    async perform(row) {
      const input = await inputOf(row);
      if (!input) return { status: "definitely_not_sent", evidence: { reason: "message_gone" } };
      if (!driver.postWithReceipt || !driver.reconcilePosted) {
        return { status: "definitely_not_sent", evidence: { reason: "room_reply_unavailable" } };
      }
      return performSend({
        kind: "room_reply", use: driver as CapabilitySurface<"room_reply">, input, connector: context.connector ?? null,
      }, "Room reply");
    },
    async reconcile(row) {
      if (!driver.reconcilePosted || !exactlyOnce()) return null;
      const input = await inputOf(row);
      if (!input) return null;
      const session = await driver.ensureSession();
      if (!session.ok) return null;
      const existing = await driver.reconcilePosted(input);
      return existing ? { status: "confirmed", evidence: { externalUrn: existing, reconciled: true } } : null;
    },
  };
}

/** The gate wrote the row `dispatching`: the reply it sends is `posting`. False
 *  when the message was moved out from under the click. */
export async function markRoomReplyPosting(tx: Tx, row: ActionRow, now: number): Promise<boolean> {
  const moved = await tx.update(messages)
    .set({ status: "posting", postingStartedAt: now, lastAttemptAt: now })
    .where(and(eq(messages.id, row.messageId!), eq(messages.status, "approved")))
    .returning({ id: messages.id });
  return moved.length > 0;
}

/** What a settled room reply does to its message, in the transaction that
 *  settles it, whoever settled it: the gate, a reconciliation read, the owner. */
export function settleRoomReply(tx: Tx, row: ActionRow, receipt: ActionReceipt, now: number): Promise<void> {
  return settleMessageSend(tx, row, receipt, now, settlePosted);
}

async function settlePosted(
  tx: Tx,
  row: ActionRow,
  message: Message,
  urn: string,
  settledBy: "gate" | "reconcile" | "owner",
  now: number,
): Promise<void> {
  const owner = settledBy === "owner";
  await tx.update(messages).set({
    status: "posted", postingStartedAt: null, externalUrn: urn, postedAt: now, error: null,
    ...(owner ? { redraftRequestVersion: message.redraftRequestVersion + 1 } : {}),
  }).where(eq(messages.id, message.id));
  await countSend(tx, row, message, now, { settledBy, postAge: null, targetMemberUrn: message.roomReplyTarget?.memberUrn });
  const postUrn = message.roomReplyTarget?.postUrn;
  if (postUrn) {
    await tx.insert(commentWatches).values({
      messageId: message.id, campaignId: message.campaignId, postUrn, commentUrn: urn,
      nextCheckAt: now + jitteredIntervalMs(watchCheckBaseMs(0, await replyCheckBaseMin(tx))),
      expiresAt: now + config.watchTtlMs,
    }).onConflictDoNothing();
  }
  // The account's first confirmed room reply verifies the capability; the
  // owner's word on an uncertain one never does.
  if (settledBy !== "owner") {
    await recordRoomReplyFirstSend(tx, { ...message, status: "posted", externalUrn: urn }, { channelId: row.channelId, externalUrn: urn, by: settledBy, now });
  }
  // The first send that reaches a Find leads person makes them Contacted. In a
  // savepoint: the reply is on LinkedIn already.
  await followLifecycle(tx, "markContacted", async (savepoint) => {
    const reached = await reachedProfile(savepoint, message);
    if (reached) await markContacted(savepoint, { profileId: reached, send: { kind: "message", id: message.id }, at: now });
  });
}

/** The owner's answer on an uncertain room reply, handed to the sidecar's
 *  journal (`closeMessageJournal`). */
export function closeRoomReplyJournal(
  driver: ActionSurface,
  organizationId: string,
  connector: OperationContext["connector"],
  row: ActionRow,
  answer: { observed: "went_out" | "not_sent"; target?: string },
) {
  return closeMessageJournal(driver, organizationId, connector, row, async (_tx, message) => roomReplyInput(message, row.channelId), answer);
}
