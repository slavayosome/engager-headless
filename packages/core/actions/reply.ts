import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import {
  actionApprovals,
  actions,
  campaigns,
  commentWatches,
  incomingComments,
  messages,
  type ActionCandidate,
  type ActionRow,
  type ActionTarget,
  type Campaign,
  type IncomingComment,
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
import { followLifecycle, markContacted, reachedProfile } from "../leads/lifecycle";
import { getOwnPostRepliesScoped } from "../operations/orgSettings";
import { jitteredIntervalMs, watchCheckBaseMs } from "../pacing";
import { attemptMarker, recoveryInput } from "../postingRecovery";
import { replyCheckBaseMin } from "../ratelimit/ledger";
import { observesRoomReplies, roomContinuationRefusal } from "../rooms/continuation";
import { isRoomThreadReply, roomThreadReceipt } from "../rooms/thread";
import { modeFor } from "../strategy/mode";
import { approveAction, invalidateApproval, liveApproval } from "./approval";
import { enqueueActionDispatch } from "./drain";
import { contentHash, replyActionKey, targetHash } from "./keys";
import { candidateRefusal } from "./ledger";
import { reserveSendLike, wakeSendLike } from "./likeTarget";
import { blockedBefore, closeMessageJournal, countSend, dueMessage, performSend, settleMessageSend, type PostingRefusal } from "./messageSend";
import { currentGeneration } from "./pause";

/**
 * PUBLIC REPLY AS AN ACTION — a reply to someone who answered the owner, under
 * their comment or on their own post, goes out through the action ledger like
 * every other write (`actions/messageSend.ts` says how the message and its
 * action move together; `actions/roomReply.ts` is the same shape under a room
 * member's comment).
 *
 * Whatever makes a reply `approved` puts it on the ledger in the same
 * transaction (`sendApprovedReply` for the owner's yes, their own words or a
 * retry; `queueAutomaticReply` for a step at Automatic): the yes is the
 * approval created there, bound to that decision and its expiry, and a reply
 * nobody said yes to is an Automatic reservation the gate holds to the mode. A
 * worker's reply needs its Reply above Off, the owner's words need nothing
 * (INV-1), and a reply to someone who engaged first is exempt from the
 * per-person caps unless it continues a room exchange.
 */

/** Whether the per-person caps spare this action: a reply to a person already
 *  in conversation with the account, outside a room. Undefined for every
 *  other kind, which the gate leaves to `canEngage`'s own default. */
export const repliesResponsively = (row: Pick<ActionRow, "kind" | "target">): boolean | undefined =>
  row.kind === "reply" ? row.target.roomReplyUrn === undefined : undefined;

/** What a reply answers, and the confirmed room reply it continues under if it
 *  is one. */
const targetOf = (incoming: IncomingComment, roomReplyUrn: string | null): ActionTarget => ({
  kind: "their_reply",
  id: incoming.commentUrn,
  urn: incoming.commentUrn,
  postUrn: incoming.ownPostUrn,
  ...(incoming.authorProfileId ? { authorProfileId: incoming.authorProfileId } : {}),
  textHash: incoming.textHash,
  ...(incoming.source === "our_comment_thread" ? {} : { ownPost: true }),
  ...(roomReplyUrn ? { roomReplyUrn } : {}),
});

/**
 * Queue the send of an approved reply. `yes` is the owner's, given with the
 * decision that approved it; without it the action is an Automatic
 * reservation. Re-queuing the same reply — after an edit, an unschedule, a send
 * that was refused — takes up its row again, and the yes of an earlier life of
 * the row never comes with it: a withdrawal invalidated it. The one exception
 * is `carry`, a retry of a send that definitely did not go out, which keeps the
 * yes that was given, unexpired, with its own expiry. A row that is going out,
 * or went, is left as it is, and so is one already queued on the same words and
 * the same yes: those answer null.
 */
export async function sendReply(
  tx: Tx,
  input: { message: Message; campaign: Campaign; yes: { by: string } | null; carry?: boolean; now?: number },
): Promise<ActionRow | null> {
  const { message, campaign } = input;
  const now = input.now ?? Date.now();
  if (campaign.channelId === null) throw new AppError("reply_campaign_unavailable", "This campaign has no account to send from.", 409);
  const [incoming] = message.incomingCommentId === null ? [] : await tx.select().from(incomingComments).where(eq(incomingComments.id, message.incomingCommentId));
  if (!incoming) throw new AppError("reply_target_gone", "The comment this answers is gone.", 409);
  const origin = message.publishOrigin;
  const key = replyActionKey(campaign.channelId, message.dedupeKey);
  // The message first, then its action: the order the trigger that cancels a
  // withdrawn reply's action takes (`lockMessageOf`).
  await tx.select({ id: messages.id }).from(messages).where(eq(messages.id, message.id)).for("update");
  const [existing] = await tx.select().from(actions).where(eq(actions.idempotencyKey, key)).for("update");
  if (existing && ["dispatching", "uncertain", "confirmed"].includes(existing.status)) return null;
  const text = message.finalText ?? message.proposedText;
  const hash = contentHash("reply", text);
  const [prior] = existing && input.carry
    ? await tx.select().from(actionApprovals).where(eq(actionApprovals.actionExecutionId, existing.id)).orderBy(desc(actionApprovals.id)).limit(1)
    : [];
  const carried = prior && prior.invalidatedAt === null && prior.expiresAt > now && prior.contentHash === hash ? prior : null;
  if (existing && existing.contentHash === hash && (existing.status === "reserved" || existing.status === "approved") &&
    (existing.status === "approved") === (input.yes !== null || carried !== null)) return null;

  const generationSeen = await currentGeneration(tx);
  const refused = await candidateRefusal(tx, {
    channelId: campaign.channelId, campaignId: campaign.id, conversationId: null,
    authorProfileId: message.targetProfileId, generationSeen, origin,
  });
  if (refused) {
    throw new AppError("reply_stopped", refused === "excluded" ? "This person is excluded." : "Sending is stopped. Your saved words are still here.", 409);
  }
  // The owner's words are only spaced, never held to a mode. On someone else's
  // post the mode is the step's; on the owner's own it is the account's.
  const ownPost = incoming.source !== "our_comment_thread";
  let mode: { effective: string | null; binding: string | null } | null = null;
  if (origin !== "owner" && ownPost) {
    mode = { effective: (await modeFor(tx, { ownPost: await getOwnPostRepliesScoped(tx), campaignId: campaign.id })).effective, binding: "reply" };
  } else if (origin !== "owner") {
    const answer = await modeFor(tx, { campaignId: campaign.id, capability: "reply_public", target: "their_reply" });
    mode = { effective: answer.effective, binding: answer.action_binding_id };
  }
  if (mode && mode.effective !== "review" && mode.effective !== "auto") {
    throw new AppError("reply_mode_off", "Reply is Off for this campaign.", 409);
  }
  const inRoom = !ownPost && await isRoomThreadReply(tx, incoming);
  const roomReplyUrn = inRoom ? await roomThreadReceipt(tx, incoming) : null;
  if (inRoom && !roomReplyUrn) throw new AppError("room_receipt_missing", "The room reply no longer proves this conversation.", 409);
  const candidate: ActionCandidate = {
    text, sources: [],
    ...(message.assistRetention === null ? {} : { assist: { assistRetention: message.assistRetention, ownerOrigin: message.ownerOrigin } }),
    versions: { strategy: null, facts: [], memory: null, voice: null },
  };
  const fields = {
    campaignId: campaign.id,
    messageId: message.id,
    authorProfileId: message.targetProfileId,
    actionBindingId: mode?.binding ?? null,
    target: targetOf(incoming, roomReplyUrn),
    contentHash: hash,
    candidate,
    origin,
    status: carried ? "approved" : input.yes ? "awaiting_review" : "reserved",
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
      ...fields, channelId: campaign.channelId, conversationId: null, kind: "reply", purpose: "reply",
      sequence: 1, idempotencyKey: key, createdAt: now,
    }).returning() as [ActionRow];
  }
  if (carried) {
    await tx.insert(actionApprovals).values({
      actionExecutionId: action.id, approver: carried.approver, contentHash: carried.contentHash, targetHash: targetHash(action.target),
      dependencyVersions: carried.dependencyVersions, expiresAt: carried.expiresAt, createdAt: carried.createdAt,
    });
  } else if (input.yes) {
    return (await approveAction(tx, { id: action.id, approver: input.yes.by, now, silent: true })).action;
  }
  await enqueueActionDispatch(tx, campaign.channelId, now);
  return action;
}

