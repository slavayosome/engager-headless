import { desc, eq } from "drizzle-orm";
import { AppError } from "@engager/common/errors";
import {
  actionApprovals,
  actions,
  campaigns,
  commentWatches,
  discoveredPosts,
  messages,
  type ActionCandidate,
  type ActionRow,
  type ActionTarget,
  type Campaign,
  type DiscoveredPost,
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
import { jitteredIntervalMs, watchCheckBaseMs } from "../pacing";
import { attemptMarker, recoveryInput } from "../postingRecovery";
import { replyCheckBaseMin } from "../ratelimit/ledger";
import { hasBlockingSendHistory } from "../rooms/importedHistory";
import { modeFor } from "../strategy/mode";
import { approveAction, invalidateApproval, liveApproval } from "./approval";
import { enqueueActionDispatch } from "./drain";
import { commentActionKey, contentHash, targetHash } from "./keys";
import { candidateRefusal } from "./ledger";
import { reserveSendLike, wakeSendLike } from "./likeTarget";
import { blockedBefore, closeMessageJournal, countSend, dueMessage, performSend, settleMessageSend, type PostingRefusal } from "./messageSend";
import { currentGeneration } from "./pause";

/**
 * COMMENT AS AN ACTION — a comment on a post goes out through the action ledger
 * like every other write (`actions/messageSend.ts` says how the message and its
 * action move together; `actions/reply.ts` is the same shape under a comment).
 *
 * Whatever makes a comment `approved` puts it on the ledger in the same
 * transaction (`sendApprovedComment` for the owner's yes, their own words or a
 * retry; `queueComment` for what an intake saved, a step at Automatic included):
 * the yes is the approval created there, bound to that decision and its expiry,
 * and a comment nobody said yes to is an Automatic reservation the gate holds
 * to the mode. A
 * worker's comment needs its Comment above Off and is capped, windowed and
 * slotted by the day plan; the owner's words need no mode and are only spaced
 * (INV-1).
 */

const targetOf = (post: DiscoveredPost): ActionTarget => ({
  kind: "post",
  id: post.postUrn,
  urn: post.postUrn,
  postUrn: post.postUrn,
  ...(post.authorProfileId ? { authorProfileId: post.authorProfileId } : {}),
});

const postOf = async (tx: Tx, message: Message): Promise<DiscoveredPost | undefined> =>
  message.discoveredPostId === null ? undefined : (await tx.select().from(discoveredPosts).where(eq(discoveredPosts.id, message.discoveredPostId)))[0];

/**
 * Queue the send of an approved comment. `yes` is the owner's, given with the
 * decision that approved it; without it the action is an Automatic
 * reservation. Re-queuing the same comment — after an edit, an unschedule, a
 * send that was refused — takes up its row again, and the yes of an earlier
 * life of the row never comes with it: a withdrawal invalidated it. The one
 * exception is `carry`, a retry of a send that definitely did not go out, which
 * keeps the yes that was given, unexpired, with its own expiry. A row that is
 * going out, or went, is left as it is, and so is one already queued on the
 * same words and the same yes: those answer null.
 */
export async function sendComment(
  tx: Tx,
  input: { message: Message; campaign: Campaign; yes: { by: string } | null; carry?: boolean; now?: number },
): Promise<ActionRow | null> {
  const { message, campaign } = input;
  const now = input.now ?? Date.now();
  if (campaign.channelId === null) throw new AppError("comment_campaign_unavailable", "This campaign has no account to send from.", 409);
  const post = await postOf(tx, message);
  if (!post) throw new AppError("comment_target_gone", "The post this answers is gone.", 409);
  const origin = message.publishOrigin;
  const key = commentActionKey(campaign.channelId, message.dedupeKey);
  // The message first, then its action: the order the trigger that cancels a
  // withdrawn comment's action takes (`lockMessageOf`).
  await tx.select({ id: messages.id }).from(messages).where(eq(messages.id, message.id)).for("update");
  const [existing] = await tx.select().from(actions).where(eq(actions.idempotencyKey, key)).for("update");
  if (existing && ["dispatching", "uncertain", "confirmed"].includes(existing.status)) return null;
  const text = message.finalText ?? message.proposedText;
  const hash = contentHash("comment", text);
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
    throw new AppError("comment_stopped", refused === "excluded" ? "This person is excluded." : "Sending is stopped. Your saved words are still here.", 409);
  }
  // The owner's words are only spaced, never held to a mode.
  const mode = origin === "owner" ? null : await modeFor(tx, { campaignId: campaign.id, capability: "publish_comment", target: "post" });
  if (mode && mode.effective !== "review" && mode.effective !== "auto") {
    throw new AppError("comment_mode_off", "Comment is Off for this campaign.", 409);
  }
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
    target: targetOf(post),
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
      ...fields, channelId: campaign.channelId, conversationId: null, kind: "comment", purpose: "opener",
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
  if (message?.kind !== "comment" || message.status !== "approved" || !campaign) throw new AppError("comment_unavailable", "This comment is no longer waiting to go out.", 409);
  return { message, campaign };
};

/** The owner's yes, their own words or a retry has just approved this comment:
 *  put it on the ledger in the same transaction. A refusal — a Stop, an
 *  excluded person, a mode that is Off now — throws, and their decision with
 *  it. */
export async function sendApprovedComment(
  tx: Tx,
  messageId: number,
  how: { yes: { by: string } | null; carry?: boolean },
): Promise<void> {
  await sendComment(tx, { ...(await messageAndCampaign(tx, messageId)), ...how });
}

/** A comment has just been approved by what wrote it — the owner's save (`yes`)
 *  or a step at Automatic (none) — in a batch no refusal may sink: one that
 *  cannot be queued goes back to `proposed` with its reason, for the owner.
 *  False for that one. */
