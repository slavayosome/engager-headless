import { eq } from "drizzle-orm";
import { campaigns, channels, incomingComments, messages, type Message } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { commentAfter, commentId } from "../linkedin/commentThread";

type Incoming = typeof incomingComments.$inferSelect;

type ThreadOrigin = { kind: "ordinary" } | { kind: "unverified" } | { kind: "room"; message: Message; verified: boolean };

/** Follow stored parent identities, including later answers in the same room.
 * Missing or cyclic lineage must not turn a room into an ordinary thread. */
async function threadOrigin(tx: Tx, incoming: Incoming): Promise<ThreadOrigin> {
  if (incoming.source !== "our_comment_thread" || incoming.parentMessageId === null) return { kind: "ordinary" };
  const visited = new Set<number>();
  let current = incoming;
  let verified = true;
  while (current.parentMessageId !== null && visited.size < 50) {
    if (visited.has(current.parentMessageId)) return { kind: "unverified" };
    visited.add(current.parentMessageId);
    const [parent] = await tx.select().from(messages).where(eq(messages.id, current.parentMessageId));
    if (!parent || parent.organizationId !== incoming.organizationId || parent.campaignId !== incoming.campaignId) return { kind: "unverified" };
    if (parent.kind === "comment") return { kind: "ordinary" };
    verified &&= parent.status === "posted" && !!parent.externalUrn && commentAfter(current.commentUrn, parent.externalUrn);
    if (parent.kind === "room_reply") {
      const target = parent.roomReplyTarget;
      // A reply under a lead's comment has no post row, so neither do the answers to it.
      verified &&= !!target && (target.source === "lead" ? incoming.discoveredPostId === null
        : target.discoveredPostId === incoming.discoveredPostId) &&
        target.postUrn === incoming.ownPostUrn && !!incoming.threadParentUrn &&
        commentId(target.parentCommentUrn) === commentId(incoming.threadParentUrn);
      return { kind: "room", message: parent, verified };
    }
    if (parent.kind !== "reply" || parent.incomingCommentId === null) return { kind: "unverified" };
    const [previous] = await tx.select().from(incomingComments).where(eq(incomingComments.id, parent.incomingCommentId));
    if (!previous || previous.organizationId !== incoming.organizationId || previous.source !== "our_comment_thread" ||
        previous.campaignId !== incoming.campaignId || previous.discoveredPostId !== incoming.discoveredPostId ||
        previous.ownPostUrn !== incoming.ownPostUrn || previous.threadParentUrn !== incoming.threadParentUrn) return { kind: "unverified" };
    current = previous;
  }
  return { kind: "unverified" };
}

/** Room restrictions survive receipt loss and continuation replies. */
export async function isRoomThreadReply(tx: Tx, incoming: Incoming): Promise<boolean> {
  return (await threadOrigin(tx, incoming)).kind !== "ordinary";
}

/** Receipt evidence for continuing a room conversation. The sidecar also
 * checks this exact reply is still ours and directly under the root. */
export async function roomThreadReceipt(tx: Tx, incoming: Incoming): Promise<string | null> {
  const origin = await threadOrigin(tx, incoming);
  if (origin.kind !== "room" || !origin.verified) return null;
  const [account] = await tx.select({ externalId: channels.externalAccountId, executionId: channels.executionAccountId })
    .from(campaigns).innerJoin(channels, eq(channels.id, campaigns.channelId))
    .where(eq(campaigns.id, incoming.campaignId!));
  const expected = origin.message.roomReplyTarget?.accountProfileId;
  if (!account || !expected || account.externalId !== expected ||
      (account.executionId !== null && account.executionId !== expected)) return null;
  return origin.message.externalUrn;
}
