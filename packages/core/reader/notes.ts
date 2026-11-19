import type { ReaderMiss } from "./read";
import { droppedCount, type Dropped, type VerifiedReplies } from "./verify";

/**
 * What an agent read says in a run note — always naming the agent reader, so
 * a row the owner sees can be told from the parser's. Run-note strings only:
 * no surface of their own.
 */

const AGENT = "(agent reader)";

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function droppedNote(dropped: Dropped): string | null {
  const count = droppedCount(dropped);
  return count > 0 ? `dropped ${plural(count, "row", "rows")} it could not verify on the page` : null;
}

function missNote(miss: ReaderMiss): string {
  return miss.status === "malformed"
    ? `the model's answer was malformed; nothing recorded ${AGENT}`
    : `the model could not read the page (${miss.reason.slice(0, 160)}); nothing recorded ${AGENT}`;
}

const UNVERIFIED: Record<Extract<VerifiedReplies, { status: "unverified" }>["reason"], string> = {
  comment_not_on_page: `your comment was not on the page it read; nothing recorded ${AGENT}`,
  comment_mismatch: `the model's answer did not match your comment on the page; nothing recorded ${AGENT}`,
  not_our_comment: `the comment on the page is not linked from your profile; nothing recorded ${AGENT}`,
};

/** The note for one agent read of the thread under our comment, `recorded`
 *  of its replies new rows. */
export function replyReadNote(result: VerifiedReplies | ReaderMiss, recorded: number): string {
  if (result.status === "malformed" || result.status === "failed") return missNote(result);
  if (result.status === "unverified") return UNVERIFIED[result.reason];
  const seen = result.replies.length;
  const head =
    seen === 0
      ? "no replies on your comment"
      : recorded === seen
        ? `read ${plural(seen, "reply", "replies")} on your comment`
        : `read ${plural(seen, "reply", "replies")} on your comment, ${recorded > 0 ? `${recorded} new` : "none new"}`;
  const counts = [
    result.reactionCount ? plural(result.reactionCount, "reaction", "reactions") : null,
    result.replyCount !== null && result.replyCount > seen
      ? `LinkedIn counts ${plural(result.replyCount, "reply", "replies")}, ${result.replyCount - seen} not read`
      : null,
  ].filter((part): part is string => part !== null);
  const dropped = droppedNote(result.dropped);
  return `${[head, ...counts].join(", ")} ${AGENT}${dropped ? `; ${dropped}` : ""}`;
}

/** The note for an inbox read the agent reader made: `listed` conversations
 *  it could name. */
export function inboxReadNote(result: { listed: number; dropped: Dropped } | ReaderMiss): string {
  if ("status" in result) return `inbox: ${missNote(result)}`;
  const dropped = droppedNote(result.dropped);
  return `inbox read ${plural(result.listed, "conversation", "conversations")} ${AGENT}${dropped ? `; ${dropped}` : ""}`;
}
