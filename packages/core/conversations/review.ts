import { and, desc, eq, gte, sql } from "drizzle-orm";
import { conversationEvents, type ConversationRow } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import type { ReasonCode } from "./eligibility";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** The most reads of one person that could not tell Engager makes in a day
 *  before it stops asking until the oldest of them is a day old. */
export const UNREAD_READS_PER_DAY = 4;

/**
 * The reasons of the decision that sent a conversation to review, while it waits
 * there: the last event whose decision set the operational status, when that
 * was `awaiting_review`. Empty while the conversation is not waiting, or when the
 * event that sent it there kept no reasons.
 */
export async function openReviewReasons(
  tx: Tx,
  conversation: Pick<ConversationRow, "id" | "opsStatus">,
): Promise<ReasonCode[]> {
  if (conversation.opsStatus !== "awaiting_review") return [];
  const [event] = await tx
    .select({ decision: conversationEvents.decision })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, conversation.id),
        sql`${conversationEvents.decision} -> 'effects' ->> 'opsStatus' is not null`,
      ),
    )
    .orderBy(desc(conversationEvents.occurredAt), desc(conversationEvents.id))
    .limit(1);
  const decision = event?.decision as { effects?: { opsStatus?: string }; reasons?: unknown } | null | undefined;
  return decision?.effects?.opsStatus === "awaiting_review" && Array.isArray(decision.reasons)
    ? (decision.reasons as ReasonCode[])
    : [];
}

/**
 * When the person of a conversation may be read again after reads that could not
 * tell: an hour after the first, twice as long after each next, and never
 * more than `UNREAD_READS_PER_DAY` in a rolling day. `now` when none stands in
 * the last day. A read is the profile page loaded in the account's own
 * session, so the pace is the account's to spare.
 */
export async function nextUnreadRead(tx: Tx, conversationId: number, now: number): Promise<number> {
  const reads = await tx
    .select({ at: conversationEvents.occurredAt })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, conversationId),
        eq(conversationEvents.type, "relationship_observed"),
        sql`${conversationEvents.decision} ->> 'relationship' = 'unknown'`,
        gte(conversationEvents.occurredAt, now - DAY),
      ),
    )
    .orderBy(desc(conversationEvents.occurredAt))
    .limit(UNREAD_READS_PER_DAY);
  const [newest] = reads;
  if (!newest) return now;
  return reads.length >= UNREAD_READS_PER_DAY
    ? reads[UNREAD_READS_PER_DAY - 1]!.at + DAY
    : newest.at + HOUR * 2 ** (reads.length - 1);
}
