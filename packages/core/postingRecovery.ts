import { eq } from "drizzle-orm";
import { discoveredPosts, incomingComments, type Message } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import type { PostInput } from "./linkedin/driver";
import { isMentionableProfileId } from "./linkedin/mention";
import { ledgerChannelId } from "./ratelimit/ledger";
import { roomReplyInput } from "./rooms/replyInput";
import { isRoomThreadReply, roomThreadReceipt } from "./rooms/thread";

export const attemptMarker = (key: string, version: number) => version === 0 ? key : `${key}:v${version}`;
export const savedAttemptMarker = (message: Message) => message.writeMarker ?? message.dedupeKey;

/** Freeze the uncertain attempt before the owner can edit or approve it again. */
export async function recoveryInput(tx: Tx, message: Message): Promise<PostInput> {
  const marker = savedAttemptMarker(message), text = message.finalText ?? message.proposedText;
  if (message.kind === "room_reply") {
    const channelId = await ledgerChannelId(tx, message.campaignId);
    if (channelId != null && message.roomReplyTarget) return roomReplyInput(message, channelId);
  }
  if (message.kind === "comment" && message.discoveredPostId != null) {
    const [post] = await tx.select().from(discoveredPosts).where(eq(discoveredPosts.id, message.discoveredPostId));
    if (post) return { kind: "comment", postUrn: post.postUrn, text, marker };
  }
  if (message.kind === "reply" && message.incomingCommentId != null) {
    const [incoming] = await tx.select().from(incomingComments).where(eq(incomingComments.id, message.incomingCommentId));
    if (incoming) {
      const isRoom = await isRoomThreadReply(tx, incoming);
      const room = isRoom ? await roomThreadReceipt(tx, incoming) : null;
      if (isRoom && !room) throw new Error("The uncertain reply's room receipt is unavailable.");
      const mention = incoming.authorProfileId && incoming.authorName && isMentionableProfileId(incoming.authorProfileId)
        ? { profileId: incoming.authorProfileId, name: incoming.authorName } : undefined;
      return { kind: "reply", postUrn: incoming.ownPostUrn,
        commentId: incoming.source === "our_comment_thread" ? incoming.threadParentUrn ?? incoming.commentUrn : incoming.commentUrn,
        replyToUrn: incoming.commentUrn, ...(room ? { rootIsRoomReply: { replyUrn: room } } : {}),
        ...(mention ? { mention } : {}), text, marker };
    }
  }
  throw new Error("The uncertain write's target is no longer available for reconciliation.");
}