export async function queueComment(tx: Tx, messageId: number, yes: { by: string } | null = null): Promise<boolean> {
  const queued = await messageAndCampaign(tx, messageId);
  try {
    await tx.transaction((savepoint) => sendComment(savepoint, { ...queued, yes }));
    return true;
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    await tx.update(messages).set({ status: "proposed", error: error.code, scheduledAt: null }).where(eq(messages.id, messageId));
    return false;
  }
}

export function commentOperation(driver: ActionSurface, context: OperationContext): ActionOperation {
  const exactlyOnce = () => isExactlyOnce(CONNECTOR_DECLARATIONS[context.connector ?? "mock"].comment);
  const inputOf = (row: ActionRow) => withOrg(context.organizationId, async (tx) => {
    const [message] = await tx.select().from(messages).where(eq(messages.id, row.messageId!));
    const input = message ? await recoveryInput(tx, message).catch(() => null) : null;
    return input?.kind === "comment" ? input : null;
  });
  return {
    async preflight(row) {
      return withOrg(context.organizationId, async (tx): Promise<Preflight> => {
        const due = await dueMessage(tx, row, context.now());
        if ("preflight" in due) return due.preflight;
        const { message } = due;
        if (contentHash("comment", message.finalText ?? message.proposedText) !== row.contentHash) {
          return blockedBefore("superseded:text");
        }
        const post = await postOf(tx, message);
        if (!post) return blockedBefore("target_missing");
        // Imported exposure stays terminal even if an older app draft is
        // restored later: a free-workspace log has no provider receipt with
        // which this install could safely reconcile another attempt.
        if (hasBlockingSendHistory(post.media)) return blockedBefore("free_workspace_history");
        return { proceed: true };
      });
    },
    async perform(row) {
      const input = await inputOf(row);
      if (!input) return { status: "definitely_not_sent", evidence: { reason: "target_missing" } };
      if (!driver.postWithReceipt || !driver.reconcilePosted) {
        return { status: "definitely_not_sent", evidence: { reason: "comment_unavailable" } };
      }
      return performSend({ kind: "comment", use: driver as CapabilitySurface<"comment">, input, connector: context.connector ?? null }, "Comment");
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

/** The gate wrote the row `dispatching`: the comment it sends is `posting`,
 *  under the marker the journal keeps the attempt by, and the like that rides
 *  with it is reserved in the same claim — a crash or a recovery that settles
 *  the message later still finds it, and the gate holds it until then. */
export async function markCommentPosting(tx: Tx, row: ActionRow, now: number): Promise<PostingRefusal | null> {
  const [message] = await tx.select().from(messages).where(eq(messages.id, row.messageId!)).for("update");
  if (!message || message.status !== "approved") return { kind: "cancel", reason: "message_moved" };
  // Words edited since the row was queued: the yes was to other words.
  if (contentHash("comment", message.finalText ?? message.proposedText) !== row.contentHash) return { kind: "block", reason: "superseded:text" };
  const post = await postOf(tx, message);
  if (!post) return { kind: "block", reason: "target_missing" };
  await tx.update(messages)
    .set({ status: "posting", postingStartedAt: now, lastAttemptAt: now, writeMarker: attemptMarker(message.dedupeKey, message.redraftRequestVersion) })
    .where(eq(messages.id, message.id));
  const [campaign] = message.campaignId === null ? [] : await tx.select().from(campaigns).where(eq(campaigns.id, message.campaignId));
  // A savepoint: the like is best-effort, the claim it rides with is not.
  if (campaign) {
    await tx.transaction((sub) => reserveSendLike(sub, { campaign, message, aim: { postUrn: post.postUrn } })).catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.error(`[comment] like was not reserved for message ${message.id}:`, error instanceof Error ? error.message : error);
    });
  }
  return null;
}

/** What a settled comment does to its message, in the transaction that settles
 *  it, whoever settled it: the gate, a reconciliation read, the owner. */
export function settleComment(tx: Tx, row: ActionRow, receipt: ActionReceipt, now: number): Promise<void> {
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
  const post = await postOf(tx, message);
  await countSend(tx, row, message, now, { settledBy, postAge: post?.postedAt == null ? null : now - post.postedAt });
  if (post) await tx.update(discoveredPosts).set({ status: "commented" }).where(eq(discoveredPosts.id, post.id));
  await tx.insert(commentWatches).values({
    messageId: message.id, campaignId: message.campaignId, postUrn: row.target.id, commentUrn: urn,
    nextCheckAt: now + jitteredIntervalMs(watchCheckBaseMs(0, await replyCheckBaseMin(tx))),
    expiresAt: now + config.watchTtlMs,
  }).onConflictDoNothing();
  // The like that rides this send was waiting for it to be posted — however it
  // settled: the send, a reconcile or the owner's word.
  await wakeSendLike(tx, message.id);
  // The first send that reaches a Find leads person makes them Contacted. In a
  // savepoint: the comment is on LinkedIn already.
  await followLifecycle(tx, "markContacted", async (savepoint) => {
    const reached = await reachedProfile(savepoint, message);
    if (reached) await markContacted(savepoint, { profileId: reached, send: { kind: "message", id: message.id }, at: now });
  });
}

/** The owner's answer on an uncertain comment, handed to the sidecar's journal
 *  (`closeMessageJournal`). */
export function closeCommentJournal(
  driver: ActionSurface,
  organizationId: string,
  connector: OperationContext["connector"],
  row: ActionRow,
  answer: { observed: "went_out" | "not_sent"; target?: string },
) {
  return closeMessageJournal(driver, organizationId, connector, row, recoveryInput, answer);
}
