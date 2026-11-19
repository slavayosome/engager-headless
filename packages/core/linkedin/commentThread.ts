import type { CommentRepliesRead } from "./driver";

/**
 * What one read of the replies under a comment of ours can say, said once for
 * every reader: the thread watch that records them (`replyWatches.ts`) and the
 * dispatch gate that checks a reply is still there before a like
 * (`actions/likeTarget.ts`).
 */

/** The trailing, globally-unique id of a comment urn, whichever inner post
 *  spelling LinkedIn minted it in (activity and ugcPost ids are independent).
 *  A value that is not a comment urn passes through unchanged. */
export function commentId(urn: string): string {
  const match = /,([A-Za-z0-9_-]+)\)$/.exec(urn) ?? /^urn:li:comment:([A-Za-z0-9_-]+)$/.exec(urn);
  return match?.[1] ?? urn;
}

/** LinkedIn's numeric comment ids are time ordered. An unfamiliar id proves
 * no ordering, even when a page happens to render it after another row. */
export function commentAfter(urn: string, earlierUrn: string): boolean {
  const id = commentId(urn);
  const earlier = commentId(earlierUrn);
  return /^\d+$/.test(id) && /^\d+$/.test(earlier) && BigInt(id) > BigInt(earlier);
}

/**
 * Whether a reply this read does not show is gone. Only when the read is
 * whole — nothing cut by `limit` — AND LinkedIn's own reply count equals the
 * rows the connector recognised: replies in a shape no rule knows read as no
 * rows at all, and "no count, no rows" is exactly what that looks like. Our
 * comment going is the other tombstone, and needs no count.
 */
export function provesDeletions(
  comment: Extract<CommentRepliesRead["comment"], { present: true }>,
  truncated: boolean,
): boolean {
  return (
    !truncated &&
    comment.replyCount !== null &&
    comment.replyCount === comment.replyRows
  );
}
