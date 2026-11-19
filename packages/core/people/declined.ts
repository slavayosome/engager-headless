import { inArray, sql } from "drizzle-orm";
import { conversationEvents, conversations } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { authorIdentity } from "./key";

/**
 * WHO SAID NO, AND WHEN — the people whose newest word on the owner's offer
 * is a no: a message of theirs read as negative ("no thank you", "not for
 * us") that refused nothing further, with nothing after it that asks about
 * the product or shows interest in it. A thumbs-up after a no is still a no;
 * a question about the product after it is not.
 *
 * It is not an opt-out, which closes the conversation and is its own state
 * (`standing.ts`): someone who declined can still be written to, and the
 * owner often does. It is read from the stored reading of each message
 * (`ai/reading.ts`: `stance` negative is "saying they are not interested"),
 * so it says what Engager already read and judges nothing new. Messages
 * only: a negative comment under a post is a disagreement, not an answer to
 * an offer.
 *
 * By `authorIdentity`, the moment they said it. Reads only.
 */
export async function readDeclined(tx: Tx, profileIds: readonly string[]): Promise<Map<string, number>> {
  const ids = [...new Set(profileIds.map(authorIdentity))];
  if (ids.length === 0) return new Map();
  const verdict = sql`${conversationEvents.reading} -> 'verdict'`;
  const rows = await tx
    .select({
      profileId: conversations.authorProfileId,
      // The newest no, where no message after it reopens the question.
      at: sql<number | null>`max(${conversationEvents.occurredAt}) filter (where ${verdict} ->> 'stance' = 'negative' and coalesce((${verdict} ->> 'opt_out')::boolean, false) = false and coalesce((${verdict} ->> 'uncertain')::boolean, false) = false)::float8`,
      reopenedAt: sql<number | null>`max(${conversationEvents.occurredAt}) filter (where coalesce((${verdict} ->> 'interest')::boolean, false) or coalesce(${verdict} ->> 'lead_intent', 'none') <> 'none')::float8`,
    })
    .from(conversationEvents)
    .innerJoin(conversations, sql`${conversations.id} = ${conversationEvents.conversationId} and ${conversations.organizationId} = ${conversationEvents.organizationId}`)
    .where(sql`${conversationEvents.type} = 'inbound_message_observed' and ${conversationEvents.reading} is not null and ${inArray(conversations.authorProfileId, ids)}`)
    .groupBy(conversations.authorProfileId);
  return new Map(
    rows.flatMap((row) =>
      row.at !== null && (row.reopenedAt === null || row.reopenedAt < row.at) ? [[authorIdentity(row.profileId), Number(row.at)] as const] : [],
    ),
  );
}
