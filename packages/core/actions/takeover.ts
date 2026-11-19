import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  conversationSources,
  conversations,
  messages,
  pauseControls,
  type ConversationRow,
  type PauseControlRow,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { enqueueActionDispatch } from "./drain";
import { ActionLedgerError } from "./errors";
import { stopScope } from "./pause";

/**
 * HUMAN TAKEOVER (spec §01 R02, §16 "human types or sends"; INV-29).
 *
 * The owner takes a conversation into their own hands: a pause on it with
 * reason `takeover`, the conversation `human_owned` — a sticky state no observed
 * event moves (`conversations/eligibility.ts`) — and every unsent draft the
 * workers made for it cancelled: its queued actions, and the replies a worker
 * drafted on `messages` that have not gone out. A conversation the owner holds is
 * never selected by a wake and never takes a reservation, which is the §16
 * fixture "a human draft overwritten by another worker" made impossible.
 *
 * Releasing it is the explicit Resume: the takeover pause closes and the
 * conversation is runnable again. Nothing is replayed — the next wake reads the
 * thread as it stands, which is the fresh preflight, and whatever the owner
 * wrote meanwhile is already in it.
 */

/** A worker's draft on `messages` that has not left: the owner's own are
 *  theirs to keep. */
const UNSENT_WORKER: Array<"proposed" | "approved"> = ["proposed", "approved"];

async function lockConversation(tx: Tx, conversationId: number): Promise<ConversationRow> {
  const [conversation] = await tx
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .for("update");
  if (!conversation) {
    throw new ActionLedgerError(
      "conversation_not_found",
      `Conversation ${conversationId} not found in this organization.`,
      "A conversation is a conversation: its id is on an action (`conversationId`) or on the activity list returns.",
    );
  }
  return conversation;
}

export type TakeoverOutcome = {
  pause: PauseControlRow;
  /** Queued actions on the conversation cancelled. */
  cancelledActions: number;
  /** A worker's unsent replies on its threads cancelled. */
  cancelledDrafts: number;
};

export async function takeOverConversation(
  tx: Tx,
  input: { conversationId: number; by: string; now?: number },
): Promise<TakeoverOutcome> {
  const now = input.now ?? Date.now();
  const conversation = await lockConversation(tx, input.conversationId);
  if (conversation.closedReason !== null) {
    throw new ActionLedgerError(
      "conversation_closed",
      `Conversation ${conversation.id} is closed (${conversation.closedReason}); nothing runs on it to take over.`,
      "A closed conversation stays closed; nothing will act on it.",
    );
  }
  const stop = await stopScope(tx, {
    scope: "conversation",
    scopeId: conversation.id,
    reason: "takeover",
    by: input.by,
    now,
  });
  await tx
    .update(conversations)
    .set({ opsStatus: "human_owned", opsStatusAt: now, updatedAt: now })
    .where(eq(conversations.id, conversation.id));
  const sources = tx
    .select({ id: conversationSources.incomingCommentId })
    .from(conversationSources)
    .where(eq(conversationSources.conversationId, conversation.id));
  const drafts = await tx
    .update(messages)
    .set({ status: "rejected", error: "the owner took the conversation over" })
    .where(
      and(
        inArray(messages.incomingCommentId, sources),
        eq(messages.publishOrigin, "worker"),
        inArray(messages.status, UNSENT_WORKER),
      ),
    )
    .returning({ id: messages.id });
  return { pause: stop.pause, cancelledActions: stop.cancelled, cancelledDrafts: drafts.length };
}

/** The owner hands the conversation back: the takeover pause closes and the
 *  conversation is runnable again. Releasing one never taken over is refused. */
export async function releaseConversation(
  tx: Tx,
  input: { conversationId: number; by: string; now?: number },
): Promise<{ conversation: ConversationRow; released: PauseControlRow }> {
  const now = input.now ?? Date.now();
  const conversation = await lockConversation(tx, input.conversationId);
  const [released] = await tx
    .update(pauseControls)
    .set({ resumedAt: now, resumedBy: input.by })
    .where(
      and(
        eq(pauseControls.scope, "conversation"),
        eq(pauseControls.scopeId, conversation.id),
        eq(pauseControls.reason, "takeover"),
        isNull(pauseControls.resumedAt),
      ),
    )
    .returning();
  if (!released) {
    throw new ActionLedgerError(
      "conversation_not_taken_over",
      `Conversation ${conversation.id} is not taken over.`,
      "Nothing to release. A Stop on it is resumed with stop.",
    );
  }
  const [after] = await tx
    .update(conversations)
    .set({
      // Only the takeover's own hold lifts here; a conversation something else has
      // since blocked or left uncertain keeps that answer.
      opsStatus: conversation.opsStatus === "human_owned" ? "runnable" : conversation.opsStatus,
      opsStatusAt: now,
      updatedAt: now,
    })
    .where(eq(conversations.id, conversation.id))
    .returning();
  return { conversation: after!, released };
}

/**
 * The owner answers a review for the workers: a conversation that waits on
 * them (`awaiting_review`) is runnable again, and the account's dispatch is
 * pulled forward so what was held for it goes on the next tick. Nothing is
 * sent here — the gate still holds each action to the caps, the pacing and
 * the kill switch, and an invitation still reads the person first. Refused
 * unless the conversation is waiting on the owner now: another status is
 * someone else's to lift, and a closed one stays closed.
 */
export async function resolveConversationReview(
  tx: Tx,
  input: { conversationId: number; now?: number },
): Promise<ConversationRow> {
  const now = input.now ?? Date.now();
  const conversation = await lockConversation(tx, input.conversationId);
  if (conversation.closedReason !== null) {
    throw new ActionLedgerError(
      "conversation_closed",
      `Conversation ${conversation.id} is closed (${conversation.closedReason}); nothing runs on it.`,
      "A closed conversation stays closed; nothing will act on it.",
    );
  }
  if (conversation.opsStatus !== "awaiting_review") {
    throw new ActionLedgerError(
      "conversation_not_awaiting_review",
      `Conversation ${conversation.id} is ${conversation.opsStatus}, not waiting on a review.`,
      "Only a conversation held for the owner's review is answered this way; read it again for where it stands.",
    );
  }
  const [after] = await tx
    .update(conversations)
    .set({ opsStatus: "runnable", opsStatusAt: now, updatedAt: now })
    .where(eq(conversations.id, conversation.id))
    .returning();
  await enqueueActionDispatch(tx, conversation.channelId, now);
  return after!;
}
