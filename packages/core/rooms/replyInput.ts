import type { Message } from "@engager/database/schema";
import type { RoomReplyInput } from "../linkedin/driver";

/** Target and words are frozen on the message. A new journal generation is
 * possible only after the previous attempt was proved absent. The account's
 * parent-comment dedupe key stays unchanged across those generations. */
export function roomReplyInput(message: Message, channelId: number): RoomReplyInput {
  const target = message.roomReplyTarget;
  if (message.kind !== "room_reply" || !target) throw new Error("Room reply target is missing.");
  return {
    kind: "room_reply", organizationId: message.organizationId, channelId,
    expectedAccountProfileId: target.accountProfileId, postUrn: target.postUrn,
    commentId: target.parentCommentUrn, expectedAuthorMemberUrn: target.memberUrn,
    text: message.finalText ?? message.proposedText,
    marker: `${message.dedupeKey}:${message.redraftRequestVersion}`,
  };
}
