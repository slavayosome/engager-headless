import { and, desc, eq, isNull, ne, notExists, sql } from "drizzle-orm";
import { campaigns, incomingComments, conversationSources, messages } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";

/**
 * THE REPLIES HELD FOR THE OWNER — what people wrote under the owner's
 * comments and posts that intake held for them (`sensitivity = 'hold'`) and
 * nothing has answered yet: the backfill of older replies, a campaign's that
 * does not run on its strategy, a reply a notification card showed that no
 * read has confirmed. Inbox → People lists them beside the drafts waiting for
 * a yes, so each is only here while no reply of ours is on it: a draft
 * waiting, a send queued, gone or in trouble is listed where it is, and one
 * the owner rejected leaves the reply theirs again. Reads only.
 */

export type HeldReply = {
  /** The `incoming_comments` row. */
  id: number;
  name: string | null;
  /** Their words, verbatim: untrusted data. */
  text: string;
  receivedAt: number;
  campaign: { id: number; name: string } | null;
  /** The conversation the reply joined, where its campaign keeps one: its
   *  conversation's page. */
  conversationId: number | null;
};

/** Newest first. */
export async function heldReplies(tx: Tx, limit = 50): Promise<HeldReply[]> {
  const ours = tx
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.incomingCommentId, incomingComments.id), ne(messages.status, "rejected")));
  const conversationId = sql<number | null>`(
    select ${conversationSources.conversationId} from ${conversationSources}
    where ${conversationSources.incomingCommentId} = ${incomingComments.id}
    order by ${conversationSources.id} desc limit 1
  )`.mapWith(Number);
  const rows = await tx
    .select({
      id: incomingComments.id,
      name: incomingComments.authorName,
      text: incomingComments.text,
      receivedAt: incomingComments.receivedAt,
      campaignId: campaigns.id,
      campaignName: campaigns.name,
      conversationId,
    })
    .from(incomingComments)
    .leftJoin(campaigns, eq(campaigns.id, incomingComments.campaignId))
    .where(
      and(
        isNull(incomingComments.removedAt),
        eq(incomingComments.status, "new"),
        eq(incomingComments.sensitivity, "hold"),
        notExists(ours),
      ),
    )
    .orderBy(desc(incomingComments.receivedAt), desc(incomingComments.id))
    .limit(limit);
  return rows.map(({ campaignId, campaignName, ...row }) => ({
    ...row,
    campaign: campaignId === null || campaignName === null ? null : { id: campaignId, name: campaignName },
  }));
}