const messageAndCampaign = async (tx: Tx, messageId: number) => {
  const [message] = await tx.select().from(messages).where(eq(messages.id, messageId)).for("update");
  const [campaign] = message?.campaignId == null ? [] : await tx.select().from(campaigns).where(eq(campaigns.id, message.campaignId));
  if (message?.kind !== "reply" || message.status !== "approved" || !campaign) throw new AppError("reply_unavailable", "This reply is no longer waiting to go out.", 409);
  return { message, campaign };
};

/** The owner's yes, their own words or a retry has just approved this reply:
 *  put it on the ledger in the same transaction. A refusal — a Stop, an
 *  excluded person, a mode that is Off now — throws, and their decision with
 *  it. */
export async function sendApprovedReply(
  tx: Tx,
  messageId: number,
  how: { yes: { by: string } | null; carry?: boolean },
): Promise<void> {
  await sendReply(tx, { ...(await messageAndCampaign(tx, messageId)), ...how });
}

/** A step at Automatic has just approved this reply, with nobody's yes: an
 *  Automatic reservation the gate holds to the mode. One that cannot be queued
 *  goes back to `proposed` with its reason, for the owner; so does one to
 *  words held for the owner. */
export async function queueAutomaticReply(tx: Tx, messageId: number): Promise<void> {
  const queued = await messageAndCampaign(tx, messageId);
  // Words a person must see first are never sent unseen, whatever approved the reply.
  const [answered] = queued.message.incomingCommentId === null ? [] : await tx
    .select({ sensitivity: incomingComments.sensitivity })
    .from(incomingComments)
    .where(eq(incomingComments.id, queued.message.incomingCommentId));
  if (answered?.sensitivity === "hold") {
    await tx.update(messages).set({ status: "proposed", error: "sensitive_hold", scheduledAt: null }).where(eq(messages.id, messageId));
    return;
  }
  try {
    await tx.transaction((savepoint) => sendReply(savepoint, { ...queued, yes: null }));
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    await tx.update(messages).set({ status: "proposed", error: error.code, scheduledAt: null }).where(eq(messages.id, messageId));
  }
}

