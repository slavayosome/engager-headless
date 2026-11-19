import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  actions,
  conversationEvents,
  conversations,
  type ConversationRow,
} from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { ActionLedgerError } from "../actions/errors";
import { cancelQueued, lockPauses } from "../actions/pause";
import { projectLeadStatus } from "./leads";
import { conversationPolicy } from "./policy";

const DAY = 86_400_000;

/**
 * START A PERSON OVER — the owner's explicit reopening (spec §10 "an
 * explicitly permitted future reopening", R07 "a user must explicitly reopen
 * a closed or excluded recipient"; INV-27).
 *
 * Every person-purpose guard is keyed on the conversation: an invitation's opener
 * is `account + person + conversation + opener + 1`, and the log's
 * `invitation_confirmed` forbids a second one on it. So a reopening never
 * adds a second key under the same conversation: it closes the conversation
 * (`reopened`, unless it was already closed — an opt-out keeps its own
 * reason) and opens a new one for the same person on the same account, owned
 * by the same campaign, starting from nothing — no relationship until a read
 * shows one, no interest until the person says so again. Both conversations carry
 * a `person_reopened` event naming the other.
 *
 * What it does not do: lift an exclusion — the do-not-engage list is the
 * Channel's blocklist, and every send still refuses there — or settle a send
 * nobody knows the outcome of. A conversation with an action past the click and
 * unsettled is refused (INV-10): the new conversation's first invitation would be
 * the second one. Queued actions on the old conversation are cancelled with their
 * approvals; nothing is replayed onto the new one.
 */
export async function reopenPerson(
  tx: Tx,
  input: { conversationId: number; by: string; now?: number },
): Promise<{ closed: ConversationRow; opened: ConversationRow }> {
  const now = input.now ?? Date.now();
  // The pause lock before the conversation's, in the order the gate takes them.
  await lockPauses(tx);
  const [conversation] = await tx
    .select()
    .from(conversations)
    .where(eq(conversations.id, input.conversationId))
    .for("update");
  if (!conversation) {
    throw new ActionLedgerError(
      "conversation_not_found",
      `Conversation ${input.conversationId} not found in this organization.`,
      "Read the ids with list_activity or get_person.",
    );
  }
  const [newest] = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(eq(conversations.channelId, conversation.channelId), eq(conversations.authorProfileId, conversation.authorProfileId)),
    )
    .orderBy(desc(conversations.id))
    .limit(1);
  if (newest && newest.id !== conversation.id) {
    throw new ActionLedgerError(
      "conversation_reopened",
      `Conversation ${conversation.id} was already started over as ${newest.id}.`,
      `Reopen ${newest.id}, the person's newest, if they should start over again.`,
    );
  }
  const [unsettled] = await tx
    .select({ id: actions.id, status: actions.status })
    .from(actions)
    .where(
      and(
        eq(actions.conversationId, conversation.id),
        inArray(actions.status, ["dispatching", "uncertain"]),
      ),
    )
    .limit(1);
  if (unsettled) {
    throw new ActionLedgerError(
      "conversation_unsettled",
      `Action ${unsettled.id} on conversation ${conversation.id} is ${unsettled.status}: nobody knows yet whether it reached them.`,
      "Settle it first: look on LinkedIn and say which it was on the person in Inbox, or on the LinkedIn channel's Overview when it holds sending. Then start the person over.",
    );
  }

  await cancelQueued(tx, { scope: "conversation", scopeId: conversation.id }, `reopened:${input.by}`, now);
  const [closed] =
    conversation.closedReason === null
      ? await tx
          .update(conversations)
          .set({
            closedReason: "reopened",
            closedAt: now,
            derivedStage: "closed",
            updatedAt: now,
          })
          .where(eq(conversations.id, conversation.id))
          .returning()
      : [conversation];
  const [opened] = await tx
    .insert(conversations)
    .values({
      channelId: conversation.channelId,
      authorProfileId: conversation.authorProfileId,
      owningCampaignId: conversation.owningCampaignId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  const policy = await conversationPolicy(tx, conversation.owningCampaignId);
  const reopening = (on: ConversationRow, other: ConversationRow) => ({
    conversationId: on.id,
    type: "person_reopened" as const,
    source: "owner" as const,
    sourceRef: { conversationId: other.id },
    digest: createHash("sha256")
      .update(JSON.stringify(["person_reopened", conversation.id, opened!.id]), "utf8")
      .digest("hex"),
    occurredAt: now,
    observedAt: now,
    attribution: { method: "owner" as const, profileId: conversation.authorProfileId },
    decision: { by: input.by },
    retentionClass: "audit" as const,
    expiresAt: now + policy.retention.audit_days * DAY,
    createdAt: now,
  });
  await tx.insert(conversationEvents).values([reopening(closed!, opened!), reopening(opened!, closed!)]);
  await projectLeadStatus(tx, conversation.authorProfileId, now);
  return { closed: closed!, opened: opened! };
}
