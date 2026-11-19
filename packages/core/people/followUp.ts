import { sql } from "drizzle-orm";
import type { ConversationRelationship } from "@engager/database/schema";
import type { Tx } from "@engager/database/tenant";
import { postExcerpt, truncateChars } from "../operations/postSnippets";

/**
 * WHAT ALREADY PASSED BETWEEN THE ACCOUNT AND SOMEONE — the history a comment
 * on their next post is written with, so the writer follows up instead of
 * introducing the owner a second time.
 *
 * Someone has history once a comment or reply of ours to them went out, or
 * they replied to us: under our comment, or on the owner's own post. With
 * none there is no follow-up, and the comment is a first touch written
 * exactly as before.
 *
 * Reads only, inside the caller's `withOrg`; every table read is under RLS.
 */

export type FollowUp = {
  /** Our comments and replies to them that went out, newest first: the
   *  post a comment was on, by its opening words. */
  ours: Array<{ kind: "comment" | "reply" | "room_reply"; at: number; text: string; post: string | null }>;
  /** Their replies to us, newest first. */
  theirs: Array<{ at: number; text: string }>;
  /** How many of each passed, beyond the few quoted. */
  counts: { ours: number; theirs: number };
  /** Where the connection stands, as their open conversation last read it:
   *  connected, our invite sent and not answered, or theirs to us. Null where
   *  no read placed it. */
  relationship: Extract<ConversationRelationship, "connected" | "outgoing_pending" | "incoming_pending"> | null;
};

/** How many of each the writer is shown: enough to know what was said, not a
 *  transcript. */
const QUOTED = { ours: 2, theirs: 2 } as const;
const TEXT_LIMIT = 400;
const POST_LIMIT = 120;

type OurRow = { kind: FollowUp["ours"][number]["kind"]; at: number; text: string; post: string | null; total: number };
type TheirRow = { at: number; text: string; total: number };

export async function readFollowUp(tx: Tx, profileId: string): Promise<FollowUp | null> {
  const ours = (
    await tx.execute(sql`
      select m.kind, m.posted_at::float8 as at, coalesce(m.final_text, m.proposed_text) as text,
        case when m.kind = 'comment' then post.content_text end as post,
        (count(*) over ())::int as total
      from messages m
      left join discovered_posts post on post.id = m.discovered_post_id
      left join incoming_comments reply on reply.id = m.incoming_comment_id
      where m.status = 'posted'
        and coalesce(nullif(reply.author_profile_id, ''), nullif(post.author_profile_id, ''), m.target_profile_id)
          = ${profileId}
      order by m.posted_at desc nulls last, m.id desc
      limit ${QUOTED.ours}`)
  ).rows as OurRow[];
  const theirs = (
    await tx.execute(sql`
      select reply.received_at::float8 as at, reply.text, (count(*) over ())::int as total
      from incoming_comments reply
      where reply.author_profile_id = ${profileId} and reply.removed_at is null
      order by reply.received_at desc, reply.id desc
      limit ${QUOTED.theirs}`)
  ).rows as TheirRow[];
  if (ours.length === 0 && theirs.length === 0) return null;
  const [conversation] = (
    await tx.execute(sql`
      select conversation.relationship
      from conversations conversation
      where conversation.author_profile_id = ${profileId} and conversation.closed_reason is null
      order by conversation.id desc
      limit 1`)
  ).rows as Array<{ relationship: ConversationRelationship }>;
  const relationship = conversation?.relationship;
  return {
    ours: ours.map((row) => ({
      kind: row.kind,
      at: row.at,
      text: truncateChars(row.text, TEXT_LIMIT),
      post: postExcerpt(row.post, POST_LIMIT),
    })),
    theirs: theirs.map((row) => ({ at: row.at, text: truncateChars(row.text, TEXT_LIMIT) })),
    counts: { ours: ours[0]?.total ?? 0, theirs: theirs[0]?.total ?? 0 },
    relationship:
      relationship === "connected" || relationship === "outgoing_pending" || relationship === "incoming_pending"
        ? relationship
        : null,
  };
}