/** Whether our replies already fill the conversation a reply joins — the
 *  anti-ping-pong depth the worker's replies keep to, not the owner's own words —
 *  counted under the conversation's lock: a thread, or one person on our own
 *  post. Without the lock, concurrent approved replies can each read the same
 *  count and both escape to LinkedIn. */
async function depthCapReached(tx: Tx, message: Message, incoming: IncomingComment): Promise<boolean> {
  const conversation = incoming.source === "our_comment_thread"
    ? incoming.threadParentUrn === null ? null : { key: `reply-thread:${incoming.threadParentUrn}`, same: eq(incomingComments.threadParentUrn, incoming.threadParentUrn) }
    : incoming.authorProfileId === null ? null : {
      key: `reply-own:${incoming.ownPostUrn}:${incoming.authorProfileId}`,
      same: and(eq(incomingComments.source, "own_post"), eq(incomingComments.ownPostUrn, incoming.ownPostUrn), eq(incomingComments.authorProfileId, incoming.authorProfileId)),
    };
  // No conversation to key on fails open: the daily caps still bound it.
  if (!conversation) return false;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(current_setting('app.current_org', true)), hashtext(${conversation.key}))`);
  const [occupied] = await tx.select({ n: sql<number>`count(*)::int` }).from(messages)
    .innerJoin(incomingComments, eq(messages.incomingCommentId, incomingComments.id))
    .where(and(eq(messages.kind, "reply"), inArray(messages.status, ["posting", "posted", "needs_review"]), ne(messages.id, message.id), conversation.same));
  return (occupied?.n ?? 0) >= config.threadReplyDepthCap;
}

const ROOM_HOLD_MS = 30 * 60_000;

export function replyOperation(driver: ActionSurface, context: OperationContext): ActionOperation {
  const exactlyOnce = () => isExactlyOnce(CONNECTOR_DECLARATIONS[context.connector ?? "mock"].reply);
  const inputOf = (row: ActionRow) => withOrg(context.organizationId, async (tx) => {
    const [message] = await tx.select().from(messages).where(eq(messages.id, row.messageId!));
    const input = message ? await recoveryInput(tx, message).catch(() => null) : null;
    return input?.kind === "reply" ? input : null;
  });
  return {
    async preflight(row) {
      return withOrg(context.organizationId, async (tx): Promise<Preflight> => {
        const now = context.now();
        const due = await dueMessage(tx, row, now);
        if ("preflight" in due) return due.preflight;
        const { message } = due;
        if (contentHash("reply", message.finalText ?? message.proposedText) !== row.contentHash) {
          return blockedBefore("superseded:text");
        }
        const [incoming] = message.incomingCommentId === null ? [] : await tx.select().from(incomingComments).where(eq(incomingComments.id, message.incomingCommentId));
        if (!incoming) return blockedBefore("target_missing");
        // Their reply let go (`dontReply`, which withdraws ours with it): an
        // answer that still reaches here is withdrawn now, and nothing is sent.
        if (incoming.status === "dismissed") {
          await tx.update(messages).set({ status: "rejected", scheduledAt: null }).where(eq(messages.id, message.id));
          return blockedBefore("message_not_approved", { messageStatus: "rejected", dismissed: true });
        }
        if (message.publishOrigin === "worker" && await depthCapReached(tx, message, incoming)) return blockedBefore("thread_depth_cap");
        if (incoming.source === "our_comment_thread" && await isRoomThreadReply(tx, incoming)) {
          if (await roomThreadReceipt(tx, incoming) !== row.target.roomReplyUrn) return blockedBefore("room_receipt_changed");
          const refused = await roomContinuationRefusal(tx, incoming, message.campaignId!, now, message.publishOrigin === "worker");
          if (refused === "room_scope_off") return { proceed: false, hold: refused, retryAt: now + ROOM_HOLD_MS };
          if (refused === "excluded") return blockedBefore("do_not_engage");
          if (refused?.startsWith("room_")) return blockedBefore(refused);
          if (refused) return { proceed: false, hold: refused, retryAt: now + 60 * 60_000 };
        } else if (row.target.roomReplyUrn !== undefined) {
          return blockedBefore("room_receipt_changed");
        }
        return { proceed: true };
      });
    },
    async perform(row) {
      const input = await inputOf(row);
      if (!input) return { status: "definitely_not_sent", evidence: { reason: "target_missing" } };
      if (!driver.postWithReceipt || !driver.reconcilePosted) {
        return { status: "definitely_not_sent", evidence: { reason: "reply_unavailable" } };
      }
      return performSend({ kind: "reply", use: driver as CapabilitySurface<"reply">, input, connector: context.connector ?? null }, "Reply");
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

/** The gate wrote the row `dispatching`: the reply it sends is `posting`, under
 *  the marker the journal keeps the attempt by, and the like that rides with
 *  it is reserved in the same claim — a crash or a recovery that settles the
 *  message later still finds it, and the gate holds it until then. */
export async function markReplyPosting(tx: Tx, row: ActionRow, now: number): Promise<PostingRefusal | null> {
  const [message] = await tx.select().from(messages).where(eq(messages.id, row.messageId!)).for("update");
  if (!message || message.status !== "approved") return { kind: "cancel", reason: "message_moved" };
  // Words edited since the row was queued: the yes was to other words.
  if (contentHash("reply", message.finalText ?? message.proposedText) !== row.contentHash) return { kind: "block", reason: "superseded:text" };
  const [incoming] = await tx.select().from(incomingComments).where(eq(incomingComments.id, message.incomingCommentId!));
  if (!incoming) return { kind: "block", reason: "target_missing" };
  if (message.publishOrigin === "worker" && await depthCapReached(tx, message, incoming)) return { kind: "block", reason: "thread_depth_cap" };
  const [marked] = await tx.update(messages)
    .set({ status: "posting", postingStartedAt: now, lastAttemptAt: now, writeMarker: attemptMarker(message.dedupeKey, message.redraftRequestVersion) })
    .where(and(eq(messages.id, message.id), eq(messages.status, "approved")))
    .returning({ likeWithSend: messages.likeWithSend });
  if (!marked) return { kind: "cancel", reason: "message_moved" };
  const [campaign] = message.campaignId === null ? [] : await tx.select().from(campaigns).where(eq(campaigns.id, message.campaignId));
  if (campaign) {
    const aim = { postUrn: incoming.ownPostUrn, commentId: incoming.source === "our_comment_thread" ? incoming.threadParentUrn ?? incoming.commentUrn : incoming.commentUrn, replyToUrn: incoming.commentUrn };
    // A savepoint: the like is best-effort, the claim it rides with is not.
    await tx.transaction((sub) => reserveSendLike(sub, { campaign, message: { ...message, likeWithSend: marked.likeWithSend }, aim })).catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.error(`[reply] like was not reserved for message ${message.id}:`, error instanceof Error ? error.message : error);
    });
  }
  return null;
}

/** What a settled reply does to its message, in the transaction that settles
 *  it, whoever settled it: the gate, a reconciliation read, the owner. */
export function settleReply(tx: Tx, row: ActionRow, receipt: ActionReceipt, now: number): Promise<void> {
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
  await countSend(tx, row, message, now, { settledBy, postAge: null });
  if (message.incomingCommentId !== null) {
    await tx.update(incomingComments).set({ status: "replied" }).where(eq(incomingComments.id, message.incomingCommentId));
  }
  const postUrn = row.target.postUrn;
  if (postUrn) {
    await tx.insert(commentWatches).values({
      messageId: message.id, campaignId: message.campaignId, postUrn, commentUrn: urn,
      nextCheckAt: now + jitteredIntervalMs(watchCheckBaseMs(0, await replyCheckBaseMin(tx))),
      expiresAt: now + config.watchTtlMs,
    }).onConflictDoNothing();
  }
  // The like that rides this send was waiting for it to be posted — however it
  // settled: the send, a reconcile or the owner's word.
  await wakeSendLike(tx, message.id);
  // The first send that reaches a Find leads person makes them Contacted. In a
  // savepoint: the reply is on LinkedIn already.
  await followLifecycle(tx, "markContacted", async (savepoint) => {
    const reached = await reachedProfile(savepoint, message);
    if (reached) await markContacted(savepoint, { profileId: reached, send: { kind: "message", id: message.id }, at: now });
  });
}

/** The owner's answer on an uncertain reply, handed to the sidecar's journal
 *  (`closeMessageJournal`). */
export function closeReplyJournal(
  driver: ActionSurface,
  organizationId: string,
  connector: OperationContext["connector"],
  row: ActionRow,
  answer: { observed: "went_out" | "not_sent"; target?: string },
) {
  return closeMessageJournal(driver, organizationId, connector, row, recoveryInput, answer);
}
